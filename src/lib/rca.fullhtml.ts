/**
 * Full 8-step RCA analysis → single self-contained HTML page.
 * Mirrors the in-app report page: data collector, 5-Why chain, fishbone 6M grid,
 * fault-tree, Pareto bars, timeline, equipment metrics, and the final report/CAPA.
 * Uses the shared normalizers so it renders both compact and elaborate agent schemas.
 */
import {
  normalizePareto,
  normalizeTimeline,
  normalizeEquipment,
  normalizeFishbone,
} from "./rca.normalize";

export interface FullAnalysisData {
  caseTitle: string;
  assetId?: string;
  generatedAt: string;
  collector: any;
  fiveWhyMessages: Array<{ role: string; content?: string; parsed: any }>;
  fishbone: any;
  faultTree: any;
  pareto: any;
  timeline: any;
  equipment: any;
  report: any;
}

function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FB_LABELS: Record<string, string> = {
  manpower: "Man", machine: "Machine", method: "Method",
  material: "Material", measurement: "Measurement", environment: "Environment",
};
const FB_ORDER = ["manpower", "machine", "method", "material", "measurement", "environment"];
const FB_COLORS: Record<string, string> = {
  manpower: "#EF4444", machine: "#F59E0B", method: "#8B5CF6",
  material: "#10B981", measurement: "#3B82F6", environment: "#EC4899",
};

function extractFtaTree(raw: any): any {
  if (!raw) return null;
  if (raw.tree?.id || raw.tree?.label) return raw.tree;
  if (raw.faultTreeAnalysis?.tree) return raw.faultTreeAnalysis.tree;
  if (raw.faultTreeAnalysis) {
    const fta = raw.faultTreeAnalysis;
    return {
      label: typeof fta.topEvent === "string" ? fta.topEvent : fta.topEvent?.label || fta.topEvent?.description || "Top Failure Event",
      type: "gate", gateType: "OR", probability: 1.0,
      children: Array.isArray(fta.branches) ? fta.branches : (Array.isArray(fta.intermediateEvents) ? fta.intermediateEvents : []),
    };
  }
  if (raw.topEvent || raw.branches) {
    return { label: raw.topEvent || "Top Failure Event", type: "gate", gateType: "OR", probability: 1.0, children: raw.branches || [] };
  }
  return null;
}

function renderFtaNode(node: any, depth = 0): string {
  if (!node || typeof node !== "object") return "";
  const label = node.label || node.event || node.description || node.name || "—";
  const isGate = (node.children && node.children.length) || node.type === "gate" || node.gateType;
  const prob = node.probability != null ? ` <span class="prob">P=${node.probability}</span>` : "";
  const gate = node.gateType ? ` <span class="gate">[${node.gateType}]</span>` : "";
  const kids = Array.isArray(node.children) ? node.children : [];
  return `<div class="fta-node" style="margin-left:${depth * 22}px">
    <span class="fta-mark">${isGate ? "▣" : "◉"}</span>
    <span class="fta-label">${esc(label)}</span>${gate}${prob}
  </div>${kids.map((k: any) => renderFtaNode(k, depth + 1)).join("")}`;
}

function section(title: string, num: number, body: string): string {
  return `<section><h2><span class="num">${num}</span> ${esc(title)}</h2>${body}</section>`;
}

export function generateFullStepsHtml(data: FullAnalysisData): string {
  const col = data.collector || {};
  const rptCore = data.report?.rcaReport || data.report || {};

  // Step 1 — Data Collector
  const gaps: string[] = Array.isArray(col.gaps) ? col.gaps : [];
  const followUps: string[] = Array.isArray(col.followUps) ? col.followUps : [];
  const collectorBody = `<table class="kv">
    <tr><td class="k">Problem Statement</td><td>${esc(col.problemStatement || rptCore.problemDescription || "—")}</td></tr>
    <tr><td class="k">Effect / Impact</td><td>${esc(col.effect || "—")}</td></tr>
    <tr><td class="k">Equipment</td><td>${esc(col.equipmentName || rptCore.equipment?.name || "—")}</td></tr>
    <tr><td class="k">Location</td><td>${esc(col.location || "—")}</td></tr>
    <tr><td class="k">Operating Conditions</td><td>${esc(col.operatingConditions || "—")}</td></tr>
    <tr><td class="k">Timestamp</td><td>${esc(col.timestamp || "—")}</td></tr>
    <tr><td class="k">Witnessed Symptoms</td><td>${esc(col.witnessedSymptoms || "—")}</td></tr>
  </table>
  ${gaps.length ? `<p class="sub">Data Gaps</p><ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
  ${followUps.length ? `<p class="sub">Follow-Ups</p><ul>${followUps.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}`;

  // Step 2 — 5-Why chain
  const whySteps = (data.fiveWhyMessages || [])
    .filter((m) => m.role === "assistant" && m.parsed)
    .map((m) => m.parsed)
    .filter((p) => p && (p.question || p.whyStep))
    .filter((p) => p.selectedAnswer || p.operatorInstruction || p.answer)
    .sort((a, b) => (a.whyStep || 0) - (b.whyStep || 0));
  const s1 = rptCore.whyWhyAnalysis?.stream1 || {};
  let fiveWhyBody = "";
  if (whySteps.length) {
    fiveWhyBody = `<div class="why-chain">${whySteps
      .map((w, i) => {
        const causes = Array.isArray(w.possibleCauses) ? w.possibleCauses : [];
        return `<div class="why-step"><div class="why-q">Why ${w.whyStep || i + 1}: ${esc(w.question || "")}</div>
        ${causes.length ? `<ul class="why-causes">${causes.map((c: any) => `<li><b>[${esc(c.likelihood || c.category || "")}]</b> ${esc(c.description || c.cause || "")}</li>`).join("")}</ul>` : ""}
        ${w.operatorInstruction ? `<div class="why-instr">↳ ${esc(w.operatorInstruction)}</div>` : ""}</div>`;
      })
      .join('<div class="why-arrow">↓</div>')}</div>`;
  } else if (Object.keys(s1).length) {
    fiveWhyBody = `<table class="kv">${["why1", "why2", "why3", "why4", "why5", "why6"]
      .filter((k) => s1[k])
      .map((k, i) => `<tr><td class="k">Why-${i + 1}</td><td>${esc(s1[k])}</td></tr>`)
      .join("")}</table>`;
  } else {
    fiveWhyBody = '<p class="muted">No 5-Why analysis recorded.</p>';
  }

  // Step 3 — Fishbone 6M
  const fb = normalizeFishbone(data.fishbone || {});
  const fbCats = Object.keys(fb).length ? fb : (rptCore.fishboneCategories || {});
  const fishboneBody = Object.keys(fbCats).some((k) => (fbCats[k] || []).length)
    ? `<div class="fishbone">${FB_ORDER.map((k) => {
        const items = fbCats[k] || fbCats[k + "s"] || [];
        return `<div class="fb-col" style="border-top:3px solid ${FB_COLORS[k]}"><div class="fb-h" style="color:${FB_COLORS[k]}">${FB_LABELS[k]}</div>${items.length ? `<ul>${items.map((c: any) => `<li>${esc(typeof c === "string" ? c : c.cause || c.description || "")}</li>`).join("")}</ul>` : '<span class="muted">—</span>'}</div>`;
      }).join("")}</div>`
    : '<p class="muted">No fishbone data.</p>';

  // Step 4 — Fault tree
  const ftaTree = extractFtaTree(data.faultTree || {});
  const ftaBody = ftaTree ? `<div class="fta">${renderFtaNode(ftaTree)}</div>` : '<p class="muted">No fault tree data.</p>';

  // Step 5 — Pareto bars
  const pareto = normalizePareto(data.pareto || {});
  let paretoBody = '<p class="muted">No Pareto data.</p>';
  if (pareto.length) {
    const maxF = Math.max(...pareto.map((p) => p.frequency), 1);
    let cum = 0;
    const total = pareto.reduce((s, p) => s + p.frequency, 0) || 1;
    paretoBody = `<div class="pareto">${pareto
      .map((p) => {
        cum += p.frequency;
        const cumPct = p.cumulativePercentage != null ? p.cumulativePercentage : Math.round((cum / total) * 100);
        const w = Math.round((p.frequency / maxF) * 100);
        const vital = cumPct <= 80;
        return `<div class="bar-row"><div class="bar-label">${esc(p.mode)}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${vital ? "#2563eb" : "#94a3b8"}"></div><span class="bar-val">${p.frequency}</span></div><div class="bar-cum">${cumPct}%</div></div>`;
      })
      .join("")}</div><p class="legend"><span class="chip" style="background:#2563eb"></span>Vital few (≤80% cumulative) &nbsp; <span class="chip" style="background:#94a3b8"></span>Trivial many</p>`;
  }

  // Step 6 — Timeline
  const phases = normalizeTimeline(data.timeline || {});
  const phaseColors = ["#3B82F6", "#F59E0B", "#EF4444", "#10B981", "#8B5CF6"];
  const timelineBody = phases.length
    ? `<div class="timeline">${phases
        .map((ph, i) => `<div class="tl-phase" style="border-left:4px solid ${phaseColors[i % phaseColors.length]}">
        <div class="tl-h">${esc(ph.phase)}${ph.start ? ` <span class="muted">(${esc(ph.start)})</span>` : ""}</div>
        ${ph.description ? `<div class="tl-desc">${esc(ph.description)}</div>` : ""}
        <ul>${ph.events.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`)
        .join("")}</div>`
    : '<p class="muted">No timeline data.</p>';

  // Step 7 — Equipment
  const eq = normalizeEquipment(data.equipment || {});
  const metricCard = (label: string, m: any) =>
    m && (m.value || m.trend) ? `<div class="metric"><div class="m-label">${label}</div><div class="m-val">${esc(m.value || "—")}</div><div class="m-trend">${esc(m.trend || "")}</div></div>` : "";
  const rpn = eq.rpnScores || {};
  const eqMetrics = [metricCard("MTBF", eq.mtbf), metricCard("MTTR", eq.mttr), metricCard("Availability", eq.availability), metricCard("Failure Rate", eq.failureRate)].filter(Boolean).join("");
  const rpnBody = Object.keys(rpn).length
    ? `<p class="sub">RPN Scores</p><div class="pareto">${Object.entries(rpn).map(([k, v]: any) => `<div class="bar-row"><div class="bar-label">${esc(k)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(Number(v), 100)}%;background:${Number(v) >= 70 ? "#EF4444" : Number(v) >= 40 ? "#F59E0B" : "#22C55E"}"></div><span class="bar-val">${esc(v)}</span></div></div>`).join("")}</div>`
    : "";
  const equipmentBody = eqMetrics || rpnBody ? `<div class="metrics">${eqMetrics}</div>${rpnBody}` : '<p class="muted">No equipment metrics.</p>';

  // Step 8 — Report (root causes + CAPA)
  const rcs: string[] = Array.isArray(rptCore.rootCauses) ? rptCore.rootCauses.filter(Boolean) : [];
  const capa: any[] = Array.isArray(rptCore.actionPlan) ? rptCore.actionPlan : (Array.isArray(data.report?.correctiveActionsList) ? data.report.correctiveActionsList : []);
  const reportBody = `
    ${rcs.length ? `<p class="sub">Identified Root Cause(s)</p><ol class="rc">${rcs.map((rc) => `<li>${esc(rc)}</li>`).join("")}</ol>` : ""}
    ${capa.length ? `<p class="sub">Corrective &amp; Preventive Actions (CAPA)</p>
    <table class="grid"><tr><th>#</th><th>Action</th><th>Type</th><th>Responsible</th><th>Target</th><th>Status</th></tr>
    ${capa.map((a, i) => `<tr><td class="ctr">${a.srNo || i + 1}</td><td>${esc(a.action || a.desc || a.description || "")}</td><td class="ctr">${esc(a.type || "CA")}</td><td>${esc(a.responsible || a.owner || "—")}</td><td class="ctr">${esc(a.target || a.date || "—")}</td><td class="ctr">${esc(a.status || "—")}</td></tr>`).join("")}</table>` : ""}
    ${rptCore.preventiveMeasures && rptCore.preventiveMeasures !== "—" ? `<p class="sub">Preventive Measures</p><p>${esc(rptCore.preventiveMeasures)}</p>` : ""}
    ${rptCore.horizontalDeployment && rptCore.horizontalDeployment !== "—" ? `<p class="sub">Horizontal Deployment</p><p>${esc(rptCore.horizontalDeployment)}</p>` : ""}
    ${!rcs.length && !capa.length ? '<p class="muted">No final report data.</p>' : ""}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<title>RCA Full Analysis — ${esc(data.caseTitle)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:"Segoe UI",Calibri,Arial,sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:28px;font-size:13px;line-height:1.5;}
  header.top{text-align:center;margin-bottom:24px;border-bottom:3px solid #2563eb;padding-bottom:14px;}
  header.top h1{margin:0;font-size:24px;color:#1e3a8a;}
  header.top .meta{color:#64748b;font-size:12px;margin-top:4px;}
  section{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.05);}
  h2{font-size:16px;margin:0 0 14px;color:#1e3a8a;display:flex;align-items:center;gap:10px;}
  h2 .num{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#2563eb;color:#fff;font-size:13px;}
  .sub{font-weight:600;color:#334155;margin:14px 0 6px;font-size:13px;}
  .muted{color:#94a3b8;font-style:italic;}
  table{width:100%;border-collapse:collapse;}
  table.kv td{border:1px solid #e2e8f0;padding:6px 10px;vertical-align:top;}
  table.kv td.k{background:#f1f5f9;font-weight:600;width:210px;color:#475569;}
  table.grid th{background:#2563eb;color:#fff;padding:7px 9px;text-align:left;font-size:12px;}
  table.grid td{border:1px solid #e2e8f0;padding:6px 9px;vertical-align:top;}
  .ctr{text-align:center;}
  ul,ol{margin:6px 0;padding-left:20px;} li{margin-bottom:3px;}
  /* 5-why */
  .why-chain{display:flex;flex-direction:column;align-items:stretch;}
  .why-step{background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #2563eb;border-radius:6px;padding:10px 12px;}
  .why-q{font-weight:600;color:#1e293b;}
  .why-causes{margin:6px 0 0;} .why-instr{color:#2563eb;font-size:12px;margin-top:6px;}
  .why-arrow{text-align:center;color:#94a3b8;font-size:18px;line-height:1;margin:2px 0;}
  /* fishbone */
  .fishbone{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
  .fb-col{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;}
  .fb-h{font-weight:700;text-transform:uppercase;font-size:12px;margin-bottom:4px;}
  /* fta */
  .fta{font-family:"Consolas",monospace;font-size:12px;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;overflow:auto;}
  .fta-node{padding:2px 0;white-space:nowrap;}
  .fta-mark{color:#60a5fa;margin-right:6px;} .fta-label{color:#f1f5f9;}
  .fta .gate{color:#fbbf24;font-weight:600;} .fta .prob{color:#34d399;}
  /* pareto / rpn bars */
  .pareto{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
  .bar-row{display:flex;align-items:center;gap:10px;}
  .bar-label{width:230px;font-size:12px;color:#334155;flex-shrink:0;}
  .bar-track{flex:1;background:#f1f5f9;border-radius:4px;height:22px;position:relative;}
  .bar-fill{height:100%;border-radius:4px;min-width:2px;}
  .bar-val{position:absolute;right:6px;top:2px;font-size:11px;font-weight:600;color:#0f172a;}
  .bar-cum{width:48px;text-align:right;font-size:12px;color:#64748b;font-weight:600;}
  .legend{font-size:11px;color:#64748b;margin-top:8px;} .chip{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:middle;margin-right:3px;}
  /* timeline */
  .timeline{display:flex;flex-direction:column;gap:10px;}
  .tl-phase{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;}
  .tl-h{font-weight:700;color:#1e293b;} .tl-desc{color:#475569;font-size:12px;margin:2px 0;}
  /* equipment */
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
  .metric{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;}
  .m-label{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;}
  .m-val{font-size:18px;font-weight:700;color:#1e3a8a;margin:4px 0;}
  .m-trend{font-size:11px;color:#475569;}
  .rc li{margin-bottom:5px;}
  @media print{body{background:#fff;padding:0;}section{box-shadow:none;page-break-inside:avoid;}*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
</style></head><body>
<header class="top">
  <h1>Root Cause Analysis — Full Report</h1>
  <div class="meta">${esc(data.caseTitle)}${data.assetId ? ` &nbsp;·&nbsp; Asset: ${esc(data.assetId)}` : ""} &nbsp;·&nbsp; Generated ${esc(data.generatedAt)}</div>
</header>
${section("Data Collection & Validation", 1, collectorBody)}
${section("5-Why Analysis", 2, fiveWhyBody)}
${section("Fishbone (Ishikawa) — 6M Categories", 3, fishboneBody)}
${section("Fault Tree Analysis", 4, ftaBody)}
${section("Pareto & Trend", 5, paretoBody)}
${section("Timeline & Event Correlation", 6, timelineBody)}
${section("Equipment & Maintenance", 7, equipmentBody)}
${section("Report & CAPA", 8, reportBody)}
</body></html>`;
}
