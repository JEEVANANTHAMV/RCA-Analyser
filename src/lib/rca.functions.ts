import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { getDb, generateId } from "@/lib/database";
import { getAgentApiBase, AGENT_BY_KEY, type AgentKey } from "@/lib/agents";

const AGENT_KEYS = [
  "data_collector",
  "five_why",
  "fishbone",
  "fault_tree",
  "pareto",
  "timeline",
  "equipment",
  "report",
] as const;

interface ConversationRow {
  id: string;
  user_id: string;
  agent_key: string;
  session_id: string;
  title: string | null;
  incident_context: string | null;
  rca_case_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  raw_response: string | null;
  attachments: string | null;
  created_at: string;
}

interface CaseRow {
  id: string;
  user_id: string;
  title: string;
  asset_id: string | null;
  status: string;
  incident_data: string | null;
  final_report: string | null;
  created_at: string;
  updated_at: string;
}

export const sendAgentMessage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        conversationId: z.string(),
        message: z.string().min(1).max(50_000),
        attachments: z.array(z.object({
          filename: z.string(),
          contentType: z.string(),
          data: z.string(),
        })).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();

    const convo = db.prepare("SELECT id, user_id, agent_key, session_id FROM conversations WHERE id = ?")
      .get(data.conversationId) as Pick<ConversationRow, "id" | "user_id" | "agent_key" | "session_id"> | undefined;
    if (!convo) throw new Error("Conversation not found");
    if (convo.user_id !== userId) throw new Error("Forbidden");

    const agent = AGENT_BY_KEY[convo.agent_key as AgentKey];
    if (!agent) throw new Error("Unknown agent");

    const msgId = generateId();
    const attachJson = data.attachments ? JSON.stringify(data.attachments) : null;
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments) VALUES (?, ?, 'user', ?, ?)")
      .run(msgId, data.conversationId, data.message, attachJson);

    let requestBody: Record<string, unknown> = {
      question: data.message,
      overrideConfig: { sessionId: convo.session_id },
      streaming: true,
    };

    if (data.attachments && data.attachments.length > 0) {
      (requestBody as any).images = data.attachments.map((a) => ({
        data: `data:${a.contentType};base64,${a.data}`,
        filename: a.filename,
      }));
    }

    const res = await fetch(`${getAgentApiBase()}/${agent.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(180000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Agent ${agent.shortName} failed: ${res.status} ${errText.slice(0, 200)}`);
    }

    // Try SSE streaming first
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`Agent ${agent.shortName} returned no body`);

    const decoder = new TextDecoder();
    let fullText = "";
    let fullRaw = "";
    let hasTokens = false;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullRaw += chunk;
      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payload);
            if (parsed.event === "token" && typeof parsed.data === "string") {
              fullText += parsed.data;
              hasTokens = true;
            } else if (parsed.event === "on_chat_model_stream" && parsed.data?.content) {
              fullText += parsed.data.content;
              hasTokens = true;
            } else if (parsed.event === "metadata" && parsed.data?.text) {
              fullText = parsed.data.text;
              hasTokens = true;
            }
          } catch {}
        }
      }
    }

    // If streaming didn't give us tokens, parse fullRaw as JSON (non-streaming fallback)
    if (!hasTokens && fullRaw) {
      try {
        const completeJson = JSON.parse(fullRaw);
        fullText = completeJson.text || completeJson.answer || completeJson.output || JSON.stringify(completeJson);
      } catch {
        // fullRaw may be an incomplete JSON response
      }
    }

    let assistantText = fullText || "";
    let parsedResponse: Record<string, any> = {};

    try {
      parsedResponse = JSON.parse(assistantText);
      assistantText = JSON.stringify(parsedResponse, null, 2);
    } catch {
      parsedResponse = { text: assistantText };
    }

    const assistantMsgId = generateId();
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)")
      .run(assistantMsgId, data.conversationId, assistantText, JSON.stringify(parsedResponse));

    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(data.conversationId);

    return {
      message: {
        id: assistantMsgId,
        role: "assistant" as const,
        content: assistantText,
        raw_response: parsedResponse,
      },
    };
  });

export const createRcaCase = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        title: z.string().min(1).max(200),
        assetId: z.string().max(100).optional().nullable(),
        incidentData: z.unknown().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();
    const id = generateId();
    const incidentData = data.incidentData ? JSON.stringify(data.incidentData) : null;
    db.prepare("INSERT INTO rca_cases (id, user_id, title, asset_id, incident_data) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, data.title, data.assetId ?? null, incidentData);
    const row = db.prepare("SELECT * FROM rca_cases WHERE id = ?").get(id) as CaseRow;
    return { case: row };
  });

export const ensureConversation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        caseId: z.string(),
        agentKey: z.enum(AGENT_KEYS),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();
    const existing = db.prepare(
      "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?"
    ).get(data.caseId, data.agentKey, userId) as ConversationRow | undefined;
    if (existing) return { conversation: existing };

    const agent = AGENT_BY_KEY[data.agentKey];
    const id = generateId();
    const sessionId = generateId().replace(/-/g, "").slice(0, 16);
    db.prepare(
      "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, userId, data.agentKey, sessionId, data.caseId, agent.name);
    const created = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow;
    return { conversation: created };
  });

export const getCaseFull = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const db = getDb();
    const rcaCase = db.prepare("SELECT * FROM rca_cases WHERE id = ?").get(data.caseId) as CaseRow | undefined;
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");

    const conversations = db.prepare("SELECT * FROM conversations WHERE rca_case_id = ? ORDER BY created_at")
      .all(data.caseId) as ConversationRow[];
    return { case: rcaCase, conversations };
  });

export const getConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z.object({ conversationId: z.string() }).parse(input),
  )
  .handler(async ({ data }) => {
    const db = getDb();
    const messages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at")
      .all(data.conversationId) as MessageRow[];
    return { messages };
  });

export const listMyCases = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const db = getDb();
    const cases = db.prepare("SELECT * FROM rca_cases WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as CaseRow[];
    return { cases };
  });

export const deleteCase = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();
    const existing = db.prepare("SELECT user_id FROM rca_cases WHERE id = ?").get(data.caseId) as { user_id: string } | undefined;
    if (!existing) throw new Error("Case not found");
    if (existing.user_id !== userId) throw new Error("Forbidden");
    db.prepare("DELETE FROM rca_cases WHERE id = ?").run(data.caseId);
    return { ok: true };
  });

export const saveFinalReport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        caseId: z.string(),
        report: z.unknown(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const db = getDb();
    db.prepare("UPDATE rca_cases SET final_report = ?, status = 'completed' WHERE id = ?")
      .run(JSON.stringify(data.report), data.caseId);
    const row = db.prepare("SELECT * FROM rca_cases WHERE id = ?").get(data.caseId) as CaseRow;
    return { case: row };
  });
