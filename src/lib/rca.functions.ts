import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { query, queryOne, execute, generateId, initializeSchema } from "@/lib/database";
import { getAgentApiBase, AGENT_BY_KEY, RESPONDER_AGENT_ID, type AgentKey } from "@/lib/agents";
import fs from "fs";
import path from "path";

const AGENT_KEYS = [
  "data_collector",
  "timeline",
  "equipment",
  "five_why",
  "fishbone",
  "fault_tree",
  "pareto",
  "report",
] as const;

// ─── Internal helpers ────────────────────────────────────────────────────────

// Extract the FIRST complete, balanced JSON object/array from a string.
// Forjinn agents sometimes emit the same JSON object twice (`{...}{...}`) or wrap it
// in markdown / prose; taking first-brace→last-brace then yields invalid JSON. This
// scans brace depth (string/escape aware) and returns just the first complete value.
function extractFirstJsonString(text: string): string | null {
  if (!text) return null;
  // Strip a leading ```json / ``` fence if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const src = fence && fence[1] ? fence[1] : text;
  const objStart = src.indexOf("{");
  const arrStart = src.indexOf("[");
  let start = -1;
  let open = "{";
  let close = "}";
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    start = objStart;
  } else if (arrStart !== -1) {
    start = arrStart;
    open = "[";
    close = "]";
  }
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

async function callAgentApiRaw(
  agentKey: AgentKey,
  prompt: string,
  chatId: string,
  onToken?: (accumulated: string) => void,
): Promise<string> {
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
        if (token) {
          fullText += token;
          onToken?.(fullText);
        }
      } catch {}
    }
  }

  if (!hasTokens && fullRaw) {
    try {
      const json = JSON.parse(fullRaw);
      fullText = json.text || json.answer || json.output || JSON.stringify(json);
      onToken?.(fullText);
    } catch {}
  }

  // Agents occasionally emit the JSON object twice / with surrounding prose.
  // Return just the first complete JSON value so downstream JSON.parse succeeds.
  const firstJson = extractFirstJsonString(fullText);
  return firstJson ?? fullText;
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
  is_public: number;
  public_slug: string | null;
  created_at: string;
  updated_at: string;
}

async function isCaseAccessible(
  caseId: string,
  userId: string,
  userRole: string,
): Promise<boolean> {
  const row = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM rca_cases WHERE id = ?",
    [caseId],
  );
  if (!row) return false;
  if (row.user_id === userId || userRole === "admin") return true;
  const collab = await queryOne(
    "SELECT id FROM case_collaborators WHERE case_id = ? AND user_id = ?",
    [caseId, userId],
  );
  return !!collab;
}

function generatePublicSlug(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 14; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── Data-only question builders ──────────────────────────────────────────────
// The agents' system prompts (role, rules, JSON schema) are configured on the
// Forjinn side. The functions below build ONLY the dynamic incident/findings
// content for the API `question` field — no role text, no schema, no instructions.

interface IncidentFields {
  title: string;
  assetId: string;
  description: string;
  attachments: string;
  problemStatement: string;
  effect: string;
  equipmentName: string;
  location: string;
  operatingConditions: string;
  timestamp: string;
  witnessedSymptoms: string;
  gaps: string[];
  followUps: string[];
  hasPreAnalysis: boolean;
}

function parseIncidentFields(rcaCase: CaseRow): IncidentFields {
  const f: IncidentFields = {
    title: rcaCase.title,
    assetId: rcaCase.asset_id || "",
    description: "",
    attachments: "",
    problemStatement: "",
    effect: "",
    equipmentName: "",
    location: "",
    operatingConditions: "",
    timestamp: "",
    witnessedSymptoms: "",
    gaps: [],
    followUps: [],
    hasPreAnalysis: false,
  };
  if (rcaCase.incident_data) {
    try {
      const pd = JSON.parse(rcaCase.incident_data);
      f.description = pd.description || "";
      if (Array.isArray(pd.attachments)) {
        f.attachments = pd.attachments.map((a: any) => `${a.filename} (${a.url})`).join(", ");
      }
      f.problemStatement = pd.problemStatement || "";
      f.effect = pd.effect || "";
      f.equipmentName = pd.equipmentName || "";
      f.location = pd.location || "";
      f.operatingConditions = pd.operatingConditions || "";
      f.timestamp = pd.timestamp || "";
      f.witnessedSymptoms = pd.witnessedSymptoms || "";
      f.gaps = Array.isArray(pd.gaps) ? pd.gaps : [];
      f.followUps = Array.isArray(pd.followUps) ? pd.followUps : [];
    } catch {
      f.description = rcaCase.incident_data;
    }
  }
  f.hasPreAnalysis = !!(f.problemStatement || f.equipmentName || f.location);
  return f;
}

function buildDataCollectorQuestion(rcaCase: CaseRow): string {
  const f = parseIncidentFields(rcaCase);
  if (f.hasPreAnalysis) {
    const lines = [
      "PRE-ANALYZED DATA (already extracted from incident documents — carry these forward exactly, only override if clearly incorrect):",
      `Problem Statement: ${f.problemStatement || "Not extracted"}`,
      `Operational Effect: ${f.effect || "Not extracted"}`,
      `Equipment Tag / Name: ${f.equipmentName || "Unknown"}`,
      `Location / Process Unit: ${f.location || "Unknown"}`,
      `Operating Conditions at Failure: ${f.operatingConditions || "Unknown"}`,
      `Failure Timestamp: ${f.timestamp || "Unknown"}`,
      `Witnessed Symptoms: ${f.witnessedSymptoms || "Unknown"}`,
    ];
    if (f.gaps.length) lines.push(`Previously Identified Gaps:\n${f.gaps.map((g) => `- ${g}`).join("\n")}`);
    if (f.followUps.length) lines.push(`Previously Suggested Follow-Ups:\n${f.followUps.map((x) => `- ${x}`).join("\n")}`);
    if (f.description) lines.push(`\nAdditional Raw Description: ${f.description}`);
    if (f.attachments) lines.push(`Attachments: ${f.attachments}`);
    lines.push("\nValidate these pre-analyzed fields and identify any remaining gaps.");
    return lines.join("\n");
  }
  return [
    `Incident Title: ${f.title}`,
    f.assetId ? `Asset Identifier: ${f.assetId}` : "",
    f.description ? `Incident Description: ${f.description}` : "",
    f.attachments ? `Attachments: ${f.attachments}` : "",
    "",
    "Analyze this incident and produce the structured JSON response.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function buildFiveWhyQuestion(
  caseId: string,
  rcaCase: CaseRow,
): Promise<string> {
  const f = parseIncidentFields(rcaCase);
  const tlMsg = await queryOne<{ content: string }>(
    `SELECT m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'timeline' AND m.role = 'assistant'
     ORDER BY m.created_at DESC LIMIT 1`,
    [caseId],
  );
  const eqMsg = await queryOne<{ content: string }>(
    `SELECT m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'equipment' AND m.role = 'assistant'
     ORDER BY m.created_at DESC LIMIT 1`,
    [caseId],
  );
  return [
    `Problem Statement: ${f.problemStatement || f.description}`,
    `Operational Effect: ${f.effect}`,
    `Equipment: ${f.equipmentName}`,
    `Location: ${f.location}`,
    `Operating Conditions: ${f.operatingConditions}`,
    `Failure Timestamp: ${f.timestamp}`,
    `Witnessed Symptoms: ${f.witnessedSymptoms}`,
    tlMsg?.content ? `\nTimeline Analysis:\n${tlMsg.content}` : "",
    eqMsg?.content ? `\nEquipment Analysis:\n${eqMsg.content}` : "",
    "",
    // NOTE: the literal phrase "START FRESH 5 WHY ANALYSIS" is a marker the UI greps for
    // to anchor a fresh 5-Why session in the message history. Do not reword it.
    "START FRESH 5 WHY ANALYSIS. Generate only WHY STEP 1 — the first question.",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

async function buildFishboneQuestion(
  caseId: string,
  rcaCase: CaseRow,
  fiveWhySummary: string,
): Promise<string> {
  const f = parseIncidentFields(rcaCase);
  const tlMsg = await queryOne<{ content: string }>(
    `SELECT m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'timeline' AND m.role = 'assistant'
     ORDER BY m.created_at DESC LIMIT 1`,
    [caseId],
  );
  const eqMsg = await queryOne<{ content: string }>(
    `SELECT m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'equipment' AND m.role = 'assistant'
     ORDER BY m.created_at DESC LIMIT 1`,
    [caseId],
  );
  return [
    `Incident Title: ${f.title}`,
    `Problem Statement: ${f.problemStatement || f.description}`,
    `Operational Effect: ${f.effect}`,
    `Equipment: ${f.equipmentName}`,
    `Location: ${f.location}`,
    `Operating Conditions: ${f.operatingConditions}`,
    `Failure Timestamp: ${f.timestamp}`,
    `Witnessed Symptoms: ${f.witnessedSymptoms}`,
    tlMsg?.content ? `\nTimeline Analysis:\n${tlMsg.content}` : "",
    eqMsg?.content ? `\nEquipment Analysis:\n${eqMsg.content}` : "",
    "",
    `Preceding 5-Why Findings:\n${fiveWhySummary || "(none yet)"}`,
    "",
    "Begin with STEP 1.",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

// Build prompt for the Timeline agent (runs right after data_collector).
// Uses the full Q&A from data_collector plus all incident fields from the case.
async function buildTimelineQuestion(
  caseId: string,
  rcaCase: CaseRow,
): Promise<string> {
  const f = parseIncidentFields(rcaCase);
  const dcMsgs = await query<{ role: string; content: string }>(
    `SELECT m.role, m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'data_collector'
     ORDER BY m.created_at ASC`,
    [caseId],
  );
  const parts = [
    "INCIDENT DATA:",
    `Problem Statement: ${f.problemStatement || f.description || "(not recorded)"}`,
    `Equipment: ${f.equipmentName || "(not recorded)"}`,
    `Location: ${f.location || "(not recorded)"}`,
    `Failure Timestamp: ${f.timestamp || "(not recorded)"}`,
    `Operating Conditions: ${f.operatingConditions || "(not recorded)"}`,
    `Witnessed Symptoms: ${f.witnessedSymptoms || "(not recorded)"}`,
    `Operational Effect: ${f.effect || "(not recorded)"}`,
  ];
  if (f.attachments) parts.push(`Attached Documents: ${f.attachments}`);
  if (f.followUps.length)
    parts.push(
      `\nSuggested Investigative Follow-ups:\n${f.followUps.map((x) => `- ${x}`).join("\n")}`,
    );
  const realMsgs = dcMsgs.filter(
    (m) => m.content && m.content !== "[Auto-Pipeline Hypothesis Generation Request]",
  );
  if (realMsgs.length) {
    parts.push("\nDATA COLLECTION Q&A (operator-confirmed findings):");
    for (const m of realMsgs)
      parts.push(`[${m.role === "user" ? "Operator" : "Data Collector"}]: ${m.content}`);
  }
  parts.push(`
TASK: Reconstruct the precise incident timeline.
STRICT RULES:
- Include ONLY events documented above — timestamps, symptoms, operator observations, facts from the Q&A.
- If a specific clock time is not documented, use relative terms ("Shortly before failure", "At time of failure") — never invent clock times.
- Do NOT invent events, sequences, or timestamps not evidenced in the data above.
- If an event's timing is estimated, flag it explicitly as "Estimated".
- If insufficient data exists for a timeline entry, omit it entirely rather than guess.`);
  return parts.join("\n");
}

// Build prompt for the Equipment agent (runs after timeline, before 5-Why).
async function buildEquipmentQuestion(
  caseId: string,
  rcaCase: CaseRow,
): Promise<string> {
  const f = parseIncidentFields(rcaCase);
  const dcMsg = await queryOne<{ content: string }>(
    `SELECT m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'data_collector' AND m.role = 'assistant'
     ORDER BY m.created_at DESC LIMIT 1`,
    [caseId],
  );
  const tlMsg = await queryOne<{ content: string }>(
    `SELECT m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'timeline' AND m.role = 'assistant'
     ORDER BY m.created_at DESC LIMIT 1`,
    [caseId],
  );
  const parts = [
    "INCIDENT DATA:",
    `Equipment Name/Tag: ${f.equipmentName || "(not recorded)"}`,
    `Location: ${f.location || "(not recorded)"}`,
    `Operating Conditions at Failure: ${f.operatingConditions || "(not recorded)"}`,
    `Problem Statement: ${f.problemStatement || f.description || "(not recorded)"}`,
    `Operational Effect: ${f.effect || "(not recorded)"}`,
  ];
  if (f.attachments) parts.push(`Attached Documents: ${f.attachments}`);
  if (dcMsg?.content) parts.push(`\nDATA COLLECTION FINDINGS:\n${dcMsg.content}`);
  if (tlMsg?.content) parts.push(`\nTIMELINE ANALYSIS:\n${tlMsg.content}`);
  parts.push(`
TASK: Derive reliability metrics and RPN risk scores for the equipment involved.
STRICT RULES:
- Base ALL metrics on documented data above only.
- For values not available (MTBF, MTTR, failure history), state "Not documented" — do not estimate.
- RPN scores must reference actual severity/occurrence/detection from the data; if unavailable, mark as "Estimated" and explain the basis.
- Do NOT fabricate maintenance history dates or past failure counts.`);
  return parts.join("\n");
}

const STRUCTURED_TASK_LINES: Record<string, string> = {
  fault_tree: "Using the findings above, construct the fault tree for this incident.",
  pareto: "Identify and rank all failure modes from the findings above.",
  report: `Synthesise all findings above into the complete RCA report JSON.
CRITICAL RULE — DO NOT INVENT DATA: For any field you cannot reliably determine from the analysis (e.g. SAP notification numbers, team member names, actual rupee cost figures, PM/CBM dates, last failure history), set the value to null and add an entry to the "pendingQuestions" array instead.
The "pendingQuestions" array must list every field you could not fill with real data:
  { "field": "fieldName", "label": "Human-readable field label", "hint": "What the operator should provide" }
Examples of fields that MUST go into pendingQuestions if unknown: zzNotificationNumber, zrNumber, teamMembers, costOfFailure (sparePartCost/serviceCost/manpowerCost/productionLoss), maintenanceHistory.lastPMDate, maintenanceHistory.cbmDate, lastFailure.date, lastFailure.rootCause.
Do NOT generate placeholder names like "Rahul Sharma", placeholder numbers like "ZZ-2026-001", or placeholder cost values like 15000. Leave them null and put them in pendingQuestions.`,
};

// Assemble the prior-agent findings block + the task line for a structured agent.
// Uses a direct JOIN to avoid picking an empty/wrong conversation when multiple exist,
// and takes only the last assistant message so placeholder user messages are excluded.
async function buildPriorFindingsQuestion(
  caseId: string,
  agentKey: string,
  currentIdx: number,
): Promise<string> {
  let q = "Incident findings from the preceding RCA pipeline steps:\n\n";
  for (let i = 0; i < currentIdx; i++) {
    const prevKey = AGENT_KEYS[i];
    const prevAgent = AGENT_BY_KEY[prevKey as AgentKey];
    const lastMsg = await queryOne<{ content: string }>(
      `SELECT m.content FROM messages m
       INNER JOIN conversations c ON c.id = m.conversation_id
       WHERE c.rca_case_id = ? AND c.agent_key = ? AND m.role = 'assistant'
       ORDER BY m.created_at DESC LIMIT 1`,
      [caseId, prevKey],
    );
    if (lastMsg?.content) {
      q += `=== ${prevAgent.name} ===\n${lastMsg.content}\n\n`;
    }
  }
  q += "\n" + (STRUCTURED_TASK_LINES[agentKey] || `Perform your analysis for ${AGENT_BY_KEY[agentKey as AgentKey]?.name}.`);
  return q;
}

// Build a comprehensive summary of the 5-Why chain to pass to the Fishbone agent.
// Gets all five_why messages (assistant + user) in ascending order and reconstructs each step.
async function buildFiveWhySummary(caseId: string): Promise<string> {
  const allMsgs = await query<{ role: string; content: string }>(
    `SELECT m.role, m.content FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.rca_case_id = ? AND c.agent_key = 'five_why'
     ORDER BY m.created_at ASC`,
    [caseId],
  );

  if (!allMsgs.length) return "";

  const stepSummaries: string[] = [];
  let finalRootCause = "";

  for (let i = 0; i < allMsgs.length; i++) {
    const msg = allMsgs[i];
    if (msg.role !== "assistant") continue;

    try {
      const parsed = JSON.parse(msg.content);
      if (!parsed || (!parsed.question && !parsed.whyStep)) continue;

      const stepNum = parsed.whyStep ?? stepSummaries.length + 1;
      const lines: string[] = [`WHY STEP ${stepNum}: ${parsed.question || ""}`];

      // Operator's selected cause is in the next user message
      const nextMsg = allMsgs[i + 1];
      if (nextMsg?.role === "user") {
        let answer = nextMsg.content.trim();
        // Normalize "I select cause-X: description" → just description
        if (answer.startsWith("I select ")) {
          const rest = answer.slice(9);
          const colonIdx = rest.indexOf(":");
          answer = colonIdx !== -1 ? rest.slice(colonIdx + 1).trim() : rest;
        }
        lines.push(`  Selected Cause: ${answer}`);
      }

      if (parsed.possibleCauses?.length) {
        const causeList = parsed.possibleCauses
          .map((c: any) => `    - [${c.id}] ${c.description}`)
          .join("\n");
        lines.push(`  Possible Causes Presented:\n${causeList}`);
      }

      if (parsed.operatorInstruction) {
        lines.push(`  Context / Instruction: ${parsed.operatorInstruction}`);
      }

      stepSummaries.push(lines.join("\n"));

      if (parsed.finalRootCause) finalRootCause = parsed.finalRootCause;
      if (!finalRootCause && parsed.rootCause) finalRootCause = parsed.rootCause;
    } catch {
      // skip non-JSON assistant messages
    }
  }

  if (!stepSummaries.length) return "";
  let summary = stepSummaries.join("\n\n");
  if (finalRootCause) summary += `\n\nFINAL ROOT CAUSE IDENTIFIED: ${finalRootCause}`;
  return summary;
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

    const convo = await queryOne<Pick<ConversationRow, "id" | "user_id" | "agent_key" | "session_id" | "rca_case_id">>(
      "SELECT id, user_id, agent_key, session_id, rca_case_id FROM conversations WHERE id = ?",
      [data.conversationId],
    );
    if (!convo) throw new Error("Conversation not found");
    if (convo.user_id !== userId) throw new Error("Forbidden");

    let chatId = convo.session_id;
    if (convo.agent_key !== "data_collector" && convo.rca_case_id) {
      const collector = await queryOne<{ session_id: string }>(
        "SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'",
        [convo.rca_case_id],
      );
      if (collector?.session_id) {
        chatId = collector.session_id;
      }
    }

    const agent = AGENT_BY_KEY[convo.agent_key as AgentKey];
    if (!agent) throw new Error("Unknown agent");

    // 1. Insert User Message
    const msgId = generateId();
    const attachJson = data.attachments ? JSON.stringify(data.attachments) : null;
    await execute(
      "INSERT INTO messages (id, conversation_id, role, content, attachments) VALUES (?, ?, 'user', ?, ?)",
      [msgId, data.conversationId, data.message, attachJson],
    );

    // 2. Fetch full conversation history of current agent session
    const currentMsgs = await query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
      [data.conversationId],
    );
    
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

          // Save final response in DB. Extract the first complete JSON value first
          // (agents sometimes emit the object twice or with surrounding prose).
          let parsedResponse: Record<string, any> = {};
          let assistantText = fullText || "";
          const firstJson = extractFirstJsonString(assistantText);
          if (firstJson) assistantText = firstJson;
          try {
            parsedResponse = JSON.parse(assistantText);
            assistantText = JSON.stringify(parsedResponse, null, 2);
          } catch {
            parsedResponse = { text: assistantText };
          }

          const assistantMsgId = generateId();
          await execute(
            "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
            [assistantMsgId, convo.id, assistantText, JSON.stringify(parsedResponse)],
          );

          await execute("UPDATE conversations SET updated_at = NOW() WHERE id = ?", [convo.id]);
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

    await execute(
      "INSERT INTO rca_cases (id, user_id, title, asset_id, incident_data) VALUES (?, ?, ?, ?, ?)",
      [id, userId, data.title, data.assetId ?? null, JSON.stringify(incidentDataObj)],
    );

    if (data.preAnalyzedData) {
      const convoId = generateId();
      const sessionId = generateId();
      await execute(
        "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, 'data_collector', ?, ?, 'Data Collector & Validator')",
        [convoId, userId, sessionId, id],
      );
      const userMsgId = generateId();
      await execute(
        "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
        [userMsgId, convoId, `[Auto-Pipeline Hypothesis Generation Request]`],
      );
      const assistantMsgId = generateId();
      const content = JSON.stringify(data.preAnalyzedData, null, 2);
      await execute(
        "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
        [assistantMsgId, convoId, content, content],
      );
    }
    
    const row = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [id]);
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
    const { userId, user } = context;
    if (!await isCaseAccessible(data.caseId, userId, user?.role ?? "user")) throw new Error("Forbidden");
    const existing = await queryOne<ConversationRow>(
      "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
      [data.caseId, data.agentKey, userId],
    );
    if (existing) return { conversation: existing };

    const agent = AGENT_BY_KEY[data.agentKey];
    const id = generateId();
    let sessionId = generateId();
    if (data.agentKey !== "data_collector") {
      const collector = await queryOne<{ session_id: string }>(
        "SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'",
        [data.caseId],
      );
      if (collector?.session_id) {
        sessionId = collector.session_id;
      }
    }
    await execute(
      "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)",
      [id, userId, data.agentKey, sessionId, data.caseId, agent.name],
    );
    const created = await queryOne<ConversationRow>("SELECT * FROM conversations WHERE id = ?", [id]);
    return { conversation: created };
  });

export const getCaseFull = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const rcaCase = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (!await isCaseAccessible(data.caseId, userId, user?.role ?? "user")) throw new Error("Forbidden");

    const conversations = await query<ConversationRow & { message_count: number }>(`
      SELECT c.*, COUNT(m.id) as message_count
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE c.rca_case_id = ?
      GROUP BY c.id
      ORDER BY c.created_at
    `, [data.caseId]);

    const collaborators = await query<{ id: string; user_id: string; added_at: string; full_name: string | null; email: string }>(`
      SELECT cc.id, cc.user_id, cc.added_at, u.full_name, u.email
      FROM case_collaborators cc
      JOIN users u ON u.id = cc.user_id
      WHERE cc.case_id = ?
      ORDER BY cc.added_at ASC
    `, [data.caseId]);

    const isOwner = rcaCase.user_id === userId;
    return { case: rcaCase, conversations, collaborators, isOwner };
  });

export const getConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ conversationId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const messages = await query<MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at",
      [data.conversationId],
    );
    return { messages };
  });

export const listMyCases = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const owned = await query<CaseRow & { is_collaborator: number }>(
      "SELECT *, 0 as is_collaborator FROM rca_cases WHERE user_id = ?",
      [userId],
    );
    const collaborated = await query<CaseRow & { is_collaborator: number }>(`
      SELECT r.*, 1 as is_collaborator
      FROM rca_cases r
      JOIN case_collaborators cc ON cc.case_id = r.id
      WHERE cc.user_id = ? AND r.user_id != ?
    `, [userId, userId]);
    const all = [...owned, ...collaborated].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

    const casesWithProgress = await Promise.all(all.map(async (c) => {
      const convos = await query<{ id: string; agent_key: string }>(
        "SELECT id, agent_key FROM conversations WHERE rca_case_id = ?",
        [c.id],
      );
      
      const completedAgents = new Set<string>();
      for (const conv of convos) {
        const msg = await queryOne<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?",
          [conv.id],
        );
        if (Number(msg?.cnt ?? 0) > 0) {
          completedAgents.add(conv.agent_key);
        }
      }

      let editLocked = false;
      if (c.incident_data) {
        try {
          const parsed = JSON.parse(c.incident_data);
          if (parsed.locked) editLocked = true;
        } catch {}
      }
      if (editLocked) completedAgents.add("data_collector");

      return { ...c, completed_agents: Array.from(completedAgents) };
    }));

    return { cases: casesWithProgress };
  });

export const deleteCase = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const existing = await queryOne<{ user_id: string }>(
      "SELECT user_id FROM rca_cases WHERE id = ?",
      [data.caseId],
    );
    if (!existing) throw new Error("Case not found");
    if (existing.user_id !== userId) throw new Error("Forbidden");
    await execute("DELETE FROM rca_cases WHERE id = ?", [data.caseId]);
    return { ok: true };
  });

export const clearConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ conversationId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const existing = await queryOne<{ user_id: string }>(
      "SELECT user_id FROM conversations WHERE id = ?",
      [data.conversationId],
    );
    if (!existing) throw new Error("Conversation not found");
    if (existing.user_id !== userId) throw new Error("Forbidden");
    await execute("DELETE FROM messages WHERE conversation_id = ?", [data.conversationId]);
    return { ok: true };
  });

export const truncateMessagesAfter = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z.object({ conversationId: z.string(), afterMessageId: z.string() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const conv = await queryOne<{ user_id: string }>(
      "SELECT user_id FROM conversations WHERE id = ?",
      [data.conversationId],
    );
    if (!conv) throw new Error("Conversation not found");
    if (conv.user_id !== userId) throw new Error("Forbidden");
    const msg = await queryOne<{ created_at: string }>(
      "SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?",
      [data.afterMessageId, data.conversationId],
    );
    if (!msg) throw new Error("Message not found");
    await execute(
      "DELETE FROM messages WHERE conversation_id = ? AND created_at > ?",
      [data.conversationId, msg.created_at],
    );
    return { ok: true };
  });

export const updateUserMessage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z.object({ conversationId: z.string(), messageId: z.string(), content: z.string() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const conv = await queryOne<{ user_id: string }>(
      "SELECT user_id FROM conversations WHERE id = ?",
      [data.conversationId],
    );
    if (!conv) throw new Error("Conversation not found");
    if (conv.user_id !== userId) throw new Error("Forbidden");
    const msg = await queryOne<{ id: string; role: string }>(
      "SELECT id, role FROM messages WHERE id = ? AND conversation_id = ?",
      [data.messageId, data.conversationId],
    );
    if (!msg) throw new Error("Message not found");
    if (msg.role !== "user") throw new Error("Can only edit user messages");
    await execute("UPDATE messages SET content = ? WHERE id = ?", [data.content, data.messageId]);
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
    await execute(
      "UPDATE rca_cases SET final_report = ?, status = 'completed' WHERE id = ?",
      [JSON.stringify(data.report), data.caseId],
    );
    const row = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
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

    // 1. Ensure conversation exists
    const convoRes = await queryOne<ConversationRow>(
      "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
      [data.caseId, data.agentKey, userId],
    );

    let convo: ConversationRow;
    if (convoRes) {
      convo = convoRes;
    } else {
      const agent = AGENT_BY_KEY[data.agentKey];
      const id = generateId();
      let sessionId = generateId();
      if (data.agentKey !== "data_collector") {
        const collector = await queryOne<{ session_id: string }>(
          "SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'",
          [data.caseId],
        );
        if (collector?.session_id) sessionId = collector.session_id;
      }
      await execute(
        "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)",
        [id, userId, data.agentKey, sessionId, data.caseId, agent.name],
      );
      convo = (await queryOne<ConversationRow>("SELECT * FROM conversations WHERE id = ?", [id]))!;
    }

    const agent = AGENT_BY_KEY[data.agentKey as AgentKey];
    if (!agent) throw new Error("Unknown agent");

    // 2. Build the data-only question.
    const currentIdx = AGENT_KEYS.indexOf(data.agentKey);
    let prompt = "";

    const rcaCase = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");

    if (data.agentKey === "data_collector") {
      prompt = buildDataCollectorQuestion(rcaCase);
    } else if (data.agentKey === "timeline") {
      prompt = await buildTimelineQuestion(data.caseId, rcaCase);
    } else if (data.agentKey === "equipment") {
      prompt = await buildEquipmentQuestion(data.caseId, rcaCase);
    } else if (data.agentKey === "five_why") {
      prompt = await buildFiveWhyQuestion(data.caseId, rcaCase);
    } else if (data.agentKey === "fishbone") {
      const fiveWhySummary = await buildFiveWhySummary(data.caseId);
      prompt = await buildFishboneQuestion(data.caseId, rcaCase, fiveWhySummary);
    } else {
      prompt = await buildPriorFindingsQuestion(data.caseId, data.agentKey, currentIdx);
    }

    // 3. Store system-pipeline user message in messages
    const msgId = generateId();
    const userMsgContent = (data.agentKey === "five_why" || data.agentKey === "fishbone") ? prompt : `[Auto-Pipeline Hypothesis Generation Request]`;
    await execute(
      "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
      [msgId, convo.id, userMsgContent],
    );

    // Structured single-shot agents must not inherit stale session history from prior runs.
    const STRUCTURED_AGENTS = ["timeline", "equipment", "fault_tree", "pareto", "report"];
    let chatId: string;
    if (STRUCTURED_AGENTS.includes(data.agentKey)) {
      chatId = `${convo.session_id}-${generateId()}`;
    } else if (convo.agent_key !== "data_collector" && convo.rca_case_id) {
      const collector = await queryOne<{ session_id: string }>(
        "SELECT session_id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'",
        [convo.rca_case_id],
      );
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

          // Save final response in DB. Extract the first complete JSON value
          // (handles leading prose, markdown fences, and double-emitted objects).
          let parsedResponse: Record<string, any> = {};
          let assistantText = fullText || "";
          const firstJson = extractFirstJsonString(assistantText);
          if (firstJson) assistantText = firstJson;

          try {
            parsedResponse = JSON.parse(assistantText);
            assistantText = JSON.stringify(parsedResponse, null, 2);
          } catch {
            parsedResponse = { text: assistantText };
          }

          const assistantMsgId = generateId();
          await execute(
            "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
            [assistantMsgId, convo.id, assistantText, JSON.stringify(parsedResponse)],
          );

          await execute("UPDATE conversations SET updated_at = NOW() WHERE id = ?", [convo.id]);
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

    const rcaCase = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (!await isCaseAccessible(data.caseId, userId, "user")) throw new Error("Forbidden");

    let attachments: any[] = [];
    if (rcaCase.incident_data) {
      try {
        const parsed = JSON.parse(rcaCase.incident_data);
        attachments = parsed.attachments || [];
      } catch {}
    }

    if (rcaCase.incident_data) {
      const histId = generateId();
      await execute(
        "INSERT INTO rca_edit_history (id, case_id, user_id, section, snapshot, summary) VALUES (?, ?, ?, 'incident_data', ?, ?)",
        [histId, data.caseId, userId, rcaCase.incident_data, "Updated incident details"],
      );
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

    await execute("UPDATE rca_cases SET incident_data = ? WHERE id = ?", [
      JSON.stringify(updatedIncidentObj),
      data.caseId,
    ]);

    const collectorConvo = await queryOne<{ id: string }>(
      "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'data_collector'",
      [data.caseId],
    );

    const newContentObj = {
      problemStatement: data.problemStatement,
      effect: data.effect || "",
      gaps: data.gaps || [],
      followUps: data.followUps || [],
      equipmentName: data.equipmentName || "",
      location: data.location || "",
      operatingConditions: data.operatingConditions || "",
      timestamp: data.timestamp || "",
      witnessedSymptoms: data.witnessedSymptoms || "",
      maintenanceHistoryChecked: !!data.maintenanceHistoryChecked,
    };

    const newContentStr = JSON.stringify(newContentObj, null, 2);

    if (collectorConvo) {
      const latestMsg = await queryOne<{ id: string }>(
        "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        [collectorConvo.id],
      );
      if (latestMsg) {
        await execute("UPDATE messages SET content = ?, raw_response = ? WHERE id = ?", [
          newContentStr, JSON.stringify(newContentObj), latestMsg.id,
        ]);
      } else {
        const msgId = generateId();
        await execute(
          "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
          [msgId, collectorConvo.id, newContentStr, JSON.stringify(newContentObj)],
        );
      }
    } else {
      const convoId = generateId();
      const sessionId = generateId();
      await execute(
        "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, 'data_collector', ?, ?, 'Data Collector & Validator')",
        [convoId, userId, sessionId, data.caseId],
      );
      const msgId = generateId();
      await execute(
        "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
        [msgId, convoId, newContentStr, JSON.stringify(newContentObj)],
      );
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
    const rawResStr = data.rawResponse ? JSON.stringify(data.rawResponse) : data.content;
    await execute("UPDATE messages SET content = ?, raw_response = ? WHERE id = ?", [
      data.content, rawResStr, data.messageId,
    ]);
    await execute("UPDATE conversations SET updated_at = NOW() WHERE id = ?", [data.conversationId]);
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
    // System prompt (role/rules/schema) is configured on the Forjinn data_collector agent.
    // Send incident data only.
    prompt += `\nAnalyze this incident and produce the structured JSON response.`;

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

    const rcaCase = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
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
            let convo = await queryOne<ConversationRow>(
              "SELECT * FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
              [data.caseId, agentKey, userId],
            );

            if (!convo) {
              const convoId = generateId();
              let sessionId = generateId();
              if (agentKey !== "data_collector" && collectorSessionId) {
                sessionId = collectorSessionId;
              }
              await execute(
                "INSERT INTO conversations (id, user_id, agent_key, session_id, rca_case_id, title) VALUES (?, ?, ?, ?, ?, ?)",
                [convoId, userId, agentKey, sessionId, data.caseId, agent.name],
              );
              convo = (await queryOne<ConversationRow>("SELECT * FROM conversations WHERE id = ?", [convoId]))!;
            }

            if (agentKey === "data_collector") collectorSessionId = convo.session_id;
            // Structured single-shot agents get a fresh chatId to avoid stale session contamination.
            const STRUCTURED_AGENTS_FA = ["timeline", "equipment", "fault_tree", "pareto", "report"];
            const chatId = STRUCTURED_AGENTS_FA.includes(agentKey)
              ? `${convo.session_id}-${generateId()}`
              : (collectorSessionId ?? convo.session_id);

            const existingCountRow = await queryOne<{ cnt: number }>(
              "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?",
              [convo.id],
            );
            const existingCount = Number(existingCountRow?.cnt ?? 0);

            if (existingCount > 0) {
              emit({ type: "agent_skip", agent: agentKey, message: "Already analysed — skipping" });
              continue;
            }

            // Build the data-only question. System prompts (role/rules/schema) live on Forjinn.
            const currentIdx = AGENT_KEYS.indexOf(agentKey as (typeof AGENT_KEYS)[number]);
            let prompt = "";

            if (agentKey === "data_collector") {
              prompt = buildDataCollectorQuestion(rcaCase);
            } else if (agentKey === "timeline") {
              prompt = await buildTimelineQuestion(data.caseId, rcaCase);
            } else if (agentKey === "equipment") {
              prompt = await buildEquipmentQuestion(data.caseId, rcaCase);
            } else if (agentKey === "five_why") {
              prompt = await buildFiveWhyQuestion(data.caseId, rcaCase);
            } else if (agentKey === "fishbone") {
              const fiveWhySummary = await buildFiveWhySummary(data.caseId);
              prompt = await buildFishboneQuestion(data.caseId, rcaCase, fiveWhySummary);
            } else {
              prompt = await buildPriorFindingsQuestion(data.caseId, agentKey, currentIdx);
            }

            await execute(
              "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
              [
                generateId(),
                convo.id,
                agentKey === "five_why" || agentKey === "fishbone"
                  ? prompt
                  : "[Auto-Pipeline Hypothesis Generation Request]",
              ],
            );

            emit({ type: "agent_progress", agent: agentKey, step: 1, message: "Calling agent API…" });

            // Stream tokens to the UI in throttled batches so the live JSON renders as it arrives.
            let lastEmitLen = 0;
            const emitToken = (accumulated: string) => {
              if (accumulated.length - lastEmitLen >= 40) {
                lastEmitLen = accumulated.length;
                emit({ type: "agent_token", agent: agentKey, step: 1, text: accumulated });
              }
            };

            let responseText = await callAgentApiRaw(agentKey as AgentKey, prompt, chatId, emitToken);
            emit({ type: "agent_token", agent: agentKey, step: 1, text: responseText });

            const tryParse = (txt: string): { parsed: any; err: string } => {
              let t = txt;
              if (STRUCTURED_AGENTS_FA.includes(agentKey)) {
                const js = t.indexOf("{");
                if (js > 0) t = t.slice(js);
              }
              try { return { parsed: JSON.parse(t), err: "" }; }
              catch (e: any) { return { parsed: null, err: e?.message || "invalid JSON" }; }
            };

            let { parsed, err: parseErr } = tryParse(responseText);
            // On parse failure, push the error back to the agent and ask for corrected JSON.
            for (let fixAttempt = 0; !parsed && fixAttempt < 2; fixAttempt++) {
              emit({ type: "agent_progress", agent: agentKey, step: 1, message: `Response wasn't valid JSON — asking agent to correct (try ${fixAttempt + 1})…` });
              const fixPrompt = `Your previous response could not be parsed as JSON (error: ${parseErr}). Respond ONLY with a single valid JSON object — no markdown, no code fences, no prose before or after. Re-send the same analysis as strictly valid JSON.`;
              try {
                responseText = await callAgentApiRaw(agentKey as AgentKey, fixPrompt, chatId, emitToken);
              } catch (e: any) {
                parseErr = e?.message || "agent call failed";
                break;
              }
              emit({ type: "agent_token", agent: agentKey, step: 1, text: responseText });
              ({ parsed, err: parseErr } = tryParse(responseText));
            }

            if (parsed) {
              responseText = JSON.stringify(parsed, null, 2);
            } else {
              emit({ type: "agent_progress", agent: agentKey, step: 1, message: `Could not obtain valid JSON after retries — saving raw text.` });
            }

            await execute(
              "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
              [
                generateId(),
                convo.id,
                responseText,
                JSON.stringify(parsed ?? { text: responseText }),
              ],
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
              const buildPriorFindings = async () => {
                let pf = "";
                for (let i = 0; i < currentIdx; i++) {
                  const pk = AGENT_KEYS[i];
                  const pa = AGENT_BY_KEY[pk as AgentKey];
                  const lm = await queryOne<{ content: string }>(
                    `SELECT m.content FROM messages m
                     INNER JOIN conversations c ON c.id = m.conversation_id
                     WHERE c.rca_case_id = ? AND c.agent_key = ? AND m.role = 'assistant'
                     ORDER BY m.created_at DESC LIMIT 1`,
                    [data.caseId, pk],
                  );
                  if (lm?.content) pf += `=== ${pa?.name} ===\n${lm.content}\n\n`;
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
                const historyMsgs = await query<{ role: string; content: string }>(
                  "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
                  [convo.id],
                );

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
                  await buildPriorFindings(),
                );

                shouldFinalize = responder.proceedSignal === "finalize";
                const autoAnswer = responder.answerText;

                emit({
                  type: "agent_progress",
                  agent: agentKey,
                  step: iteration + 1,
                  message: `[${responder.confidence}] ${autoAnswer.slice(0, 80)}…`,
                });

                await execute(
                  "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
                  [generateId(), convo.id, autoAnswer],
                );

                if (shouldFinalize) break;

                // Continuation = operator's answer only. Forjinn session memory (keyed by
                // chatId) carries the prior turns, so we no longer re-paste history.
                const contPrompt = autoAnswer;

                let lastContEmitLen = 0;
                const emitContToken = (accumulated: string) => {
                  if (accumulated.length - lastContEmitLen >= 40) {
                    lastContEmitLen = accumulated.length;
                    emit({ type: "agent_token", agent: agentKey, step: iteration + 1, text: accumulated });
                  }
                };

                let nextText = await callAgentApiRaw(agentKey as AgentKey, contPrompt, chatId, emitContToken);
                emit({ type: "agent_token", agent: agentKey, step: iteration + 1, text: nextText });
                let nextParsed: any = null;
                try {
                  nextParsed = JSON.parse(nextText);
                  nextText = JSON.stringify(nextParsed, null, 2);
                } catch {}

                await execute(
                  "INSERT INTO messages (id, conversation_id, role, content, raw_response) VALUES (?, ?, 'assistant', ?, ?)",
                  [
                    generateId(),
                    convo.id,
                    nextText,
                    JSON.stringify(nextParsed ?? { text: nextText }),
                  ],
                );

                parsed = nextParsed;
              }
            }

            await execute("UPDATE conversations SET updated_at = NOW() WHERE id = ?", [convo.id]);

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
              await execute("UPDATE rca_cases SET incident_data = ? WHERE id = ?", [
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
              ]);
            }

            emit({ type: "agent_complete", agent: agentKey, name: agent.name });
          }

          // Persist the report agent's output to final_report and mark case completed
          const reportConvo = await queryOne<{ id: string }>(
            "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'report' AND user_id = ?",
            [data.caseId, userId],
          );
          if (reportConvo) {
            const reportMsg = await queryOne<{ content: string; raw_response: string }>(
              "SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
              [reportConvo.id],
            );
            if (reportMsg) {
              let reportParsed: any = null;
              for (const src of [reportMsg.raw_response, reportMsg.content]) {
                if (!src) continue;
                try { reportParsed = JSON.parse(src); break; } catch {}
              }
              if (reportParsed) {
                await execute("UPDATE rca_cases SET final_report = ?, status = 'completed' WHERE id = ?", [
                  JSON.stringify(reportParsed), data.caseId,
                ]);
              }
            }
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

/**
 * Build the canonical HZL report model for a case from the report agent's
 * rcaReport output (+ incident_data), and load the first image attachment.
 * Single source of truth for all export formats.
 */
async function buildCaseReport(caseId: string, userId: string) {
  let reportJson: any = null;

  // If userId is provided, try the specific user's conversation first
  if (userId) {
    const convo = await queryOne<{ id: string }>(
      "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'report' AND user_id = ?",
      [caseId, userId],
    );
    if (convo) {
      const lastMsg = await queryOne<{ content: string; raw_response: string }>(
        "SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        [convo.id],
      );
      if (lastMsg) {
        for (const src of [lastMsg.content, lastMsg.raw_response]) {
          if (!src) continue;
          const j = extractFirstJsonString(src) ?? src;
          try { reportJson = JSON.parse(j); break; } catch {}
        }
      }
    }
  }

  // Fall back to any report conversation for this case (for public downloads or when user has no convo)
  if (!reportJson) {
    const anyConvo = await queryOne<{ id: string }>(
      "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = 'report' ORDER BY created_at DESC LIMIT 1",
      [caseId],
    );
    if (anyConvo) {
      const lastMsg = await queryOne<{ content: string; raw_response: string }>(
        "SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        [anyConvo.id],
      );
      if (lastMsg) {
        for (const src of [lastMsg.content, lastMsg.raw_response]) {
          if (!src) continue;
          const j = extractFirstJsonString(src) ?? src;
          try { reportJson = JSON.parse(j); break; } catch {}
        }
      }
    }
  }

  // Last resort: use final_report stored on the case
  if (!reportJson) {
    const caseRow = await queryOne<{ final_report: string | null }>(
      "SELECT final_report FROM rca_cases WHERE id = ?",
      [caseId],
    );
    if (caseRow?.final_report) {
      try { reportJson = JSON.parse(caseRow.final_report); } catch {}
    }
  }

  const rcaCase = await queryOne<{ title: string; asset_id: string | null; incident_data: string | null }>(
    "SELECT title, asset_id, incident_data FROM rca_cases WHERE id = ?",
    [caseId],
  );

  let incidentMeta: any = {};
  if (rcaCase?.incident_data) {
    try { incidentMeta = JSON.parse(rcaCase.incident_data); } catch {}
  }

  const { normalizeReport } = await import("./rca.report");
  const report = normalizeReport(
    reportJson || {},
    incidentMeta,
    rcaCase ? { title: rcaCase.title, asset_id: rcaCase.asset_id ?? undefined } : undefined,
  );

  // Load the first image attachment for embedding.
  let image: { buffer: Buffer; extension: "png" | "jpeg" | "gif" } | undefined;
  let imageDataUri: string | undefined;
  const atts = Array.isArray(incidentMeta.attachments) ? incidentMeta.attachments : [];
  const img = atts.find((a: any) => (a.contentType || "").startsWith("image/"));
  if (img?.url) {
    try {
      const p = path.join(process.cwd(), "public", String(img.url).replace(/^\//, ""));
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        const ext = (img.contentType.includes("png") ? "png" : img.contentType.includes("gif") ? "gif" : "jpeg") as "png" | "jpeg" | "gif";
        image = { buffer: buf, extension: ext };
        imageDataUri = `data:${img.contentType};base64,${buf.toString("base64")}`;
      }
    } catch {}
  }

  return { report, image, imageDataUri, rcaCase, reportJson };
}

/** Render HTML → PDF via headless Chrome. */
async function htmlToPdf(html: string): Promise<Buffer> {
  const puppeteer = (await import("puppeteer")).default;
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  const execPath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const browser = await puppeteer.launch({
    headless: true,
    ...(execPath ? { executablePath: execPath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export const downloadRcaReport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        caseId: z.string(),
        format: z.enum(["xlsx", "docx", "pdf", "html"]),
      })
      .parse(input)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };

    const { report, image, imageDataUri, rcaCase } = await buildCaseReport(data.caseId, userId);
    const base = `RCA-Report-${rcaCase?.asset_id || data.caseId}`;
    const { generateRcaXlsx, generateRcaDocx, generateRcaHtml } = await import("./rca.report");

    if (data.format === "xlsx") {
      const buf = await generateRcaXlsx(report, image);
      return {
        base64: buf.toString("base64"),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `${base}.xlsx`,
      };
    } else if (data.format === "docx") {
      const buf = await generateRcaDocx(report, image);
      return {
        base64: buf.toString("base64"),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: `${base}.docx`,
      };
    } else if (data.format === "html") {
      const html = generateRcaHtml(report, imageDataUri);
      return {
        base64: Buffer.from(html, "utf-8").toString("base64"),
        mimeType: "text/html",
        filename: `${base}.html`,
      };
    } else {
      // pdf
      const html = generateRcaHtml(report, imageDataUri);
      const buf = await htmlToPdf(html);
      return { base64: buf.toString("base64"), mimeType: "application/pdf", filename: `${base}.pdf` };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Full Pipeline Export (all 8 steps → HTML or DOCX)
// ─────────────────────────────────────────────────────────────────────────────

export const exportFullAnalysis = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z.object({ caseId: z.string(), format: z.enum(["html", "docx", "pdf", "html-full"]) }).parse(input)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };

    // Full 8-step HTML (charts/bars/diagrams) — driven by per-agent data + normalizers.
    if (data.format === "html-full") {
      const rcaCase0 = await queryOne<{ title: string; asset_id: string | null; incident_data: string | null }>(
        "SELECT title, asset_id, incident_data FROM rca_cases WHERE id = ?",
        [data.caseId],
      );
      if (!rcaCase0) throw new Error("Case not found");

      const lastMsgJson = async (agentKey: string): Promise<any> => {
        const c = await queryOne<{ id: string }>(
          "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
          [data.caseId, agentKey, userId],
        );
        if (!c) return {};
        const m = await queryOne<{ content: string; raw_response: string }>(
          "SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
          [c.id],
        );
        if (!m) return {};
        for (const src of [m.content, m.raw_response]) {
          if (!src) continue;
          const j = extractFirstJsonString(src) ?? src;
          try { return JSON.parse(j); } catch {}
        }
        return {};
      };
      const allMsgs = async (agentKey: string): Promise<any[]> => {
        const c = await queryOne<{ id: string }>(
          "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
          [data.caseId, agentKey, userId],
        );
        if (!c) return [];
        const msgs = await query<{ role: string; content: string }>(
          "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
          [c.id],
        );
        return msgs.map((m) => {
          let parsed: any = null;
          const j = extractFirstJsonString(m.content) ?? m.content;
          try { parsed = JSON.parse(j); } catch {}
          return { role: m.role, content: m.content, parsed };
        });
      };

      const collector = await lastMsgJson("data_collector");
      let incidentMeta: any = {};
      try { incidentMeta = JSON.parse(rcaCase0.incident_data || "{}"); } catch {}
      for (const k of ["problemStatement", "effect", "equipmentName", "location", "operatingConditions", "timestamp", "witnessedSymptoms", "gaps", "followUps"]) {
        if (!collector[k] && incidentMeta[k]) collector[k] = incidentMeta[k];
      }

      const { generateFullStepsHtml } = await import("./rca.fullhtml");
      const html = generateFullStepsHtml({
        caseTitle: rcaCase0.title,
        assetId: rcaCase0.asset_id ?? undefined,
        generatedAt: new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" }),
        collector,
        fiveWhyMessages: await allMsgs("five_why"),
        fishbone: await lastMsgJson("fishbone"),
        faultTree: await lastMsgJson("fault_tree"),
        pareto: await lastMsgJson("pareto"),
        timeline: await lastMsgJson("timeline"),
        equipment: await lastMsgJson("equipment"),
        report: await lastMsgJson("report"),
      });
      return {
        base64: Buffer.from(html, "utf-8").toString("base64"),
        mimeType: "text/html",
        filename: `RCA-Full-Steps-${rcaCase0.asset_id || data.caseId}.html`,
      };
    }

    // Drive the remaining formats from the same canonical HZL report model.
    const { report, image, imageDataUri, rcaCase } = await buildCaseReport(data.caseId, userId);
    const base = `RCA-Full-Analysis-${rcaCase?.asset_id || data.caseId}`;
    const { generateRcaHtml, generateRcaDocx } = await import("./rca.report");

    if (data.format === "html") {
      const html = generateRcaHtml(report, imageDataUri);
      return { base64: Buffer.from(html, "utf-8").toString("base64"), mimeType: "text/html", filename: `${base}.html` };
    } else if (data.format === "pdf") {
      const html = generateRcaHtml(report, imageDataUri);
      const buf = await htmlToPdf(html);
      return { base64: buf.toString("base64"), mimeType: "application/pdf", filename: `${base}.pdf` };
    } else {
      const buf = await generateRcaDocx(report, image);
      return { base64: buf.toString("base64"), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `${base}.docx` };
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

    const rcaCase = await queryOne<{ title: string; asset_id: string | null; incident_data: string | null }>(
      "SELECT title, asset_id, incident_data FROM rca_cases WHERE id = ?",
      [data.caseId],
    );

    if (!rcaCase) throw new Error("Case not found");

    const getAgentLastMsg = async (agentKey: string): Promise<any> => {
      const convo = await queryOne<{ id: string }>(
        "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
        [data.caseId, agentKey, userId],
      );
      if (!convo) return null;
      const msg = await queryOne<{ content: string; raw_response: string }>(
        "SELECT content, raw_response FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        [convo.id],
      );
      if (!msg) return null;
      for (const src of [msg.content, msg.raw_response]) {
        if (!src) continue;
        const j = extractFirstJsonString(src) ?? src;
        try { return JSON.parse(j); } catch {}
      }
      return { text: msg.content };
    };

    const getAllMsgs = async (agentKey: string) => {
      const convo = await queryOne<{ id: string }>(
        "SELECT id FROM conversations WHERE rca_case_id = ? AND agent_key = ? AND user_id = ?",
        [data.caseId, agentKey, userId],
      );
      if (!convo) return [];
      const msgs = await query<{ role: string; content: string }>(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        [convo.id],
      );
      return msgs.map((m) => {
        let parsed: any = null;
        const j = extractFirstJsonString(m.content) ?? m.content;
        try { parsed = JSON.parse(j); } catch {}
        return { role: m.role, content: m.content, parsed };
      });
    };

    const collector = (await getAgentLastMsg("data_collector")) || {};
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
      fiveWhyMessages: await getAllMsgs("five_why"),
      fishbone: (await getAgentLastMsg("fishbone")) || {},
      faultTree: (await getAgentLastMsg("fault_tree")) || {},
      pareto: (await getAgentLastMsg("pareto")) || {},
      timeline: (await getAgentLastMsg("timeline")) || {},
      equipment: (await getAgentLastMsg("equipment")) || {},
      report: (await getAgentLastMsg("report")) || {},
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Public access — toggle & fetch
// ─────────────────────────────────────────────────────────────────────────────

export const toggleCasePublic = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const rcaCase = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");
    if (rcaCase.status !== "completed") throw new Error("Only completed RCAs can be made public");

    const willBePublic = !rcaCase.is_public;
    let slug = rcaCase.public_slug;
    if (willBePublic && !slug) {
      slug = generatePublicSlug();
      // Ensure uniqueness
      while (await queryOne("SELECT id FROM rca_cases WHERE public_slug = ?", [slug])) {
        slug = generatePublicSlug();
      }
    }
    await execute("UPDATE rca_cases SET is_public = ?, public_slug = ? WHERE id = ?", [
      willBePublic ? 1 : 0,
      slug,
      data.caseId,
    ]);
    return { is_public: willBePublic, public_slug: slug };
  });

export const getPublicCase = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ slug: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const rcaCase = await queryOne<CaseRow>(
      "SELECT * FROM rca_cases WHERE public_slug = ? AND is_public = 1 AND status = 'completed'",
      [data.slug],
    );
    if (!rcaCase) return null;
    return {
      id: rcaCase.id,
      title: rcaCase.title,
      asset_id: rcaCase.asset_id,
      status: rcaCase.status,
      incident_data: rcaCase.incident_data,
      final_report: rcaCase.final_report,
      created_at: rcaCase.created_at,
      updated_at: rcaCase.updated_at,
    };
  });

export const downloadPublicReport = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ slug: z.string(), format: z.enum(["xlsx", "docx", "pdf", "html"]) }).parse(input))
  .handler(async ({ data }) => {
    const row = await queryOne<{ id: string; title: string; asset_id: string | null }>(
      "SELECT id, title, asset_id FROM rca_cases WHERE public_slug = ? AND is_public = 1 AND status = 'completed'",
      [data.slug],
    );
    if (!row) throw new Error("Not found");
    const { report, image, imageDataUri } = await buildCaseReport(row.id, "");
    const base = `RCA-Report-${row.asset_id || row.id}`;
    const { generateRcaXlsx, generateRcaDocx, generateRcaHtml } = await import("./rca.report");
    if (data.format === "xlsx") {
      const buf = await generateRcaXlsx(report, image);
      return { base64: buf.toString("base64"), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${base}.xlsx` };
    } else if (data.format === "pdf") {
      const html = generateRcaHtml(report, imageDataUri);
      const buf = await htmlToPdf(html);
      return { base64: buf.toString("base64"), mimeType: "application/pdf", filename: `${base}.pdf` };
    } else if (data.format === "html") {
      const html = generateRcaHtml(report, imageDataUri);
      return { base64: Buffer.from(html, "utf-8").toString("base64"), mimeType: "text/html", filename: `${base}.html` };
    } else {
      const buf = await generateRcaDocx(report, image);
      return { base64: buf.toString("base64"), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `${base}.docx` };
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Collaborators
// ─────────────────────────────────────────────────────────────────────────────

export const listCollaborators = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    if (!await isCaseAccessible(data.caseId, userId, user?.role ?? "user")) throw new Error("Forbidden");
    const collabs = await query<any>(
      `
        SELECT cc.id, cc.user_id, cc.added_at, u.full_name, u.email
        FROM case_collaborators cc
        JOIN users u ON u.id = cc.user_id
        WHERE cc.case_id = ?
        ORDER BY cc.added_at ASC
      `,
      [data.caseId],
    );
    return { collaborators: collabs };
  });

export const listUsersForCollaboration = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const rcaCase = await queryOne<{ user_id: string }>("SELECT user_id FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");

    // Accepted users (have accounts), excluding case owner and existing collaborators
    const accepted = await query<any>(
      `
        SELECT u.id, u.email, u.full_name
        FROM users u
        WHERE u.id != ?
          AND u.id NOT IN (SELECT user_id FROM case_collaborators WHERE case_id = ?)
        ORDER BY u.full_name, u.email
      `,
      [rcaCase.user_id, data.caseId],
    );

    // Pending invites (email-specific, not yet used)
    const invited = await query<any>(
      `
        SELECT code, email, created_at, expires_at
        FROM invites
        WHERE used_at IS NULL
          AND expires_at > NOW()
          AND email IS NOT NULL
        ORDER BY created_at DESC
      `,
    );

    return { accepted, invited };
  });

export const addCollaborator = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string(), targetUserId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const rcaCase = await queryOne<{ user_id: string }>("SELECT user_id FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");
    if (data.targetUserId === rcaCase.user_id) throw new Error("Owner is already the case owner");

    const targetUser = await queryOne<{ id: string; email: string; full_name: string | null }>(
      "SELECT id, email, full_name FROM users WHERE id = ?",
      [data.targetUserId],
    );
    if (!targetUser) throw new Error("User not found");

    try {
      const id = generateId();
      await execute(
        "INSERT INTO case_collaborators (id, case_id, user_id, added_by) VALUES (?, ?, ?, ?)",
        [id, data.caseId, data.targetUserId, userId],
      );
    } catch {
      // UNIQUE constraint — already a collaborator, silently ignore
    }

    const collabs = await query<any>(
      `
        SELECT cc.id, cc.user_id, cc.added_at, u.full_name, u.email
        FROM case_collaborators cc
        JOIN users u ON u.id = cc.user_id
        WHERE cc.case_id = ?
        ORDER BY cc.added_at ASC
      `,
      [data.caseId],
    );
    return { collaborators: collabs };
  });

export const removeCollaborator = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string(), collaboratorUserId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const rcaCase = await queryOne<{ user_id: string }>("SELECT user_id FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");
    await execute("DELETE FROM case_collaborators WHERE case_id = ? AND user_id = ?", [data.caseId, data.collaboratorUserId]);
    return { ok: true };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Edit history
// ─────────────────────────────────────────────────────────────────────────────

export const getEditHistory = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    if (!await isCaseAccessible(data.caseId, userId, user?.role ?? "user")) throw new Error("Forbidden");
    const history = await query<any>(
      `
        SELECT h.id, h.case_id, h.user_id, h.section, h.summary, h.changed_at,
               u.full_name, u.email
        FROM rca_edit_history h
        JOIN users u ON u.id = h.user_id
        WHERE h.case_id = ?
        ORDER BY h.changed_at DESC
        LIMIT 100
      `,
      [data.caseId],
    );
    return { history };
  });

export const revertEditVersion = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string(), historyId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, user } = context;
    const rcaCase = await queryOne<CaseRow>("SELECT * FROM rca_cases WHERE id = ?", [data.caseId]);
    if (!rcaCase) throw new Error("Case not found");
    if (rcaCase.user_id !== userId && user?.role !== "admin") throw new Error("Forbidden");

    const histEntry = await queryOne<{ section: string; snapshot: string | null }>(
      "SELECT section, snapshot FROM rca_edit_history WHERE id = ? AND case_id = ?",
      [data.historyId, data.caseId],
    );
    if (!histEntry || !histEntry.snapshot) throw new Error("History entry not found or has no snapshot");

    if (histEntry.section === "incident_data") {
      // Save current state as a new history entry first
      if (rcaCase.incident_data) {
        const newHistId = generateId();
        await execute(
          "INSERT INTO rca_edit_history (id, case_id, user_id, section, snapshot, summary) VALUES (?, ?, ?, 'incident_data', ?, ?)",
          [newHistId, data.caseId, userId, rcaCase.incident_data, "Reverted to earlier version"],
        );
      }
      await execute("UPDATE rca_cases SET incident_data = ? WHERE id = ?", [histEntry.snapshot, data.caseId]);
    }
    return { ok: true };
  });
