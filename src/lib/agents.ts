export type AgentKey =
  | "data_collector"
  | "five_why"
  | "fishbone"
  | "fault_tree"
  | "pareto"
  | "timeline"
  | "equipment"
  | "report";

export interface AgentDef {
  key: AgentKey;
  id: string;
  name: string;
  shortName: string;
  description: string;
  order: number;
}

export function getAgentApiBase(): string {
  return process.env.AGENT_API_BASE_URL || "https://forjinn.innosynth.org/api/v1/prediction";
}

export const AGENTS: AgentDef[] = [
  {
    key: "data_collector",
    id: process.env.AGENT_ID_DATA_COLLECTOR || "",
    name: "Data Collector & Validator",
    shortName: "Collector",
    description: "Validates incident data, identifies gaps, asks follow-ups",
    order: 1,
  },
  {
    key: "five_why",
    id: process.env.AGENT_ID_FIVE_WHY || "",
    name: "5 Why Analysis",
    shortName: "5 Why",
    description: "Structured 5-Why root cause with evidence",
    order: 2,
  },
  {
    key: "fishbone",
    id: process.env.AGENT_ID_FISHBONE || "",
    name: "Fishbone (Ishikawa)",
    shortName: "Fishbone",
    description: "6M cause categories diagram",
    order: 3,
  },
  {
    key: "fault_tree",
    id: process.env.AGENT_ID_FAULT_TREE || "",
    name: "Fault Tree Analysis",
    shortName: "FTA",
    description: "Boolean logic FTA, minimal cut sets, probabilities",
    order: 4,
  },
  {
    key: "pareto",
    id: process.env.AGENT_ID_PARETO || "",
    name: "Pareto & Trend",
    shortName: "Pareto",
    description: "Pareto, trend, SPC, clustering",
    order: 5,
  },
  {
    key: "timeline",
    id: process.env.AGENT_ID_TIMELINE || "",
    name: "Timeline & Event Correlation",
    shortName: "Timeline",
    description: "Event sequencing, deviation, correlation",
    order: 6,
  },
  {
    key: "equipment",
    id: process.env.AGENT_ID_EQUIPMENT || "",
    name: "Equipment & Maintenance",
    shortName: "Equipment",
    description: "MTBF/MTTR, PM history, degradation",
    order: 7,
  },
  {
    key: "report",
    id: process.env.AGENT_ID_REPORT || "",
    name: "Report Generator & CAPA",
    shortName: "Report",
    description: "Final compiled RCA report and CAPA",
    order: 8,
  },
];

export const AGENT_BY_KEY: Record<AgentKey, AgentDef> = Object.fromEntries(
  AGENTS.map((a) => [a.key, a]),
) as Record<AgentKey, AgentDef>;

// Responder agent — answers questions posed by analysis agents during automation
export const RESPONDER_AGENT_ID =
  process.env.AGENT_ID_RESPONDER || "bce5d474-726d-4b3e-ab97-b2a493aa0c09";
