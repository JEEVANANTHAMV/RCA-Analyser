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
      .prepare("SELECT id, user_id, agent_key, session_id, rca_case_id FROM conversations WHERE id = ?")
      .get(data.conversationId) as
      | Pick<ConversationRow, "id" | "user_id" | "agent_key" | "session_id" | "rca_case_id">
      | undefined;
    if (!convo) throw new Error("Conversation not found");
    if (convo.user_id !== userId) throw new Error("Forbidden");

    let chatId = convo.session_id;
    if (convo.agent_key !== "data_collector" && convo.rca_case_id) {
      const collector = db
        .prepare("SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'")
        .get(convo.rca_case_id) as { session_id: string } | undefined;
      if (collector?.session_id) {
        chatId = collector.session_id;
      }
    }

    const agent = AGENT_BY_KEY[convo.agent_key as AgentKey];
    if (!agent) throw new Error("Unknown agent");

    // 1. Insert User Message
    const msgId = generateId();
    const attachJson = data.attachments ? JSON.stringify(data.attachments) : null;
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, attachments) VALUES (?, ?, 'user', ?, ?)",
    ).run(msgId, data.conversationId, data.message, attachJson);

    // 2. Fetch full conversation history of current agent session
    const currentMsgs = db
      .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(data.conversationId) as { role: string; content: string }[];
    
    // Construct history-aware question
    let prompt = "";
    if (convo.agent_key === "five_why") {
      prompt = data.message;
    } else {
      prompt = "Here is the conversation history for this agent session so far:\n\n";
      for (const msg of currentMsgs) {
        const roleName = msg.role === "user" ? "Operator" : "Assistant";
        prompt += `[${roleName}]: ${msg.content}\n`;
      }
      prompt += `\nOperator's new message: ${data.message}\n\nPlease reply based on the history above and provide the requested analysis.`;
    }

    const requestBody: Record<string, unknown> = {
      question: prompt,
      overrideConfig: { sessionId: chatId },
      chatId: chatId,
      streaming: true,
    };

    if (data.attachments && data.attachments.length > 0) {
      const uploads: any[] = [];
      const nonImageAttachments: any[] = [];

      for (const att of data.attachments) {
        if (att.contentType.startsWith("image/")) {
          uploads.push({
            data: `data:${att.contentType};base64,${att.data}`,
            mime: att.contentType,
            name: att.filename,
            type: "file",
          });
        } else {
          nonImageAttachments.push(att);
        }
      }

      if (nonImageAttachments.length > 0) {
        try {
          const formData = new FormData();
          for (const att of nonImageAttachments) {
            const buffer = Buffer.from(att.data, "base64");
            const blob = new Blob([buffer], { type: att.contentType });
            formData.append("files", blob, att.filename);
          }
          formData.append("chatId", chatId);

          const attachmentsUrl = `${getAgentApiBase().replace("/prediction", "/attachments")}/${agent.id}/${chatId}`;
          const attachRes = await fetch(attachmentsUrl, {
            method: "POST",
            body: formData,
          });

          if (attachRes.ok) {
            const parsedFiles = await attachRes.json();
            if (Array.isArray(parsedFiles)) {
              for (const f of parsedFiles) {
                uploads.push({
                  data: f.content || "",
                  mime: f.mimeType || "text/plain",
                  name: f.name || "file.txt",
                  type: "file:full",
                });
              }
            }
          }
        } catch (err) {
          console.error("Error parsing attachments via API:", err);
        }

        // Fallback for non-images if parsing failed
        const parsedNonImageCount = uploads.filter((u) => u.type === "file:full").length;
        if (parsedNonImageCount === 0) {
          for (const att of nonImageAttachments) {
            uploads.push({
              data: `data:${att.contentType};base64,${att.data}`,
              mime: att.contentType,
              name: att.filename,
              type: "file",
            });
          }
        }
      }

      requestBody.uploads = uploads;
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
            equipmentName: z.string().optional().nullable(),
            location: z.string().optional().nullable(),
            operatingConditions: z.string().optional().nullable(),
            timestamp: z.string().optional().nullable(),
            witnessedSymptoms: z.string().optional().nullable(),
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
      const sessionId = generateId();
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
    let sessionId = generateId();
    if (data.agentKey !== "data_collector") {
      const collector = db
        .prepare("SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'")
        .get(data.caseId) as { session_id: string } | undefined;
      if (collector?.session_id) {
        sessionId = collector.session_id;
      }
    }
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
      .prepare(`
        SELECT c.*, COUNT(m.id) as message_count
        FROM conversations c
        LEFT JOIN messages m ON c.id = m.conversation_id
        WHERE c.rca_case_id = ?
        GROUP BY c.id
        ORDER BY c.created_at
      `)
      .all(data.caseId) as (ConversationRow & { message_count: number })[];
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

export const clearConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ conversationId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();
    const existing = db
      .prepare("SELECT user_id FROM conversations WHERE id = ?")
      .get(data.conversationId) as { user_id: string } | undefined;
    if (!existing) throw new Error("Conversation not found");
    if (existing.user_id !== userId) throw new Error("Forbidden");
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(data.conversationId);
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
      let sessionId = generateId();
      if (data.agentKey !== "data_collector") {
        const collector = db
          .prepare("SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'")
          .get(data.caseId) as { session_id: string } | undefined;
        if (collector?.session_id) {
          sessionId = collector.session_id;
        }
      }
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

      prompt = `You are the Data Collector & Validator agent. Your job is to parse the raw incident information, extract key parameters, validate them, construct a concise problem statement and operational effect, and identify gaps or follow-up questions.
IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown block, explanations, or prose. The JSON must exactly conform to this schema:
{
  "problemStatement": "A concise problem statement of the failure",
  "effect": "Operational impact / consequence of the failure",
  "equipmentName": "Identified equipment tag/name or 'Unknown'",
  "location": "Identified process unit/location or 'Unknown'",
  "operatingConditions": "Operating conditions at failure or 'Unknown'",
  "timestamp": "Failure timestamp or 'Unknown'",
  "witnessedSymptoms": "Witnessed symptoms or logs or 'Unknown'",
  "maintenanceHistoryChecked": false,
  "gaps": ["List of data gaps identified", "Second data gap"],
  "followUps": ["Operator follow-up question 1", "Operator follow-up question 2"]
}

Incident Details to analyze:
Incident Title: ${rcaCase.title}
${rcaCase.asset_id ? `Asset Identifier: ${rcaCase.asset_id}` : ""}
${initialDesc ? `Incident Description: ${initialDesc}` : ""}
${initialAttachments ? `Incident Initial Photos/Attachments: ${initialAttachments}` : ""}
`;
    } else if (data.agentKey === "five_why") {
      const rcaCase = db
        .prepare("SELECT title, incident_data, asset_id FROM rca_cases WHERE id = ?")
        .get(data.caseId) as CaseRow | undefined;
      if (!rcaCase) throw new Error("Case not found");

      let problemStatement = "";
      let effect = "";
      let equipmentName = "";
      let location = "";
      let operatingConditions = "";
      let timestamp = "";
      let witnessedSymptoms = "";

      if (rcaCase.incident_data) {
        try {
          const parsedInc = JSON.parse(rcaCase.incident_data);
          if (parsedInc) {
            problemStatement = parsedInc.problemStatement || parsedInc.description || "";
            effect = parsedInc.effect || "";
            equipmentName = parsedInc.equipmentName || "";
            location = parsedInc.location || "";
            operatingConditions = parsedInc.operatingConditions || "";
            timestamp = parsedInc.timestamp || "";
            witnessedSymptoms = parsedInc.witnessedSymptoms || "";
          }
        } catch {}
      }

      prompt = `You are a 5-Why Analysis agent. Generate the 5-Why analysis step.
IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. The JSON must exactly conform to this schema:
{
  "whyStep": 1,
  "question": "Why did the failure event occur?",
  "possibleCauses": [
    {
      "id": "cause-a",
      "category": "Equipment",
      "description": "Description of possible cause A",
      "likelihood": "High"
    }
  ],
  "operatorInstruction": "Actionable instructions for the operator to verify or check this step."
}

Incident Context:
Problem Statement: ${problemStatement}
Operational Effect / Impact: ${effect}
Equipment Tag / Name: ${equipmentName}
Location / Process Unit: ${location}
Operating Conditions at Failure: ${operatingConditions}
Failure Timestamps: ${timestamp}
Witnessed Symptoms / Telex Logs: ${witnessedSymptoms}

START FRESH 5 WHY ANALYSIS. Generate only WHY STEP 1 — the first question.`;
    } else if (data.agentKey === "fishbone") {
      const rcaCase = db
        .prepare("SELECT title, incident_data, asset_id FROM rca_cases WHERE id = ?")
        .get(data.caseId) as CaseRow | undefined;
      if (!rcaCase) throw new Error("Case not found");

      let problemStatement = "";
      let effect = "";
      let equipmentName = "";
      let location = "";
      let operatingConditions = "";
      let timestamp = "";
      let witnessedSymptoms = "";

      if (rcaCase.incident_data) {
        try {
          const parsedInc = JSON.parse(rcaCase.incident_data);
          if (parsedInc) {
            problemStatement = parsedInc.problemStatement || parsedInc.description || "";
            effect = parsedInc.effect || "";
            equipmentName = parsedInc.equipmentName || "";
            location = parsedInc.location || "";
            operatingConditions = parsedInc.operatingConditions || "";
            timestamp = parsedInc.timestamp || "";
            witnessedSymptoms = parsedInc.witnessedSymptoms || "";
          }
        } catch {}
      }

      // Gather 5-Why root cause if available
      let fiveWhySummary = "";
      const fiveWhyConvo = db
        .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'five_why'")
        .get(data.caseId) as { id: string } | undefined;
      if (fiveWhyConvo) {
        const fiveWhyMsgs = db
          .prepare(
            "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
          )
          .all(fiveWhyConvo.id) as { role: string; content: string }[];
        
        const lastWhyAssistant = fiveWhyMsgs.filter(m => m.role === "assistant").slice(-1)[0];
        if (lastWhyAssistant) {
          try {
            const parsedWhy = JSON.parse(lastWhyAssistant.content);
            fiveWhySummary = `Question: ${parsedWhy.question || ""}\nOperator Instruction: ${parsedWhy.operatorInstruction || ""}`;
          } catch {
            fiveWhySummary = lastWhyAssistant.content;
          }
        }
      }

      prompt = `You are a Fishbone (Ishikawa) Diagram analysis expert. You will conduct the analysis STEP BY STEP with the operator, not all at once. You must interact, ask verification questions, and refine causes iteratively before producing the final diagram.

ANALYSIS PROTOCOL — FOLLOW THESE STEPS IN ORDER:

STEP 1 — CONFIRM THE PROBLEM STATEMENT:
- Review the incident context and preceding findings below.
- Propose a concise problem statement that will be the "head" of the fishbone.
- Ask the operator to confirm or modify it.
- Respond ONLY with this JSON schema:
{
  "step": 1,
  "type": "problem_confirm",
  "proposedProblemStatement": "...",
  "question": "Is this problem statement accurate? Please confirm or provide corrections.",
  "nextStep": "Once confirmed, proceed to STEP 2 to propose initial 6M categories."
}

STEP 2 — PROPOSE INITIAL 6M CATEGORIES:
- Using the CONFIRMED problem statement, brainstorm high-level causes across all six 6M categories:
  manpower, machine, methods, materials, measurements, environment.
- Each category should have 2-4 initial high-level causes (no weights yet).
- Respond ONLY with this JSON schema:
{
  "step": 2,
  "type": "initial_categories",
  "problemStatement": "(use the confirmed problem statement here)",
  "categories": {
    "manpower": ["Cause 1", "Cause 2"],
    "machine": ["Cause 1", "Cause 2"],
    "methods": ["Cause 1", "Cause 2"],
    "materials": ["Cause 1", "Cause 2"],
    "measurements": ["Cause 1", "Cause 2"],
    "environment": ["Cause 1", "Cause 2"]
  },
  "question": "Review these initial categories. Confirm, add, remove, or modify any causes before we drill deeper.",
  "nextStep": "After operator confirms, proceed to STEP 3 to drill into the first category."
}

STEP 3 THROUGH 8 — DRILL DOWN ONE CATEGORY AT A TIME:
- Pick ONE category from the 6M list. Start with the categories most relevant to the problem.
- For each cause in that category, ask the operator 1-3 specific verification questions:
  * "What evidence supports or refutes this cause?"
  * "Check maintenance logs, vibration data, operator interviews, inspection records..."
  * "Is this a sub-cause of something deeper, or is it the root?"
- Based on the operator's answers, refine causes: add sub-causes, remove unsupported ones, split ambiguous ones.
- When the operator confirms a category is complete, move to the NEXT category.
- Respond ONLY with this JSON schema:
{
  "step": N,
  "type": "drill_down",
  "activeCategory": "machine",
  "completedCategories": ["manpower"],
  "pendingCategories": ["methods", "materials", "measurements", "environment"],
  "refinedCauses": [
    { "cause": "Pump bearing wear — L10 life exceeded", "subCauses": ["Oil degradation", "Misalignment"], "status": "confirmed" },
    { "cause": "Seal degradation", "subCauses": [], "status": "pending_verification" }
  ],
  "question": "For the active category, here are your specific verification questions...",
  "operatorInstruction": "Check X, verify Y, confirm Z.",
  "nextStep": "Continue drilling or mark category complete, then move to next category."
}
- Status values for each cause: "confirmed", "pending_verification", "refuted", "needs_subcause"

STEP 9 — ASSIGN WEIGHTS AND LIKELIHOODS (AFTER ALL CATEGORIES COMPLETE):
- Ask the operator to review the fully refined cause list before assigning final scores.
- Respond with this JSON schema:
{
  "step": 9,
  "type": "scoring_review",
  "question": "All 6M categories are drilled down. Before I assign final weights and likelihoods, review the full list. Any last additions or corrections?",
  "fullCauseSummary": {
    "manpower": ["Cause 1", "Cause 2"],
    "machine": ["Cause A with subcauses", ...],
    ...
  },
  "nextStep": "After operator confirms, produce STEP 10 (final output)."
}

STEP 10 — PRODUCE FINAL FISHBONE JSON:
- Generate the complete 6M fishbone diagram data with weighted, scored causes.
- This is the FINAL step. No more interaction after this.
- IMPORTANT: Include BOTH "subCauses" arrays AND the "confirmed" causes flat.
- Respond ONLY with this JSON schema:
{
  "step": 10,
  "type": "final",
  "problemStatement": "(the confirmed problem statement)",
  "fishbone": {
    "manpower": [
      { "cause": "Final cause description", "likelihood": "High", "weight": 75, "subCauses": ["Sub cause 1", "Sub cause 2"], "evidence": "Operator confirmed via X" }
    ],
    "machine": [ ... ],
    "methods": [ ... ],
    "materials": [ ... ],
    "measurements": [ ... ],
    "environment": [ ... ]
  }
}

RULES:
1. NEVER skip steps. Progress sequentially: 1 -> 2 -> 3 (drill) -> ... -> 9 (score) -> 10 (final).
2. NEVER produce the full 6M fishbone JSON until STEP 10.
3. ALWAYS wait for the operator's response before moving to the next step.
4. ALWAYS respond with valid JSON only — no markdown, no prose, no explanation outside the JSON.
5. If the operator says "finalize" or "skip remaining", produce STEP 10 immediately with whatever categories are complete so far.
6. During drill-down (STEP 3-8), focus on ONE category per turn. Ask specific, actionable verification questions — not generic ones.
7. Use evidence from preceding steps (Data Collector findings, 5-Why root cause chain) to inform your questions and cause proposals.
8. Weight assignment logic: High evidence + directly linked to problem = weight 70-100. Moderate evidence = 30-69. Speculative/low evidence = 0-29.
9. Likelihood assignment: "High" if supported by data/logs/operator confirmation. "Medium" if plausible but unverified. "Low" if weak evidence.

INCIDENT CONTEXT AND PRECEDING FINDINGS:
Incident Title: ${rcaCase.title}
Problem Statement: ${problemStatement}
Operational Effect / Impact: ${effect}
Equipment Tag / Name: ${equipmentName}
Location / Process Unit: ${location}
Operating Conditions at Failure: ${operatingConditions}
Failure Timestamps: ${timestamp}
Witnessed Symptoms / Telex Logs: ${witnessedSymptoms}

Preceding 5-Why Findings:
${fiveWhySummary}

BEGIN WITH STEP 1 NOW. Output only the STEP 1 JSON.`;
    } else {
      // Subsequent agents: gather previous agents' outputs
      prompt = `You are an expert industrial reliability engineer performing a Root Cause Analysis (RCA) step. Your step is: ${agent.name} (${agent.description}).\n\n`;
      prompt += `Please analyze the findings, operator adjustments, and outputs from the preceding steps in the RCA pipeline:\n\n`;

      for (let i = 0; i < currentIdx; i++) {
        const prevKey = AGENT_KEYS[i];
        const prevAgent = AGENT_BY_KEY[prevKey];
        const prevConvo = db
          .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ?")
          .get(data.caseId, prevKey) as { id: string } | undefined;
        if (prevConvo) {
          const prevMsgs = db
            .prepare(
              "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            )
            .all(prevConvo.id) as { role: string; content: string }[];
          if (prevMsgs.length > 0) {
            prompt += `=== Preceding Step Full History: ${prevAgent.name} ===\n`;
            for (const msg of prevMsgs) {
              const roleName = msg.role === "user" ? "Operator" : "Assistant";
              prompt += `[${roleName}]: ${msg.content}\n`;
            }
            prompt += `\n`;
          }
        }
      }

      prompt += `\nUsing the preceding findings and full history above, perform your analysis for ${agent.name}.\n`;

      if (data.agentKey === "fault_tree") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. The JSON must exactly conform to this schema:
{
  "tree": {
    "id": "top-event",
    "label": "The primary/top failure event description",
    "type": "gate",
    "gateType": "OR",
    "probability": 1.0,
    "children": [
      {
        "id": "sub-event-1",
        "label": "Description of contributing sub-event 1",
        "type": "gate",
        "gateType": "AND",
        "probability": 0.3,
        "children": [
          {
            "id": "leaf-event-1",
            "label": "Description of root leaf cause",
            "type": "event",
            "probability": 0.1
          }
        ]
      }
    ]
  }
}`;
      } else if (data.agentKey === "pareto") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. The JSON must exactly conform to this schema:
{
  "paretoAnalysis": {
    "byFailureMode": [
      { "mode": "Failure Mode A (e.g. Mechanical Valve Impingement)", "frequency": 12 },
      { "mode": "Failure Mode B (e.g. Temperature Sensor Calibration Drift)", "frequency": 4 }
    ]
  }
}`;
      } else if (data.agentKey === "timeline") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. The JSON must exactly conform to this schema:
{
  "timeline": {
    "phases": [
      {
        "phase": "Pre-Incident Operations",
        "start": "T-60m",
        "duration": "55m",
        "description": "Steady state operations",
        "events": [
          "08:00 UTC: Nominal feed rate and temperatures"
        ]
      },
      {
        "phase": "Trigger Event",
        "start": "T-5m",
        "duration": "5m",
        "description": "Onset of failure",
        "events": [
          "08:55 UTC: Localized tube overheating trip"
        ]
      }
    ]
  }
}`;
      } else if (data.agentKey === "equipment") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. The JSON must exactly conform to this schema:
{
  "reliabilityMetrics": {
    "rpnScores": {
      "probe": 30,
      "valve": 85,
      "controller": 40
    }
  }
}`;
      } else if (data.agentKey === "report") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. The JSON must exactly conform to this schema:
{
  "rootCause": "Clear statement of the confirmed root cause of the failure",
  "correctiveActionsList": [
    { "id": "capa-1", "desc": "Inspect burner tips and gas ratio settings", "owner": "Ops Team", "date": "2026-06-01", "status": "Pending" }
  ],
  "checklist": {
    "rootCauseMapped": true,
    "capaFeasible": true,
    "redundancyMet": true
  }
}`;
      }
    }

    // 3. Store system-pipeline user message in messages
    const msgId = generateId();
    const userMsgContent = (data.agentKey === "five_why" || data.agentKey === "fishbone") ? prompt : `[Auto-Pipeline Hypothesis Generation Request]`;
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
    ).run(msgId, convo.id, userMsgContent);

    let chatId = convo.session_id;
    if (convo.agent_key !== "data_collector" && convo.rca_case_id) {
      const collector = db
        .prepare("SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'")
        .get(convo.rca_case_id) as { session_id: string } | undefined;
      if (collector?.session_id) {
        chatId = collector.session_id;
      }
    }

    // 4. Send request to agent API
    const requestBody = {
      question: prompt,
      overrideConfig: { sessionId: chatId },
      chatId: chatId,
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
        locked: z.boolean().optional(),
        equipmentName: z.string().optional(),
        location: z.string().optional(),
        operatingConditions: z.string().optional(),
        timestamp: z.string().optional(),
        witnessedSymptoms: z.string().optional(),
        maintenanceHistoryChecked: z.boolean().optional(),
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
      problemStatement: data.problemStatement,
      effect: data.effect || "",
      gaps: data.gaps || [],
      followUps: data.followUps || [],
      locked: !!data.locked,
      equipmentName: data.equipmentName || "",
      location: data.location || "",
      operatingConditions: data.operatingConditions || "",
      timestamp: data.timestamp || "",
      witnessedSymptoms: data.witnessedSymptoms || "",
      maintenanceHistoryChecked: !!data.maintenanceHistoryChecked,
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
      const sessionId = generateId();
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

export const updateAssistantMessage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        conversationId: z.string(),
        messageId: z.string(),
        content: z.string(),
        rawResponse: z.unknown().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const db = getDb();
    const rawResStr = data.rawResponse ? JSON.stringify(data.rawResponse) : data.content;
    db.prepare("UPDATE messages SET content = ?, raw_response = ? WHERE id = ?").run(
      data.content,
      rawResStr,
      data.messageId
    );
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
      data.conversationId
    );
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
    prompt += `\n\nYou MUST analyze this incident data and construct a structured analysis response matching the following JSON schema:
{
  "problemStatement": "concise problem statement description",
  "effect": "operational impact / effect of failure",
  "gaps": ["list of gaps", "unresolved questions"],
  "followUps": ["suggested follow-ups"]
}

Output ONLY the raw JSON object, without any markdown formatting or codeblocks. Ensure it is valid JSON.`;

    const chatId = generateId();
    const agent = AGENT_BY_KEY["data_collector"];
    const requestBody: Record<string, any> = {
      question: prompt,
      chatId,
      streaming: true,
    };

    if (data.attachments && data.attachments.length > 0) {
      const uploads: any[] = [];
      const nonImageAttachments: any[] = [];

      for (const att of data.attachments) {
        if (att.contentType.startsWith("image/")) {
          uploads.push({
            data: `data:${att.contentType};base64,${att.data}`,
            mime: att.contentType,
            name: att.filename,
            type: "file",
          });
        } else {
          nonImageAttachments.push(att);
        }
      }

      if (nonImageAttachments.length > 0) {
        try {
          const formData = new FormData();
          for (const att of nonImageAttachments) {
            const buffer = Buffer.from(att.data, "base64");
            const blob = new Blob([buffer], { type: att.contentType });
            formData.append("files", blob, att.filename);
          }
          formData.append("chatId", chatId);

          const attachmentsUrl = `${getAgentApiBase().replace("/prediction", "/attachments")}/${agent.id}/${chatId}`;
          const attachRes = await fetch(attachmentsUrl, {
            method: "POST",
            body: formData,
          });

          if (attachRes.ok) {
            const parsedFiles = await attachRes.json();
            if (Array.isArray(parsedFiles)) {
              for (const f of parsedFiles) {
                uploads.push({
                  data: f.content || "",
                  mime: f.mimeType || "text/plain",
                  name: f.name || "file.txt",
                  type: "file:full",
                });
              }
            }
          }
        } catch (err) {
          console.error("Error parsing attachments via API in pre-analysis:", err);
        }

        // Fallback for non-images if parsing failed
        const parsedNonImageCount = uploads.filter((u) => u.type === "file:full").length;
        if (parsedNonImageCount === 0) {
          for (const att of nonImageAttachments) {
            uploads.push({
              data: `data:${att.contentType};base64,${att.data}`,
              mime: att.contentType,
              name: att.filename,
              type: "file",
            });
          }
        }
      }

      requestBody.uploads = uploads;
    }

    const res = await fetch(`${getAgentApiBase()}/${agent.id}`, {
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

