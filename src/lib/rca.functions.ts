import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { getDb, generateId } from "@/lib/database";
import { getAgentApiBase, AGENT_BY_KEY, RESPONDER_AGENT_ID, type AgentKey } from "@/lib/agents";
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

// ─── Internal helpers ────────────────────────────────────────────────────────

async function callAgentApiRaw(agentKey: AgentKey, prompt: string, chatId: string): Promise<string> {
  const agent = AGENT_BY_KEY[agentKey];
  if (!agent?.id) throw new Error(`Agent ${agentKey} is not configured`);

  const res = await fetch(`${getAgentApiBase()}/${agent.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: prompt,
      overrideConfig: { sessionId: chatId },
      chatId,
      streaming: true,
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Agent ${agent.shortName} failed: ${res.status} ${errText.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error(`Agent ${agent.shortName} returned no body`);

  const decoder = new TextDecoder();
  let fullText = "";
  let fullRaw = "";
  let buffer = "";
  let hasTokens = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    fullRaw += chunk;
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        let token = "";
        if (parsed.event === "token" && typeof parsed.data === "string") {
          token = parsed.data; hasTokens = true;
        } else if (parsed.event === "on_chat_model_stream" && parsed.data?.content) {
          token = parsed.data.content; hasTokens = true;
        }
        if (token) fullText += token;
      } catch {}
    }
  }

  if (!hasTokens && fullRaw) {
    try {
      const json = JSON.parse(fullRaw);
      fullText = json.text || json.answer || json.output || JSON.stringify(json);
    } catch {}
  }

  return fullText;
}

function isAgentIterationDone(agentKey: string, parsed: any): boolean {
  if (!parsed) return false;
  switch (agentKey) {
    case "five_why":
      return (parsed.whyStep >= 5) || parsed.rootCauseIdentified === true;
    case "fishbone":
      return parsed.type === "final" || parsed.step === 10;
    default:
      return true;
  }
}

interface ResponderResult {
  answerText: string;
  proceedSignal: "confirm" | "modify" | "custom" | "finalize" | "insufficient_data";
  selectedOptionId: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

async function callAnswererAgent(
  agentKey: string,
  agentParsed: any,
  chatId: string,
  incidentData: Record<string, any>,
  caseTitle: string,
  assetId: string | null,
  conversationHistory: { role: string; content: string }[],
  priorFindings: string,
): Promise<ResponderResult> {
  const fallback = (answerText: string): ResponderResult => ({
    answerText,
    proceedSignal: "confirm",
    selectedOptionId: null,
    confidence: "medium",
    reasoning: "fallback",
  });

  const prompt = buildResponderPrompt(
    agentKey,
    agentParsed,
    incidentData,
    caseTitle,
    assetId,
    conversationHistory,
    priorFindings,
  );

  try {
    const res = await fetch(
      `${getAgentApiBase()}/${RESPONDER_AGENT_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: prompt, chatId, streaming: true }),
        signal: AbortSignal.timeout(120000),
      },
    );

    if (!res.ok) return fallback(buildFallbackAnswer(agentKey, agentParsed));

    const reader = res.body?.getReader();
    if (!reader) return fallback(buildFallbackAnswer(agentKey, agentParsed));

    const decoder = new TextDecoder();
    let fullText = "";
    let fullRaw = "";
    let buffer = "";
    let hasTokens = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullRaw += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const p = JSON.parse(payload);
          let token = "";
          if (p.event === "token" && typeof p.data === "string") { token = p.data; hasTokens = true; }
          else if (p.event === "on_chat_model_stream" && p.data?.content) { token = p.data.content; hasTokens = true; }
          if (token) fullText += token;
        } catch {}
      }
    }

    if (!hasTokens && fullRaw) {
      try {
        const j = JSON.parse(fullRaw);
        fullText = j.text || j.answer || j.output || JSON.stringify(j);
      } catch {}
    }

    // Parse responder JSON
    let cleaned = fullText.trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) cleaned = fence[1].trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);

    const parsed = JSON.parse(cleaned);

    if (!parsed.answerText || typeof parsed.answerText !== "string") {
      return fallback(buildFallbackAnswer(agentKey, agentParsed));
    }

    return {
      answerText: parsed.answerText,
      proceedSignal: parsed.proceedSignal || "confirm",
      selectedOptionId: parsed.selectedOptionId || null,
      confidence: parsed.confidence || "medium",
      reasoning: parsed.reasoning || "",
    };
  } catch (err) {
    console.error("[responder] callAnswererAgent error:", err);
    return fallback(buildFallbackAnswer(agentKey, agentParsed));
  }
}

function buildResponderPrompt(
  agentKey: string,
  agentParsed: any,
  incidentData: Record<string, any>,
  caseTitle: string,
  assetId: string | null,
  conversationHistory: { role: string; content: string }[],
  priorFindings: string,
): string {
  const agent = AGENT_BY_KEY[agentKey as AgentKey];
  const agentOrder = agent?.order ?? "?";
  const agentName = agent?.name ?? agentKey;
  const agentDesc = agent?.description ?? "";

  const inc = incidentData;
  const lines: string[] = [
    "## INCIDENT CONTEXT",
    `Title: ${caseTitle}`,
    assetId ? `Asset: ${assetId}` : "",
    inc.problemStatement ? `Problem Statement: ${inc.problemStatement}` : "",
    inc.effect ? `Effect: ${inc.effect}` : "",
    inc.equipmentName ? `Equipment: ${inc.equipmentName}` : "",
    inc.location ? `Location: ${inc.location}` : "",
    inc.operatingConditions ? `Operating Conditions: ${inc.operatingConditions}` : "",
    inc.timestamp ? `Failure Timestamp: ${inc.timestamp}` : "",
    inc.witnessedSymptoms ? `Witnessed Symptoms: ${inc.witnessedSymptoms}` : "",
    "",
    `## CURRENT PIPELINE AGENT`,
    `Agent: ${agentKey} (Step ${agentOrder}/8) — ${agentName}`,
    `Description: ${agentDesc}`,
    "",
    "## PRIOR AGENT FINDINGS",
    priorFindings || "(none yet)",
    "",
    "## CURRENT AGENT MESSAGE (What you must answer)",
    JSON.stringify(agentParsed, null, 2),
    "",
  ];

  if (conversationHistory.length > 0) {
    lines.push("## CONVERSATION HISTORY IN THIS STEP");
    for (const m of conversationHistory) {
      lines.push(`[${m.role === "user" ? "Operator" : "Assistant"}]: ${m.content}`);
    }
    lines.push("");
  }

  lines.push("Respond ONLY with your JSON object.");
  return lines.filter((l) => l !== undefined).join("\n");
}

function buildFallbackAnswer(agentKey: string, parsed: any): string {
  if (agentKey === "five_why") {
    const step = parsed?.whyStep ?? 1;
    if (step >= 4) return "Root cause sufficiently identified. Please finalise the 5-Why analysis.";
    if (parsed?.possibleCauses?.length) {
      const top = parsed.possibleCauses.find((c: any) => c.likelihood === "High") || parsed.possibleCauses[0];
      return `I select ${top.id}: ${top.description}. Based on available incident data, this is the most probable cause.`;
    }
    return `Cause at Why Step ${step} is confirmed based on available evidence. Please proceed to Why Step ${step + 1}.`;
  }
  if (agentKey === "fishbone") {
    const type = parsed?.type;
    const cat = parsed?.activeCategory || "this category";
    if (type === "problem_confirm") return "Confirmed. The problem statement is accurate. Proceed.";
    if (type === "initial_categories") return "All initial 6M categories confirmed. Proceed to drill down.";
    if (type === "drill_down") return `All causes in ${cat} confirmed based on incident context. Proceed to next category.`;
    if (type === "scoring_review") return "All causes reviewed. Proceed with final scoring and produce the fishbone diagram.";
    return "Confirmed. Please proceed.";
  }
  return "Confirmed based on available evidence. Please proceed.";
}

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
      const MIME_TO_EXT: Record<string, string> = {
        "application/pdf": "pdf",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "application/vnd.ms-powerpoint": "ppt",
        "text/csv": "csv",
        "text/plain": "txt",
      };
      for (const att of data.attachments) {
        const ext = MIME_TO_EXT[att.contentType] || att.contentType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
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

    const incidentDataObj: Record<string, any> = {
      description: data.description || "",
      attachments: savedAttachments,
    };

    // If pre-analyzed data was approved, merge it into incident_data
    // so the RCA workspace can load all fields on first render
    if (data.preAnalyzedData) {
      incidentDataObj.problemStatement = data.preAnalyzedData.problemStatement || "";
      incidentDataObj.effect = data.preAnalyzedData.effect || "";
      incidentDataObj.gaps = data.preAnalyzedData.gaps || [];
      incidentDataObj.followUps = data.preAnalyzedData.followUps || [];
      incidentDataObj.locked = true;
      incidentDataObj.equipmentName = data.preAnalyzedData.equipmentName || "";
      incidentDataObj.location = data.preAnalyzedData.location || "";
      incidentDataObj.operatingConditions = data.preAnalyzedData.operatingConditions || "";
      incidentDataObj.timestamp = data.preAnalyzedData.timestamp || "";
      incidentDataObj.witnessedSymptoms = data.preAnalyzedData.witnessedSymptoms || "";
    }

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
      let preAnalyzedProblemStatement = "";
      let preAnalyzedEffect = "";
      let preAnalyzedEquipmentName = "";
      let preAnalyzedLocation = "";
      let preAnalyzedOperatingConditions = "";
      let preAnalyzedTimestamp = "";
      let preAnalyzedWitnessedSymptoms = "";
      let preAnalyzedGaps: string[] = [];
      let preAnalyzedFollowUps: string[] = [];
      if (rcaCase.incident_data) {
        try {
          const parsedData = JSON.parse(rcaCase.incident_data);
          initialDesc = parsedData.description || "";
          if (Array.isArray(parsedData.attachments)) {
            initialAttachments = parsedData.attachments.map((a: any) => `${a.filename} (${a.url})`).join(", ");
          }
          preAnalyzedProblemStatement = parsedData.problemStatement || "";
          preAnalyzedEffect = parsedData.effect || "";
          preAnalyzedEquipmentName = parsedData.equipmentName || "";
          preAnalyzedLocation = parsedData.location || "";
          preAnalyzedOperatingConditions = parsedData.operatingConditions || "";
          preAnalyzedTimestamp = parsedData.timestamp || "";
          preAnalyzedWitnessedSymptoms = parsedData.witnessedSymptoms || "";
          preAnalyzedGaps = Array.isArray(parsedData.gaps) ? parsedData.gaps : [];
          preAnalyzedFollowUps = Array.isArray(parsedData.followUps) ? parsedData.followUps : [];
        } catch {
          initialDesc = rcaCase.incident_data;
        }
      }

      const hasPreAnalysis = !!(preAnalyzedProblemStatement || preAnalyzedEquipmentName || preAnalyzedLocation);

      prompt = `You are the Data Collector & Validator agent. Your job is to validate and enrich the incident data, confirm pre-analyzed findings, and identify any remaining gaps or follow-up questions.
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

${hasPreAnalysis ? `PRE-ANALYZED DATA (already extracted from incident documents — use these values directly, only override if clearly incorrect):
Problem Statement: ${preAnalyzedProblemStatement || "Not extracted"}
Operational Effect: ${preAnalyzedEffect || "Not extracted"}
Equipment Tag / Name: ${preAnalyzedEquipmentName || "Unknown"}
Location / Process Unit: ${preAnalyzedLocation || "Unknown"}
Operating Conditions at Failure: ${preAnalyzedOperatingConditions || "Unknown"}
Failure Timestamp: ${preAnalyzedTimestamp || "Unknown"}
Witnessed Symptoms / Telex Logs: ${preAnalyzedWitnessedSymptoms || "Unknown"}
${preAnalyzedGaps.length > 0 ? `Previously Identified Gaps:\n${preAnalyzedGaps.map(g => `- ${g}`).join("\n")}` : ""}
${preAnalyzedFollowUps.length > 0 ? `Previously Suggested Follow-Ups:\n${preAnalyzedFollowUps.map(f => `- ${f}`).join("\n")}` : ""}

INSTRUCTIONS: The pre-analyzed fields above are already confirmed. Carry them forward exactly as-is in your JSON response. Focus your analysis on validating correctness and identifying any NEW gaps or missing information not already covered.
` : `Incident Details to analyze:
Incident Title: ${rcaCase.title}
${rcaCase.asset_id ? `Asset Identifier: ${rcaCase.asset_id}` : ""}
${initialDesc ? `Incident Description: ${initialDesc}` : ""}
${initialAttachments ? `Incident Attachments: ${initialAttachments}` : ""}
`}
${hasPreAnalysis && initialDesc ? `Additional Raw Description: ${initialDesc}` : ""}
${hasPreAnalysis && initialAttachments ? `Attachments: ${initialAttachments}` : ""}
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
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. Build the fault tree using ACTUAL failure causes identified in the preceding analysis — every label must be specific to this incident, not generic. The top-event probability must be 1.0. Child probabilities must be estimated from evidence (0.01–0.99). The JSON must exactly conform to this schema:
{
  "tree": {
    "id": "top-event",
    "label": "Specific description of the primary failure event for THIS incident",
    "type": "gate",
    "gateType": "OR",
    "probability": 1.0,
    "children": [
      {
        "id": "sub-event-1",
        "label": "Specific contributing cause identified in Fishbone/5-Why",
        "type": "gate",
        "gateType": "AND",
        "probability": 0.65,
        "children": [
          {
            "id": "leaf-event-1",
            "label": "Specific root leaf cause from the analysis",
            "type": "event",
            "probability": 0.45
          }
        ]
      }
    ]
  }
}
Generate at least 3 top-level child branches and at least 2 leaf events per branch. All labels must reference specific findings from the preceding steps.`;
      } else if (data.agentKey === "pareto") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. List the actual failure modes identified in the Fishbone and 5-Why analyses with estimated frequency/severity weights — frequencies MUST be non-zero integers derived from evidence strength (range 1–20 per mode). The JSON must exactly conform to this schema:
{
  "paretoAnalysis": {
    "byFailureMode": [
      { "mode": "Specific failure mode from THIS incident analysis", "frequency": 12 },
      { "mode": "Second identified failure mode", "frequency": 7 },
      { "mode": "Third identified failure mode", "frequency": 4 }
    ]
  }
}
Include ALL failure modes identified across all preceding steps. Assign higher frequencies to causes with stronger evidence.`;
      } else if (data.agentKey === "timeline") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. Reconstruct the actual chronological sequence of events for THIS specific incident using all known timestamps, symptoms, and findings from the preceding analysis. Each phase must have at least 2 specific events. The JSON must exactly conform to this schema:
{
  "timeline": {
    "phases": [
      {
        "phase": "Pre-Incident Operations",
        "start": "T-60m",
        "duration": "55m",
        "description": "Normal operating conditions before failure",
        "events": [
          "T-60m: Specific operational state from the incident context",
          "T-30m: Specific observation or reading"
        ]
      },
      {
        "phase": "Trigger Event",
        "start": "T-5m",
        "duration": "5m",
        "description": "Onset of the failure condition",
        "events": [
          "T-5m: First symptom observed (from witnessed symptoms field)",
          "T-0m: Failure event occurred"
        ]
      },
      {
        "phase": "Incident & Response",
        "start": "T+0m",
        "duration": "30m",
        "description": "Immediate post-failure response",
        "events": [
          "T+5m: Operator response action",
          "T+20m: Shutdown or containment"
        ]
      }
    ]
  }
}
Use the exact timestamps, symptoms, and equipment names from the incident. Generate at least 4 phases with at least 2 events each.`;
      } else if (data.agentKey === "equipment") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not wrap it in markdown, explanations, or prose. Derive ALL values from the incident context and preceding findings above — do not use placeholder numbers. The JSON must exactly conform to this schema:
{
  "reliabilityMetrics": {
    "mtbf": { "value": "720 hrs", "trend": "Decreasing — failure rate above historical average" },
    "mttr": { "value": "4.5 hrs", "trend": "Stable — within SLA" },
    "availability": { "value": "99.2%", "trend": "Below 99.5% target" },
    "failureRate": { "value": "0.0014 /hr", "trend": "Increasing — PM overdue" },
    "rpnScores": {
      "probe": 30,
      "valve": 85,
      "controller": 40
    }
  }
}
Replace every numeric value and trend string with incident-specific estimates. rpnScores keys must be exactly "probe", "valve", and "controller" with integer values 1–100.`;
      } else if (data.agentKey === "report") {
        prompt += `IMPORTANT: You MUST respond ONLY with a single JSON object. Do not add any prose, markdown, or explanation. Synthesise ALL preceding agent findings into a comprehensive RCA report. The JSON must exactly conform to this schema — fill EVERY field with incident-specific values derived from the analysis above:
{
  "rcaReport": {
    "header": {
      "rcaNumber": "HZL/<PLANT>/<EQUIP>/<Mon-YY>",
      "plant": "<plant name from incident>",
      "initiationDate": "<YYYY-MM-DD>",
      "submissionDate": "<YYYY-MM-DD>",
      "department": "<department from incident>",
      "section": "<section/area from incident>",
      "z2NotificationNumber": "",
      "zrNumber": ""
    },
    "equipment": {
      "number": "<equipment tag/number>",
      "name": "<full equipment name>",
      "occurrenceDateTime": "<date and time of failure>",
      "restorationDateTime": "<date and time restored>",
      "productionAffectedHours": "<e.g. 27 hours>",
      "affectsProduction": "Yes"
    },
    "problemDescription": "<1-2 sentence clear description of what failed and observed symptoms>",
    "immediateActions": [
      { "action": "<corrective action taken immediately>", "who": "<person/team>", "when": "<date/time>" }
    ],
    "costOfFailure": {
      "sparePartCost": 0,
      "serviceCost": 0,
      "manpowerCost": 0,
      "productionLoss": 0
    },
    "chronologyEvents": [
      { "srNo": 1, "event": "<specific event from incident context>", "date": "<YYYY-MM-DD>", "time": "<HH:MM>" },
      { "srNo": 2, "event": "<next event>", "date": "<YYYY-MM-DD>", "time": "<HH:MM>" }
    ],
    "teamMembers": [
      { "no": 1, "name": "<name>", "department": "<dept>", "type": "BP" }
    ],
    "maintenanceHistory": {
      "lastPMDate": "<YYYY-MM-DD>",
      "lastPMObservations": "<PM findings>",
      "cbmDate": "<YYYY-MM-DD>",
      "cbmStatus": "Normal",
      "rootCauseIdentifiableByCBM": "No"
    },
    "lastFailure": {
      "date": "<YYYY-MM-DD or Unknown>",
      "detail": "<description of last failure>",
      "rootCause": "<root cause of last failure>"
    },
    "fmeaExists": "NA",
    "currentFailureInFMEA": "NA",
    "whyWhyAnalysis": {
      "problem": "<problem statement from data_collector>",
      "stream1": {
        "why1": "<first level cause>",
        "why2": "<second level>",
        "why3": "<third level>",
        "why4": "<fourth level>",
        "why5": "<root cause level>"
      },
      "stream2": {
        "why1": "<parallel cause chain>",
        "why2": "<second level>",
        "why3": "<third level>",
        "why4": "",
        "why5": ""
      }
    },
    "rootCauses": [
      "<Primary root cause — specific to this incident>",
      "<Contributing root cause if any>",
      "",
      ""
    ],
    "fishboneCategories": {
      "manpower": ["<skill/knowledge gap if applicable>"],
      "machine": ["<equipment deficiency that contributed>"],
      "method": ["<process or procedure gap>"],
      "material": ["<material or spare part issue>"],
      "measurement": ["<monitoring or detection gap>"],
      "environment": ["<environmental factor if any>"]
    },
    "rootCauseCloseout": {
      "selectedCategories": ["machine", "method"]
    },
    "actionPlan": [
      {
        "srNo": 1,
        "action": "<corrective action — CA = address root cause>",
        "type": "CA",
        "classification": "NA",
        "responsible": "<person/team>",
        "department": "<dept>",
        "target": "<YYYY-MM-DD>",
        "status": "Pending"
      },
      {
        "srNo": 2,
        "action": "<preventive action — PA = prevent recurrence>",
        "type": "PA",
        "classification": "NA",
        "responsible": "<person/team>",
        "department": "<dept>",
        "target": "<YYYY-MM-DD>",
        "status": "In Progress"
      }
    ],
    "horizontalDeployment": "<describe which other similar equipment/areas this applies to>",
    "preventiveMeasures": "<PM/CBM/inspection changes to prevent recurrence>",
    "sustainableMeasures": "<SOP/SMP/WI updates required>",
    "externalInvestigationRequired": "No",
    "externalTestingRequired": "No",
    "changesRequiredInODC": "No",
    "changesRequiredInFMEA": "No"
  },
  "rootCause": "<same as rootCauses[0] — kept for backward compatibility>",
  "correctiveActionsList": [
    { "id": "capa-1", "desc": "<action description>", "owner": "<owner>", "date": "<YYYY-MM-DD>", "status": "Pending" }
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

    // Structured single-shot agents must not inherit stale session history from prior runs.
    // Give them a fresh chatId every time; conversation agents (data_collector, five_why, fishbone)
    // keep the shared collector session so context flows between turns.
    const STRUCTURED_AGENTS = ["fault_tree", "pareto", "timeline", "equipment", "report"];
    let chatId: string;
    if (STRUCTURED_AGENTS.includes(data.agentKey)) {
      chatId = `${convo.session_id}-${generateId()}`;
    } else if (convo.agent_key !== "data_collector" && convo.rca_case_id) {
      const collector = db
        .prepare("SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'")
        .get(convo.rca_case_id) as { session_id: string } | undefined;
      chatId = collector?.session_id ?? convo.session_id;
    } else {
      chatId = convo.session_id;
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

          // Strip leading prose before first JSON brace (handles "Synthesizing…" preamble)
          if (STRUCTURED_AGENTS.includes(data.agentKey)) {
            const jsonStart = assistantText.indexOf("{");
            if (jsonStart > 0) assistantText = assistantText.slice(jsonStart);
          }

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

// ─── Full Automation ─────────────────────────────────────────────────────────

export const runFullAutomation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const db = getDb();

    const rcaCase = db
      .prepare("SELECT * FROM rca_cases WHERE id = ?")
      .get(data.caseId) as CaseRow | undefined;
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId) throw new Error("Forbidden");

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: object) =>
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

        try {
          let collectorSessionId: string | null = null;

          for (const agentKey of AGENT_KEYS) {
            const agent = AGENT_BY_KEY[agentKey as AgentKey];
            emit({ type: "agent_start", agent: agentKey, name: agent.name });

            // Ensure conversation exists
            let convo = db
              .prepare(
                "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
              )
              .get(data.caseId, agentKey, userId) as ConversationRow | undefined;

            if (!convo) {
              const convoId = generateId();
              let sessionId = generateId();
              if (agentKey !== "data_collector" && collectorSessionId) {
                sessionId = collectorSessionId;
              }
              db.prepare(
                "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)",
              ).run(convoId, userId, agentKey, sessionId, data.caseId, agent.name);
              convo = db
                .prepare("SELECT * FROM conversations WHERE id = ?")
                .get(convoId) as ConversationRow;
            }

            if (agentKey === "data_collector") collectorSessionId = convo.session_id;
            // Structured single-shot agents get a fresh chatId to avoid stale session contamination.
            const STRUCTURED_AGENTS_FA = ["fault_tree", "pareto", "timeline", "equipment", "report"];
            const chatId = STRUCTURED_AGENTS_FA.includes(agentKey)
              ? `${convo.session_id}-${generateId()}`
              : (collectorSessionId ?? convo.session_id);

            // Skip if already has messages
            const existingCount = (
              db
                .prepare("SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?")
                .get(convo.id) as { cnt: number }
            ).cnt;

            if (existingCount > 0) {
              emit({ type: "agent_skip", agent: agentKey, message: "Already analysed — skipping" });
              continue;
            }

            // Build initial prompt (mirrors generateAgentHypothesis logic)
            const currentIdx = AGENT_KEYS.indexOf(agentKey as (typeof AGENT_KEYS)[number]);
            let prompt = "";

            if (agentKey === "data_collector") {
              let initialDesc = "";
              let initialAttachments = "";
              let prePS = "", preEffect = "", preEquip = "", preLoc = "", preOpCond = "", preTs = "", preSymptoms = "";
              let preGaps: string[] = [], preFollowUps: string[] = [];
              if (rcaCase.incident_data) {
                try {
                  const pd = JSON.parse(rcaCase.incident_data);
                  initialDesc = pd.description || "";
                  if (Array.isArray(pd.attachments)) {
                    initialAttachments = pd.attachments.map((a: any) => `${a.filename} (${a.url})`).join(", ");
                  }
                  prePS = pd.problemStatement || "";
                  preEffect = pd.effect || "";
                  preEquip = pd.equipmentName || "";
                  preLoc = pd.location || "";
                  preOpCond = pd.operatingConditions || "";
                  preTs = pd.timestamp || "";
                  preSymptoms = pd.witnessedSymptoms || "";
                  preGaps = Array.isArray(pd.gaps) ? pd.gaps : [];
                  preFollowUps = Array.isArray(pd.followUps) ? pd.followUps : [];
                } catch {}
              }
              const hasPreAnalysis = !!(prePS || preEquip || preLoc);
              prompt = `You are the Data Collector & Validator agent. Validate and enrich the incident data. Do NOT ask for user input — use all available information to produce a complete response.
IMPORTANT: Respond ONLY with a single JSON object matching this schema exactly:
{"problemStatement":"...","effect":"...","equipmentName":"...","location":"...","operatingConditions":"...","timestamp":"...","witnessedSymptoms":"...","maintenanceHistoryChecked":false,"gaps":["gap 1"],"followUps":["question 1"]}

${hasPreAnalysis ? `PRE-ANALYZED DATA (carry these forward exactly — only override if clearly incorrect):
Problem Statement: ${prePS}
Effect: ${preEffect}
Equipment: ${preEquip}
Location: ${preLoc}
Operating Conditions: ${preOpCond}
Timestamp: ${preTs}
Witnessed Symptoms: ${preSymptoms}
${preGaps.length > 0 ? `Gaps: ${preGaps.join("; ")}` : ""}
${preFollowUps.length > 0 ? `Follow-Ups: ${preFollowUps.join("; ")}` : ""}
` : `Incident Title: ${rcaCase.title}
${rcaCase.asset_id ? `Asset: ${rcaCase.asset_id}` : ""}
${initialDesc ? `Description: ${initialDesc}` : ""}
${initialAttachments ? `Attachments: ${initialAttachments}` : ""}
`}${hasPreAnalysis && initialDesc ? `Additional Description: ${initialDesc}` : ""}
${hasPreAnalysis && initialAttachments ? `Attachments: ${initialAttachments}` : ""}
Focus on identifying any remaining gaps — do not ask the user for clarification mid-run.`;

            } else if (agentKey === "five_why") {
              let ps = "", ef = "", eq = "", lo = "", oc = "", ts = "", ws = "";
              if (rcaCase.incident_data) {
                try {
                  const pi = JSON.parse(rcaCase.incident_data);
                  ps = pi.problemStatement || pi.description || "";
                  ef = pi.effect || ""; eq = pi.equipmentName || ""; lo = pi.location || "";
                  oc = pi.operatingConditions || ""; ts = pi.timestamp || ""; ws = pi.witnessedSymptoms || "";
                } catch {}
              }
              prompt = `You are a 5-Why Analysis agent. Respond ONLY with a single JSON object:
{"whyStep":1,"question":"Why did the failure event occur?","possibleCauses":[{"id":"cause-a","category":"Equipment","description":"Description","likelihood":"High"}],"operatorInstruction":"Actionable instruction."}

Problem Statement: ${ps}
Effect: ${ef}
Equipment: ${eq}
Location: ${lo}
Operating Conditions: ${oc}
Timestamps: ${ts}
Symptoms: ${ws}
START FRESH 5 WHY ANALYSIS. Generate only WHY STEP 1.`;

            } else if (agentKey === "fishbone") {
              let ps = "", ef = "", eq = "", lo = "", oc = "", ts = "", ws = "", fiveWhySummary = "";
              if (rcaCase.incident_data) {
                try {
                  const pi = JSON.parse(rcaCase.incident_data);
                  ps = pi.problemStatement || pi.description || "";
                  ef = pi.effect || ""; eq = pi.equipmentName || ""; lo = pi.location || "";
                  oc = pi.operatingConditions || ""; ts = pi.timestamp || ""; ws = pi.witnessedSymptoms || "";
                } catch {}
              }
              const fwConvo = db
                .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'five_why'")
                .get(data.caseId) as { id: string } | undefined;
              if (fwConvo) {
                const lm = db
                  .prepare(
                    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
                  )
                  .get(fwConvo.id) as { content: string } | undefined;
                if (lm) {
                  try {
                    const pw = JSON.parse(lm.content);
                    fiveWhySummary = `Question: ${pw.question || ""}\nInstruction: ${pw.operatorInstruction || ""}`;
                  } catch { fiveWhySummary = lm.content; }
                }
              }
              prompt = `You are a Fishbone (Ishikawa) Diagram analysis expert. Conduct the analysis STEP BY STEP.
PROTOCOL: Progress steps 1-10 sequentially. Always respond with valid JSON only.
STEP 1 — CONFIRM PROBLEM STATEMENT. Respond ONLY:
{"step":1,"type":"problem_confirm","proposedProblemStatement":"...","question":"Is this accurate?","nextStep":"Proceed to step 2."}
STEP 2 — INITIAL 6M CATEGORIES. Respond ONLY:
{"step":2,"type":"initial_categories","problemStatement":"...","categories":{"manpower":[],"machine":[],"methods":[],"materials":[],"measurements":[],"environment":[]},"question":"Review categories.","nextStep":"Proceed to step 3."}
STEPS 3-8 — DRILL DOWN ONE CATEGORY AT A TIME. Respond ONLY:
{"step":N,"type":"drill_down","activeCategory":"machine","completedCategories":[],"pendingCategories":[],"refinedCauses":[{"cause":"...","subCauses":[],"status":"confirmed"}],"question":"...","operatorInstruction":"...","nextStep":"..."}
STEP 9 — SCORING REVIEW. Respond ONLY:
{"step":9,"type":"scoring_review","question":"Review before scores.","fullCauseSummary":{},"nextStep":"Proceed to step 10."}
STEP 10 — FINAL OUTPUT (no more interaction). Respond ONLY:
{"step":10,"type":"final","problemStatement":"...","fishbone":{"manpower":[{"cause":"...","likelihood":"High","weight":75,"subCauses":[],"evidence":"..."}],"machine":[],"methods":[],"materials":[],"measurements":[],"environment":[]}}
INCIDENT CONTEXT:
Title: ${rcaCase.title}
Problem: ${ps}
Effect: ${ef}
Equipment: ${eq}
Location: ${lo}
Conditions: ${oc}
Timestamps: ${ts}
Symptoms: ${ws}
5-Why Findings: ${fiveWhySummary}
BEGIN WITH STEP 1 NOW.`;

            } else {
              prompt = `You are an expert industrial reliability engineer performing a Root Cause Analysis step: ${agent.name} (${agent.description}).\n\nAnalyse the findings from the preceding RCA pipeline steps:\n\n`;
              for (let i = 0; i < currentIdx; i++) {
                const prevKey = AGENT_KEYS[i];
                const prevAgent = AGENT_BY_KEY[prevKey as AgentKey];
                const prevConvo = db
                  .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ?")
                  .get(data.caseId, prevKey) as { id: string } | undefined;
                if (prevConvo) {
                  const prevMsgs = db
                    .prepare(
                      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
                    )
                    .all(prevConvo.id) as { role: string; content: string }[];
                  if (prevMsgs.length) {
                    prompt += `=== ${prevAgent.name} ===\n`;
                    for (const m of prevMsgs) {
                      prompt += `[${m.role === "user" ? "Operator" : "Assistant"}]: ${m.content}\n`;
                    }
                    prompt += "\n";
                  }
                }
              }
              prompt += `\nUsing the preceding findings, perform your analysis for ${agent.name}.\n`;

              if (agentKey === "fault_tree") {
                prompt += `IMPORTANT: Respond ONLY with a single JSON object. Use ACTUAL causes from the analysis above — every label must be incident-specific. Top-event probability=1.0. Generate at least 3 child branches with at least 2 leaf events each:\n{"tree":{"id":"top-event","label":"[Specific primary failure event for this incident]","type":"gate","gateType":"OR","probability":1.0,"children":[{"id":"sub-1","label":"[Specific contributing cause from Fishbone/5-Why]","type":"gate","gateType":"AND","probability":0.65,"children":[{"id":"leaf-1","label":"[Specific root cause]","type":"event","probability":0.45},{"id":"leaf-2","label":"[Second specific root cause]","type":"event","probability":0.3}]},{"id":"sub-2","label":"[Second contributing cause]","type":"gate","gateType":"OR","probability":0.4,"children":[{"id":"leaf-3","label":"[Root cause leaf]","type":"event","probability":0.2}]}]}}`;
              } else if (agentKey === "pareto") {
                prompt += `IMPORTANT: Respond ONLY with a single JSON object. List ALL actual failure modes from the analysis with NON-ZERO frequency weights (1–20) based on evidence strength. Include at least 5 modes:\n{"paretoAnalysis":{"byFailureMode":[{"mode":"[Specific failure mode 1 from this incident]","frequency":12},{"mode":"[Failure mode 2]","frequency":8},{"mode":"[Failure mode 3]","frequency":5},{"mode":"[Failure mode 4]","frequency":3},{"mode":"[Failure mode 5]","frequency":2}]}}`;
              } else if (agentKey === "timeline") {
                prompt += `IMPORTANT: Respond ONLY with a single JSON object. Reconstruct the actual incident chronology using all known timestamps and symptoms. Generate at least 4 phases with at least 2 specific events each:\n{"timeline":{"phases":[{"phase":"Pre-Incident Operations","start":"T-60m","duration":"55m","description":"Normal conditions","events":["[Specific T-60m event from incident context]","[Specific T-30m observation]"]},{"phase":"Trigger Event","start":"T-5m","duration":"5m","description":"Failure onset","events":["[First symptom from witnessed symptoms]","[Failure event at T-0m]"]},{"phase":"Incident Response","start":"T+0m","duration":"30m","description":"Immediate response","events":["[Operator response]","[Shutdown action]"]},{"phase":"Recovery","start":"T+30m","duration":"60m","description":"Recovery and investigation","events":["[Recovery step 1]","[Investigation initiated]"]}]}}`;
              } else if (agentKey === "equipment") {
                prompt += `IMPORTANT: Respond ONLY with a single JSON object. Derive all values from the incident context above — no placeholders:\n{"reliabilityMetrics":{"mtbf":{"value":"720 hrs","trend":"Decreasing"},"mttr":{"value":"4.5 hrs","trend":"Stable"},"availability":{"value":"99.2%","trend":"Below target"},"failureRate":{"value":"0.0014/hr","trend":"Increasing"},"rpnScores":{"probe":30,"valve":85,"controller":40}}}`;
              } else if (agentKey === "report") {
                prompt += `IMPORTANT: Respond ONLY with a single JSON object. Synthesise ALL preceding agent findings into a comprehensive RCA report matching this schema exactly:\n{"rcaReport":{"header":{"rcaNumber":"HZL/<PLANT>/<EQUIP>/<Mon-YY>","plant":"<plant>","initiationDate":"<YYYY-MM-DD>","submissionDate":"<YYYY-MM-DD>","department":"<dept>","section":"<section>","z2NotificationNumber":"","zrNumber":""},"equipment":{"number":"<tag>","name":"<name>","occurrenceDateTime":"<datetime>","restorationDateTime":"<datetime>","productionAffectedHours":"<hrs>","affectsProduction":"Yes"},"problemDescription":"<clear description>","immediateActions":[{"action":"<action>","who":"<who>","when":"<when>"}],"costOfFailure":{"sparePartCost":0,"serviceCost":0,"manpowerCost":0,"productionLoss":0},"chronologyEvents":[{"srNo":1,"event":"<event>","date":"<YYYY-MM-DD>","time":"<HH:MM>"}],"teamMembers":[{"no":1,"name":"<name>","department":"<dept>","type":"BP"}],"maintenanceHistory":{"lastPMDate":"<date>","lastPMObservations":"<obs>","cbmDate":"<date>","cbmStatus":"Normal","rootCauseIdentifiableByCBM":"No"},"lastFailure":{"date":"<date>","detail":"<detail>","rootCause":"<cause>"},"fmeaExists":"NA","currentFailureInFMEA":"NA","whyWhyAnalysis":{"problem":"<problem>","stream1":{"why1":"","why2":"","why3":"","why4":"","why5":""},"stream2":{"why1":"","why2":"","why3":"","why4":"","why5":""}},"rootCauses":["<primary RC>","","",""],"fishboneCategories":{"manpower":[],"machine":[],"method":[],"material":[],"measurement":[],"environment":[]},"rootCauseCloseout":{"selectedCategories":["machine"]},"actionPlan":[{"srNo":1,"action":"<CA>","type":"CA","classification":"NA","responsible":"<person>","department":"<dept>","target":"<YYYY-MM-DD>","status":"Pending"},{"srNo":2,"action":"<PA>","type":"PA","classification":"NA","responsible":"<person>","department":"<dept>","target":"<YYYY-MM-DD>","status":"In Progress"}],"horizontalDeployment":"<scope>","preventiveMeasures":"<measures>","sustainableMeasures":"<SOP updates>","externalInvestigationRequired":"No","externalTestingRequired":"No","changesRequiredInODC":"No","changesRequiredInFMEA":"No"},"rootCause":"<same as rootCauses[0]>","correctiveActionsList":[{"id":"capa-1","desc":"<action>","owner":"<owner>","date":"<YYYY-MM-DD>","status":"Pending"}],"checklist":{"rootCauseMapped":true,"capaFeasible":true,"redundancyMet":true}}`;
              }
            }

            // Save user message
            db.prepare(
              "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
            ).run(
              generateId(),
              convo.id,
              agentKey === "five_why" || agentKey === "fishbone"
                ? prompt
                : "[Auto-Pipeline Hypothesis Generation Request]",
            );

            emit({ type: "agent_progress", agent: agentKey, step: 1, message: "Calling agent API…" });

            let responseText = await callAgentApiRaw(agentKey as AgentKey, prompt, chatId);
            // Strip leading prose for structured agents (handles "Synthesizing…" preamble)
            if (STRUCTURED_AGENTS_FA.includes(agentKey)) {
              const jsonStart = responseText.indexOf("{");
              if (jsonStart > 0) responseText = responseText.slice(jsonStart);
            }
            let parsed: any = null;
            try {
              parsed = JSON.parse(responseText);
              responseText = JSON.stringify(parsed, null, 2);
            } catch {}

            db.prepare(
              "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
            ).run(
              generateId(),
              convo.id,
              responseText,
              JSON.stringify(parsed ?? { text: responseText }),
            );

            // Multi-step AI-responder loop for five_why and fishbone
            if (agentKey === "five_why" || agentKey === "fishbone") {
              const maxIterations = agentKey === "five_why" ? 7 : 12;
              let iteration = 0;
              let shouldFinalize = false;

              // Build incident data for responder context
              let incidentData: Record<string, any> = {};
              try { incidentData = JSON.parse(rcaCase.incident_data || "{}"); } catch {}

              // Build prior agent findings summary for responder
              const buildPriorFindings = () => {
                let pf = "";
                for (let i = 0; i < currentIdx; i++) {
                  const pk = AGENT_KEYS[i];
                  const pa = AGENT_BY_KEY[pk as AgentKey];
                  const pc = db
                    .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ?")
                    .get(data.caseId, pk) as { id: string } | undefined;
                  if (pc) {
                    const lm = db
                      .prepare(
                        "SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
                      )
                      .get(pc.id) as { content: string } | undefined;
                    if (lm) pf += `=== ${pa?.name} ===\n${lm.content}\n\n`;
                  }
                }
                return pf;
              };

              while (
                !isAgentIterationDone(agentKey, parsed) &&
                !shouldFinalize &&
                iteration < maxIterations
              ) {
                iteration++;

                // Fetch current conversation history for responder context
                const historyMsgs = db
                  .prepare(
                    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
                  )
                  .all(convo.id) as { role: string; content: string }[];

                emit({
                  type: "agent_progress",
                  agent: agentKey,
                  step: iteration + 1,
                  message: `Responder analysing ${agentKey} step ${parsed?.whyStep ?? parsed?.step ?? iteration}…`,
                });

                // Ask the AI responder to generate the operator answer
                const responder = await callAnswererAgent(
                  agentKey,
                  parsed,
                  chatId,
                  incidentData,
                  rcaCase.title,
                  rcaCase.asset_id,
                  historyMsgs,
                  buildPriorFindings(),
                );

                shouldFinalize = responder.proceedSignal === "finalize";
                const autoAnswer = responder.answerText;

                emit({
                  type: "agent_progress",
                  agent: agentKey,
                  step: iteration + 1,
                  message: `[${responder.confidence}] ${autoAnswer.slice(0, 80)}…`,
                });

                // Save responder answer as operator message
                db.prepare(
                  "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
                ).run(generateId(), convo.id, autoAnswer);

                if (shouldFinalize) break;

                // Build continuation prompt for the analysis agent (mirrors sendAgentMessage)
                const updatedMsgs = db
                  .prepare(
                    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
                  )
                  .all(convo.id) as { role: string; content: string }[];

                let contPrompt = "";
                if (agentKey === "five_why") {
                  contPrompt = autoAnswer;
                } else {
                  contPrompt = "Here is the conversation history for this agent session so far:\n\n";
                  for (const m of updatedMsgs) {
                    contPrompt += `[${m.role === "user" ? "Operator" : "Assistant"}]: ${m.content}\n`;
                  }
                  contPrompt += `\nOperator's new message: ${autoAnswer}\n\nPlease reply based on the history above and provide the requested analysis.`;
                }

                let nextText = await callAgentApiRaw(agentKey as AgentKey, contPrompt, chatId);
                let nextParsed: any = null;
                try {
                  nextParsed = JSON.parse(nextText);
                  nextText = JSON.stringify(nextParsed, null, 2);
                } catch {}

                db.prepare(
                  "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
                ).run(
                  generateId(),
                  convo.id,
                  nextText,
                  JSON.stringify(nextParsed ?? { text: nextText }),
                );

                parsed = nextParsed;
              }
            }

            db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
              convo.id,
            );

            // After data_collector, persist structured findings to case incident_data
            if (agentKey === "data_collector" && parsed) {
              let existingDesc = "";
              let existingAttachments: any[] = [];
              if (rcaCase.incident_data) {
                try {
                  const ex = JSON.parse(rcaCase.incident_data);
                  existingDesc = ex.description || "";
                  existingAttachments = ex.attachments || [];
                } catch {}
              }
              db.prepare("UPDATE rca_cases SET incident_data = ? WHERE id = ?").run(
                JSON.stringify({
                  description: existingDesc,
                  attachments: existingAttachments,
                  problemStatement: parsed.problemStatement || "",
                  effect: parsed.effect || "",
                  gaps: parsed.gaps || [],
                  followUps: parsed.followUps || [],
                  locked: false,
                  equipmentName: parsed.equipmentName || "",
                  location: parsed.location || "",
                  operatingConditions: parsed.operatingConditions || "",
                  timestamp: parsed.timestamp || "",
                  witnessedSymptoms: parsed.witnessedSymptoms || "",
                  maintenanceHistoryChecked: false,
                }),
                data.caseId,
              );
            }

            emit({ type: "agent_complete", agent: agentKey, name: agent.name });
          }

          emit({ type: "done", message: "Full RCA automation complete — review each agent's findings." });
        } catch (err: any) {
          emit({ type: "error", message: err.message || "Automation failed" });
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


// ─────────────────────────────────────────────────────────────────────────────
// RCA Report File Download
// ─────────────────────────────────────────────────────────────────────────────

export const downloadRcaReport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        caseId: z.string(),
        format: z.enum(["xlsx", "docx"]),
      })
      .parse(input)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    const db = getDb();

    // Load the latest assistant message from the report conversation
    const convo = db
      .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'report' AND user_id = ?")
      .get(data.caseId, userId) as { id: string } | undefined;

    if (!convo) throw new Error("No report conversation found for this case.");

    const lastMsg = db
      .prepare("SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1")
      .get(convo.id) as { content: string; raw_response: string } | undefined;

    if (!lastMsg) throw new Error("No report content found. Run the report agent first.");

    // Parse the report JSON — try content, then raw_response
    let reportJson: any = null;
    for (const src of [lastMsg.content, lastMsg.raw_response]) {
      if (!src) continue;
      try {
        const p = JSON.parse(src);
        reportJson = p.rcaReport ? p : (p.rcaReport ? p.rcaReport : p);
        if (reportJson) break;
      } catch {}
    }

    if (!reportJson) throw new Error("Could not parse report JSON from agent response.");

    // Normalise: unwrap rcaReport if nested
    const rawReport = reportJson.rcaReport || reportJson;

    // Load case metadata to fill any missing fields
    const rcaCase = db
      .prepare("SELECT title, asset_id, incident_data FROM rca_cases WHERE id = ?")
      .get(data.caseId) as { title: string; asset_id: string; incident_data: string } | undefined;

    let incidentMeta: any = {};
    if (rcaCase?.incident_data) {
      try { incidentMeta = JSON.parse(rcaCase.incident_data); } catch {}
    }

    // Build a well-formed RcaReportData object with sensible fallbacks
    const report = {
      header: {
        rcaNumber: rawReport.header?.rcaNumber || `RCA/${Date.now()}`,
        plant: rawReport.header?.plant || incidentMeta.location || "—",
        initiationDate: rawReport.header?.initiationDate || new Date().toISOString().split("T")[0],
        submissionDate: rawReport.header?.submissionDate || new Date().toISOString().split("T")[0],
        department: rawReport.header?.department || incidentMeta.department || "—",
        section: rawReport.header?.section || "—",
        z2NotificationNumber: rawReport.header?.z2NotificationNumber || "",
        zrNumber: rawReport.header?.zrNumber || "",
      },
      equipment: {
        number: rawReport.equipment?.number || rcaCase?.asset_id || "—",
        name: rawReport.equipment?.name || incidentMeta.equipmentName || rcaCase?.title || "—",
        occurrenceDateTime: rawReport.equipment?.occurrenceDateTime || incidentMeta.timestamp || "—",
        restorationDateTime: rawReport.equipment?.restorationDateTime || "—",
        productionAffectedHours: rawReport.equipment?.productionAffectedHours || "—",
        affectsProduction: rawReport.equipment?.affectsProduction || "Yes",
      },
      problemDescription: rawReport.problemDescription || reportJson.rootCause || incidentMeta.problemStatement || "—",
      immediateActions: Array.isArray(rawReport.immediateActions) ? rawReport.immediateActions : [],
      costOfFailure: {
        sparePartCost: rawReport.costOfFailure?.sparePartCost ?? 0,
        serviceCost: rawReport.costOfFailure?.serviceCost ?? 0,
        manpowerCost: rawReport.costOfFailure?.manpowerCost ?? 0,
        productionLoss: rawReport.costOfFailure?.productionLoss ?? 0,
      },
      chronologyEvents: Array.isArray(rawReport.chronologyEvents) ? rawReport.chronologyEvents : [],
      teamMembers: Array.isArray(rawReport.teamMembers) ? rawReport.teamMembers : [],
      maintenanceHistory: {
        lastPMDate: rawReport.maintenanceHistory?.lastPMDate || "—",
        lastPMObservations: rawReport.maintenanceHistory?.lastPMObservations || "—",
        cbmDate: rawReport.maintenanceHistory?.cbmDate || "—",
        cbmStatus: rawReport.maintenanceHistory?.cbmStatus || "—",
        rootCauseIdentifiableByCBM: rawReport.maintenanceHistory?.rootCauseIdentifiableByCBM || "—",
      },
      lastFailure: {
        date: rawReport.lastFailure?.date || "—",
        detail: rawReport.lastFailure?.detail || "—",
        rootCause: rawReport.lastFailure?.rootCause || "—",
      },
      fmeaExists: rawReport.fmeaExists || "NA",
      currentFailureInFMEA: rawReport.currentFailureInFMEA || "NA",
      whyWhyAnalysis: rawReport.whyWhyAnalysis || {
        problem: incidentMeta.problemStatement || "—",
        stream1: {},
        stream2: {},
      },
      rootCauses: Array.isArray(rawReport.rootCauses) ? rawReport.rootCauses : [reportJson.rootCause || "—"],
      fishboneCategories: rawReport.fishboneCategories || {},
      rootCauseCloseout: rawReport.rootCauseCloseout || { selectedCategories: [] },
      actionPlan: Array.isArray(rawReport.actionPlan)
        ? rawReport.actionPlan
        : (Array.isArray(reportJson.correctiveActionsList)
            ? reportJson.correctiveActionsList.map((a: any, idx: number) => ({
                srNo: idx + 1,
                action: a.desc || a.description || String(a),
                type: "CA",
                classification: "NA",
                responsible: a.owner || "—",
                department: "—",
                target: a.date || "—",
                status: a.status || "Pending",
              }))
            : []),
      horizontalDeployment: rawReport.horizontalDeployment || "—",
      preventiveMeasures: rawReport.preventiveMeasures || "—",
      sustainableMeasures: rawReport.sustainableMeasures || "—",
      externalInvestigationRequired: rawReport.externalInvestigationRequired || "No",
      externalTestingRequired: rawReport.externalTestingRequired || "No",
      changesRequiredInODC: rawReport.changesRequiredInODC || "No",
      changesRequiredInFMEA: rawReport.changesRequiredInFMEA || "No",
      rootCause: reportJson.rootCause,
      correctiveActionsList: reportJson.correctiveActionsList,
    };

    const { generateRcaXlsx, generateRcaDocx } = await import("./rca.report");

    if (data.format === "xlsx") {
      const buf = await generateRcaXlsx(report as any);
      // Write to temp file and return as base64 for client download
      const tmpPath = path.join("/tmp", `rca-report-${data.caseId}-${Date.now()}.xlsx`);
      fs.writeFileSync(tmpPath, buf);
      const b64 = buf.toString("base64");
      return { base64: b64, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `RCA-Report-${rcaCase?.asset_id || data.caseId}.xlsx` };
    } else {
      const buf = await generateRcaDocx(report as any);
      const b64 = buf.toString("base64");
      return { base64: b64, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `RCA-Report-${rcaCase?.asset_id || data.caseId}.docx` };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Full Pipeline Export (all 8 steps → HTML or DOCX)
// ─────────────────────────────────────────────────────────────────────────────

export const exportFullAnalysis = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z.object({ caseId: z.string(), format: z.enum(["html", "docx"]) }).parse(input)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    const db = getDb();

    const rcaCase = db
      .prepare("SELECT title, asset_id, incident_data FROM rca_cases WHERE id = ?")
      .get(data.caseId) as { title: string; asset_id: string; incident_data: string } | undefined;
    if (!rcaCase) throw new Error("Case not found");

    /** Fetch last assistant message JSON from an agent's conversation */
    const getAgentData = (agentKey: string): any => {
      const convo = db
        .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?")
        .get(data.caseId, agentKey, userId) as { id: string } | undefined;
      if (!convo) return null;
      const msg = db
        .prepare("SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1")
        .get(convo.id) as { content: string; raw_response: string } | undefined;
      if (!msg) return null;
      for (const src of [msg.content, msg.raw_response]) {
        if (!src) continue;
        try { return JSON.parse(src); } catch {}
      }
      return { text: msg.content };
    };

    /** Fetch ALL assistant messages from a conversation (for multi-turn agents) */
    const getAllMessages = (agentKey: string): Array<{ role: string; content: string; parsed: any }> => {
      const convo = db
        .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?")
        .get(data.caseId, agentKey, userId) as { id: string } | undefined;
      if (!convo) return [];
      const msgs = db
        .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(convo.id) as Array<{ role: string; content: string }>;
      return msgs.map((m) => {
        let parsed: any = null;
        try { parsed = JSON.parse(m.content); } catch {}
        return { ...m, parsed };
      });
    };

    const collectorData = getAgentData("data_collector") || {};
    // Supplement collector with incident_data fields
    if (rcaCase.incident_data) {
      try {
        const inc = JSON.parse(rcaCase.incident_data);
        for (const key of ["problemStatement", "effect", "equipmentName", "location", "operatingConditions", "timestamp", "witnessedSymptoms", "gaps", "followUps"]) {
          if (!collectorData[key] && inc[key]) collectorData[key] = inc[key];
        }
      } catch {}
    }

    const allData = {
      caseTitle: rcaCase.title,
      assetId: rcaCase.asset_id,
      generatedAt: new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" }),
      collector: collectorData,
      fiveWhy: { messages: getAllMessages("five_why") },
      fishbone: getAgentData("fishbone") || {},
      faultTree: getAgentData("fault_tree") || {},
      pareto: getAgentData("pareto") || {},
      timeline: getAgentData("timeline") || {},
      equipment: getAgentData("equipment") || {},
      report: getAgentData("report") || {},
    };

    const { generateFullAnalysisHtml, generateFullAnalysisDocx } = await import("./rca.export");

    if (data.format === "html") {
      const html = generateFullAnalysisHtml(allData as any);
      const b64 = Buffer.from(html, "utf-8").toString("base64");
      return { base64: b64, mimeType: "text/html", filename: `RCA-Full-Analysis-${rcaCase.asset_id || data.caseId}.html` };
    } else {
      const buf = await generateFullAnalysisDocx(allData as any);
      const b64 = buf.toString("base64");
      return { base64: b64, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `RCA-Full-Analysis-${rcaCase.asset_id || data.caseId}.docx` };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Get combined data from all agents for the report step
// ─────────────────────────────────────────────────────────────────────────────

export const getCombinedAnalysis = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    const db = getDb();

    const rcaCase = db
      .prepare("SELECT title, asset_id, incident_data FROM rca_cases WHERE id = ?")
      .get(data.caseId) as { title: string; asset_id: string; incident_data: string } | undefined;

    if (!rcaCase) throw new Error("Case not found");

    const getAgentLastMsg = (agentKey: string): any => {
      const convo = db
        .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?")
        .get(data.caseId, agentKey, userId) as { id: string } | undefined;
      if (!convo) return null;
      const msg = db
        .prepare(
          "SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .get(convo.id) as { content: string; raw_response: string } | undefined;
      if (!msg) return null;
      for (const src of [msg.content, msg.raw_response]) {
        if (!src) continue;
        try { return JSON.parse(src); } catch {}
      }
      return { text: msg.content };
    };

    const getAllMsgs = (agentKey: string) => {
      const convo = db
        .prepare("SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?")
        .get(data.caseId, agentKey, userId) as { id: string } | undefined;
      if (!convo) return [];
      const msgs = db
        .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(convo.id) as Array<{ role: string; content: string }>;
      return msgs.map((m) => {
        let parsed: any = null;
        try { parsed = JSON.parse(m.content); } catch {}
        return { role: m.role, content: m.content, parsed };
      });
    };

    const collector = getAgentLastMsg("data_collector") || {};
    // Fill missing collector fields from incident_data
    if (rcaCase.incident_data) {
      try {
        const inc = JSON.parse(rcaCase.incident_data);
        for (const k of ["problemStatement","effect","equipmentName","location","operatingConditions","timestamp","witnessedSymptoms","gaps","followUps"]) {
          if (!collector[k] && inc[k]) collector[k] = inc[k];
        }
      } catch {}
    }

    return {
      caseTitle: rcaCase.title,
      assetId: rcaCase.asset_id || "",
      collector,
      fiveWhyMessages: getAllMsgs("five_why"),
      fishbone: getAgentLastMsg("fishbone") || {},
      faultTree: getAgentLastMsg("fault_tree") || {},
      pareto: getAgentLastMsg("pareto") || {},
      timeline: getAgentLastMsg("timeline") || {},
      equipment: getAgentLastMsg("equipment") || {},
      report: getAgentLastMsg("report") || {},
    };
  });
