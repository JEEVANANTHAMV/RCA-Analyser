/**
 * Per-agent data normalizers.
 *
 * Agents return EITHER a compact schema (fresh runs) OR a rich "analyst" schema
 * (e.g. paretoAndTrendAnalysis, timelineAndEventCorrelation,
 * equipmentAndMaintenanceAnalysis). These pure functions map both shapes into one
 * canonical render model used by the in-app report page AND the full-HTML export.
 */

export interface ParetoMode {
  mode: string;
  frequency: number;
  cumulativePercentage?: number;
}

export interface TimelinePhase {
  phase: string;
  description?: string;
  start?: string;
  events: string[];
}

export interface EquipmentMetric {
  value: string;
  trend?: string;
}
export interface EquipmentMetrics {
  mtbf?: EquipmentMetric;
  mttr?: EquipmentMetric;
  availability?: EquipmentMetric;
  failureRate?: EquipmentMetric;
  rpnScores?: Record<string, number>;
}

function num(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

export function normalizePareto(raw: any): ParetoMode[] {
  if (!raw || typeof raw !== "object") return [];
  // compact: { paretoAnalysis: { byFailureMode: [{mode, frequency}] } } or top-level byFailureMode
  const compact = raw.paretoAnalysis?.byFailureMode || raw.byFailureMode;
  if (Array.isArray(compact)) {
    return compact
      .map((x: any) => ({ mode: x.mode || x.category || x.failureMode || "", frequency: num(x.frequency), cumulativePercentage: x.cumulativePercentage }))
      .filter((x) => x.mode);
  }
  // elaborate: paretoAndTrendAnalysis.paretoAnalysis.byFailureType.categories[]
  const cats =
    raw.paretoAndTrendAnalysis?.paretoAnalysis?.byFailureType?.categories ||
    raw.paretoAnalysis?.byFailureType?.categories ||
    raw.byFailureType?.categories ||
    raw.paretoAndTrendAnalysis?.paretoAnalysis?.byFailureMode;
  if (Array.isArray(cats)) {
    return cats
      .map((c: any) => ({ mode: c.category || c.mode || c.failureMode || "", frequency: num(c.frequency), cumulativePercentage: c.cumulativePercentage }))
      .filter((x) => x.mode);
  }
  return [];
}

export function normalizeTimeline(raw: any): TimelinePhase[] {
  if (!raw || typeof raw !== "object") return [];
  const evToStr = (e: any): string =>
    typeof e === "string" ? e : e?.timestamp ? `${e.timestamp} — ${e.event || e.description || ""}` : e?.event || e?.description || "";

  // compact: timeline.phases[] = {phase, description, start, events:[string]}
  const phases = raw.timeline?.phases || raw.phases;
  if (Array.isArray(phases)) {
    return phases.map((p: any) => ({
      phase: p.phase || p.name || "",
      description: p.description,
      start: p.start,
      events: (p.events || []).map(evToStr).filter(Boolean),
    }));
  }
  // elaborate: timelineAndEventCorrelation.timeline.{preIncidentPeriod, incidentPeriod, postIncidentPeriod}
  const tl = raw.timelineAndEventCorrelation?.timeline || raw.timeline;
  if (tl && (tl.preIncidentPeriod || tl.incidentPeriod || tl.postIncidentPeriod)) {
    const out: TimelinePhase[] = [];
    const segs: Array<[string, string]> = [
      ["preIncidentPeriod", "Pre-Incident Period"],
      ["incidentPeriod", "Incident Period"],
      ["postIncidentPeriod", "Post-Incident Period"],
    ];
    for (const [key, label] of segs) {
      const ph = tl[key];
      if (!ph) continue;
      out.push({
        phase: label,
        description: ph.description,
        start: ph.start,
        events: (ph.events || []).map(evToStr).filter(Boolean),
      });
    }
    return out;
  }
  return [];
}

export function normalizeEquipment(raw: any): EquipmentMetrics {
  if (!raw || typeof raw !== "object") return {};
  // compact: reliabilityMetrics: { mtbf:{value,trend}, mttr, availability, failureRate, rpnScores }
  if (raw.reliabilityMetrics) return raw.reliabilityMetrics as EquipmentMetrics;
  if (raw.mtbf || raw.mttr || raw.rpnScores) return raw as EquipmentMetrics;
  // elaborate: equipmentAndMaintenanceAnalysis.mtbfMttrAnalysis.{mtbf:{current,trend}, ...}
  const m = raw.equipmentAndMaintenanceAnalysis?.mtbfMttrAnalysis || raw.mtbfMttrAnalysis;
  if (m) {
    const mk = (x: any): EquipmentMetric | undefined =>
      x ? { value: String(x.value ?? x.current ?? ""), trend: x.trend || x.assessment || "" } : undefined;
    return {
      mtbf: mk(m.mtbf),
      mttr: mk(m.mttr),
      availability: mk(m.availability),
      failureRate: mk(m.failureRate),
      rpnScores: {},
    };
  }
  return {};
}

/** Fault tree: the report page already handles `tree` / `faultTreeAnalysis` / `topEvent` shapes,
 *  so return the raw object unchanged for that logic to consume. */
export function normalizeFaultTree(raw: any): any {
  return raw || null;
}

const FB_KEYS = ["manpower", "machine", "method", "material", "measurement", "environment"];
export function normalizeFishbone(raw: any): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw.fishbone || raw.categories || raw.fishboneCategories || raw;
  const out: Record<string, string[]> = {};
  for (const k of FB_KEYS) {
    const alt = k + "s";
    const arr = src[k] || src[alt];
    if (Array.isArray(arr)) {
      out[k] = arr
        .map((c: any) => (typeof c === "string" ? c : c.cause || c.description || c.text || ""))
        .filter(Boolean);
    }
  }
  return out;
}
