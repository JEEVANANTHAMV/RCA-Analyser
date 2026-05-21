import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { getDb, generateId } from "@/lib/database";
import { getAgentApiBase, AGENT_BY_KEY, type AgentKey } from "@/lib/agents";
import fs from "fs";
import path from "path";

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
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              contentType: z.string(),
              data: z.string(),
            }),
          )
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();

    const convo = db
      .prepare("SELECT id, user_id, agent_key, session_id FROM conversations WHERE id = ?")
      .get(data.conversationId) as
      | Pick<ConversationRow, "id" | "user_id" | "agent_key" | "session_id">
      | undefined;
    if (!convo) throw new Error("Conversation not found");
    if (convo.user_id !== userId) throw new Error("Forbidden");

    const agent = AGENT_BY_KEY[convo.agent_key as AgentKey];
    if (!agent) throw new Error("Unknown agent");

    const msgId = generateId();
    const attachJson = data.attachments ? JSON.stringify(data.attachments) : null;
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, attachments) VALUES (?, ?, 'user', ?, ?)",
    ).run(msgId, data.conversationId, data.message, attachJson);

    const requestBody: Record<string, unknown> = {
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
        fullText =
          completeJson.text ||
          completeJson.answer ||
          completeJson.output ||
          JSON.stringify(completeJson);
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
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
    ).run(assistantMsgId, data.conversationId, assistantText, JSON.stringify(parsedResponse));

    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
      data.conversationId,
    );

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
        description: z.string().optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              contentType: z.string(),
              data: z.string(),
            })
          )
          .optional(),
        preAnalyzedData: z
          .object({
            problemStatement: z.string(),
            effect: z.string(),
            gaps: z.array(z.string()),
            followUps: z.array(z.string()),
          })
          .optional()
          .nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();
    const id = generateId();

    const savedAttachments: { filename: string; contentType: string; url: string }[] = [];
    if (data.attachments && Array.isArray(data.attachments)) {
      const uploadDir = path.join(process.cwd(), "public", "uploads");
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      for (const att of data.attachments) {
        const ext = att.contentType.split("/")[1] || "png";
        const fileId = generateId();
        const fileName = `${fileId}.${ext}`;
        const filePath = path.join(uploadDir, fileName);
        const buffer = Buffer.from(att.data, "base64");
        fs.writeFileSync(filePath, buffer);
        savedAttachments.push({
          filename: att.filename,
          contentType: att.contentType,
          url: `/uploads/${fileName}`,
        });
      }
    }

    const incidentDataObj = {
      description: data.description || "",
      attachments: savedAttachments,
    };

    db.prepare(
      "INSERT INTO rca_cases (id, user_id, title, asset_id, incident_data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, userId, data.title, data.assetId ?? null, JSON.stringify(incidentDataObj));

    if (data.preAnalyzedData) {
      // 1. Create data_collector conversation
      const convoId = generateId();
      const sessionId = generateId().replace(/-/g, "").slice(0, 16);
      db.prepare(
        "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, 'data_collector', ?, ?, 'Data Collector & Validator')",
      ).run(convoId, userId, sessionId, id);

      // 2. Insert user message
      const userMsgId = generateId();
      db.prepare(
        "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
      ).run(userMsgId, convoId, `[Auto-Pipeline Hypothesis Generation Request]`);

      // 3. Insert assistant message with the pre-analyzed and approved details
      const assistantMsgId = generateId();
      const content = JSON.stringify(data.preAnalyzedData, null, 2);
      db.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
      ).run(assistantMsgId, convoId, content, content);
    }
    
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
    const existing = db
      .prepare(
        "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
      )
      .get(data.caseId, data.agentKey, userId) as ConversationRow | undefined;
    if (existing) return { conversation: existing };

    const agent = AGENT_BY_KEY[data.agentKey];
    const id = generateId();
    const sessionId = generateId().replace(/-/g, "").slice(0, 16);
    db.prepare(
      "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, userId, data.agentKey, sessionId, data.caseId, agent.name);
    const created = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow;
    return { conversation: created };
  });

export const getCaseFull = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const db = getDb();
    const rcaCase = db.prepare("SELECT * FROM rca_cases WHERE id = ?").get(data.caseId) as
      | CaseRow
      | undefined;
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");

    const conversations = db
      .prepare("SELECT * FROM conversations WHERE rca_case_id = ? ORDER BY created_at")
      .all(data.caseId) as ConversationRow[];
    return { case: rcaCase, conversations };
  });

export const getConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ conversationId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const db = getDb();
    const messages = db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at")
      .all(data.conversationId) as MessageRow[];
    return { messages };
  });

export const listMyCases = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const db = getDb();
    const cases = db
      .prepare("SELECT * FROM rca_cases WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as CaseRow[];
    return { cases };
  });

export const deleteCase = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();
    const existing = db.prepare("SELECT user_id FROM rca_cases WHERE id = ?").get(data.caseId) as
      | { user_id: string }
      | undefined;
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
    db.prepare("UPDATE rca_cases SET final_report = ?, status = 'completed' WHERE id = ?").run(
      JSON.stringify(data.report),
      data.caseId,
    );
    const row = db.prepare("SELECT * FROM rca_cases WHERE id = ?").get(data.caseId) as CaseRow;
    return { case: row };
  });

export const generateAgentHypothesis = createServerFn({ method: "POST" })
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

    // 1. Ensure conversation exists
    const convoRes = db
      .prepare(
        "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
      )
      .get(data.caseId, data.agentKey, userId) as ConversationRow | undefined;

    let convo: ConversationRow;
    if (convoRes) {
      convo = convoRes;
    } else {
      const agent = AGENT_BY_KEY[data.agentKey];
      const id = generateId();
      const sessionId = generateId().replace(/-/g, "").slice(0, 16);
      db.prepare(
        "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, userId, data.agentKey, sessionId, data.caseId, agent.name);
      convo = db
        .prepare("SELECT * FROM conversations WHERE id = ?")
        .get(id) as ConversationRow;
    }

    const agent = AGENT_BY_KEY[data.agentKey as AgentKey];
    if (!agent) throw new Error("Unknown agent");

    // 2. Gather context from previous agents' assistant responses or case incident data
    const currentIdx = AGENT_KEYS.indexOf(data.agentKey);
    let prompt = "";

    if (currentIdx === 0) {
      // First agent: Data Collector. Get incident details from case row.
      const rcaCase = db
        .prepare("SELECT title, incident_data, asset_id FROM rca_cases WHERE id = ?")
        .get(data.caseId) as CaseRow | undefined;
      if (!rcaCase) throw new Error("Case not found");

      let initialDesc = "";
      let initialAttachments = "";
      if (rcaCase.incident_data) {
        try {
          const parsedData = JSON.parse(rcaCase.incident_data);
          initialDesc = parsedData.description || "";
          if (Array.isArray(parsedData.attachments)) {
            initialAttachments = parsedData.attachments.map((a: any) => `${a.filename} (${a.url})`).join(", ");
          }
        } catch {
          initialDesc = rcaCase.incident_data;
        }
      }

      prompt = `Incident Title: ${rcaCase.title}\n`;
      if (rcaCase.asset_id) {
        prompt += `Asset Identifier: ${rcaCase.asset_id}\n`;
      }
      if (initialDesc) {
        prompt += `Incident Description: ${initialDesc}\n`;
      }
      if (initialAttachments) {
        prompt += `Incident Initial Photos/Attachments: ${initialAttachments}\n`;
      }
      prompt += `\nPlease analyze this incident data, validate the details, construct a concise problem statement, and identify any gaps in the available information. Output your response as a structured analysis.`;
    } else {
      // Subsequent agents: gather previous agents' outputs
      prompt = `You are an expert industrial reliability engineer performing a Root Cause Analysis (RCA) step. Your step is: ${agent.name} (${agent.description}).\n\n`;
      prompt += `Please analyze the findings and outputs from the preceding steps in the RCA pipeline:\n\n`;

      for (let i = 0; i < currentIdx; i++) {
        const prevKey = AGENT_KEYS[i];
        const prevAgent = AGENT_BY_KEY[prevKey];
        const prevConvo = db
          .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ?")
          .get(data.caseId, prevKey) as { id: string } | undefined;
        if (prevConvo) {
          const latestAssistantMsg = db
            .prepare(
              "SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
            )
            .get(prevConvo.id) as { content: string } | undefined;
          if (latestAssistantMsg) {
            prompt += `=== Preceding Step Findings: ${prevAgent.name} ===\n${latestAssistantMsg.content}\n\n`;
          }
        }
      }

      prompt += `Using the preceding findings above, perform your analysis for ${agent.name}. Generate your hypothesis, findings, and structured diagrams/data.`;
    }

    // 3. Store system-pipeline user message in messages
    const msgId = generateId();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
    ).run(msgId, convo.id, `[Auto-Pipeline Hypothesis Generation Request]`);

    // 4. Send request to agent API
    const requestBody = {
      question: prompt,
      overrideConfig: { sessionId: convo.session_id },
      streaming: true,
    };

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

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`Agent ${agent.shortName} returned no body`);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        let fullText = "";
        let fullRaw = "";
        let buffer = "";
        let hasTokens = false;

        try {
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
                  let token = "";
                  if (parsed.event === "token" && typeof parsed.data === "string") {
                    token = parsed.data;
                    hasTokens = true;
                  } else if (parsed.event === "on_chat_model_stream" && parsed.data?.content) {
                    token = parsed.data.content;
                    hasTokens = true;
                  } else if (parsed.event === "metadata" && parsed.data?.text) {
                    token = parsed.data.text;
                    hasTokens = true;
                  }

                  if (token) {
                    fullText += token;
                    controller.enqueue(encoder.encode(token));
                  }
                } catch {}
              }
            }
          }

          // If streaming didn't give us tokens, fallback
          if (!hasTokens && fullRaw) {
            try {
              const completeJson = JSON.parse(fullRaw);
              const fallbackText =
                completeJson.text ||
                completeJson.answer ||
                completeJson.output ||
                JSON.stringify(completeJson);
              fullText = fallbackText;
              controller.enqueue(encoder.encode(fallbackText));
            } catch {}
          }

          // Save final response in DB
          let parsedResponse: Record<string, any> = {};
          let assistantText = fullText || "";
          try {
            parsedResponse = JSON.parse(assistantText);
            assistantText = JSON.stringify(parsedResponse, null, 2);
          } catch {
            parsedResponse = { text: assistantText };
          }

          const assistantMsgId = generateId();
          db.prepare(
            "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
          ).run(assistantMsgId, convo.id, assistantText, JSON.stringify(parsedResponse));

          db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
            convo.id,
          );
        } catch (err: any) {
          controller.error(err);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  });

export const updateCaseIncidentData = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        caseId: z.string(),
        problemStatement: z.string(),
        effect: z.string().optional(),
        gaps: z.array(z.string()).optional(),
        followUps: z.array(z.string()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();

    // 1. Fetch case to ensure it exists
    const rcaCase = db.prepare("SELECT * FROM rca_cases WHERE id = ?").get(data.caseId) as CaseRow | undefined;
    if (!rcaCase) throw new Error("Case not found");

    // 2. Parse current incident_data to keep attachments
    let attachments: any[] = [];
    if (rcaCase.incident_data) {
      try {
        const parsed = JSON.parse(rcaCase.incident_data);
        attachments = parsed.attachments || [];
      } catch {}
    }

    const updatedIncidentObj = {
      description: data.problemStatement,
      attachments,
    };

    // 3. Update the case record
    db.prepare("UPDATE rca_cases SET incident_data = ? WHERE id = ?").run(
      JSON.stringify(updatedIncidentObj),
      data.caseId,
    );

    // 4. Update the latest assistant message of data_collector to feed subsequent steps
    const collectorConvo = db
      .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'")
      .get(data.caseId) as { id: string } | undefined;

    const newContentObj = {
      problemStatement: data.problemStatement,
      effect: data.effect || "",
      gaps: data.gaps || [],
      followUps: data.followUps || [],
    };

    const newContentStr = JSON.stringify(newContentObj, null, 2);

    if (collectorConvo) {
      // Find latest assistant message
      const latestMsg = db
        .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1")
        .get(collectorConvo.id) as { id: string } | undefined;

      if (latestMsg) {
        db.prepare("UPDATE messages SET content = ?, raw_response = ? WHERE id = ?").run(
          newContentStr,
          JSON.stringify(newContentObj),
          latestMsg.id
        );
      } else {
        // Create one if it didn't exist
        const msgId = generateId();
        db.prepare(
          "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)"
        ).run(msgId, collectorConvo.id, newContentStr, JSON.stringify(newContentObj));
      }
    } else {
      // Create conversation and message
      const convoId = generateId();
      const sessionId = generateId().replace(/-/g, "").slice(0, 16);
      db.prepare(
        "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, 'data_collector', ?, ?, 'Data Collector & Validator')"
      ).run(convoId, userId, sessionId, data.caseId);

      const msgId = generateId();
      db.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)"
      ).run(msgId, convoId, newContentStr, JSON.stringify(newContentObj));
    }

    return { ok: true };
  });

export const preAnalyzeIncident = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        title: z.string().min(1).max(200),
        assetId: z.string().max(100).optional().nullable(),
        description: z.string().optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              contentType: z.string(),
              data: z.string(),
            })
          )
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let prompt = `Incident Title: ${data.title}\n`;
    if (data.assetId) {
      prompt += `Asset Identifier: ${data.assetId}\n`;
    }
    if (data.description) {
      prompt += `Incident Description: ${data.description}\n`;
    }
    if (data.attachments && data.attachments.length > 0) {
      prompt += `Incident Initial Photos/Attachments: ${data.attachments.map((a) => a.filename).join(", ")}\n`;
    }
    prompt += `\nPlease analyze this incident data, validate the details, construct a concise problem statement, and identify any gaps in the available information. Output your response as a structured analysis.`;

    const requestBody = {
      question: prompt,
      streaming: true,
    };

    const res = await fetch(`${getAgentApiBase()}/data_collector`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(180000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Data Collector pre-analysis failed: ${res.status} ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("Pre-analysis returned no body");

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        let fullText = "";
        let fullRaw = "";
        let buffer = "";
        let hasTokens = false;

        try {
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
                  let token = "";
                  if (parsed.event === "token" && typeof parsed.data === "string") {
                    token = parsed.data;
                    hasTokens = true;
                  } else if (parsed.event === "on_chat_model_stream" && parsed.data?.content) {
                    token = parsed.data.content;
                    hasTokens = true;
                  } else if (parsed.event === "metadata" && parsed.data?.text) {
                    token = parsed.data.text;
                    hasTokens = true;
                  }

                  if (token) {
                    fullText += token;
                    controller.enqueue(encoder.encode(token));
                  }
                } catch {}
              }
            }
          }

          if (!hasTokens && fullRaw) {
            try {
              const completeJson = JSON.parse(fullRaw);
              const fallbackText =
                completeJson.text ||
                completeJson.answer ||
                completeJson.output ||
                JSON.stringify(completeJson);
              controller.enqueue(encoder.encode(fallbackText));
            } catch {}
          }
        } catch (err: any) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  });

