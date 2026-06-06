/**
 * Full-pipeline RCA export: styled HTML + DOCX covering all 8 analysis steps.
 */
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  ShadingType,
  PageBreak,
  LevelFormat,
} from "docx";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AllAgentData {
  caseTitle: string;
  assetId?: string;
  generatedAt: string;
  collector: any;
  fiveWhy: { messages: Array<{ role: string; content: string; parsed: any }> };
  fishbone: any;
  faultTree: any;
  pareto: any;
  timeline: any;
  equipment: any;
  report: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: any): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function kv(label: string, value: any, highlight = false): string {
  if (!value && value !== 0) return "";
  return `<div class="kv${highlight ? " kv-hi" : ""}"><span class="kv-label">${esc(label)}</span><span class="kv-value">${esc(value)}</span></div>`;
}

function sectionHeader(stepNum: number, title: string, icon: string, color: string): string {
  return `
  <div class="section-header" style="border-left:4px solid ${color}">
    <div class="step-badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${icon} STEP ${stepNum}</div>
    <h2 class="section-title" style="color:${color}">${esc(title)}</h2>
  </div>`;
}

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return "";
  return `<table class="data-table">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody>
  </table>`;
}

function renderFtaNode(node: any, depth = 0): string {
  if (!node) return "";
  const indent = depth * 24;
  const isGate = node.type === "gate";
  const prob = typeof node.probability === "number" ? (node.probability * 100).toFixed(1) + "%" : "—";
  const gateColor = isGate ? "#F59E0B" : "#60A5FA";
  const connector = depth > 0 ? `<span class="tree-connector">${isGate ? "◈" : "◉"}</span>` : `<span class="tree-connector">⬟</span>`;
  const badge = isGate ? `<span class="gate-badge">${esc(node.gateType || "OR")}</span>` : "";
  const probBadge = `<span class="prob-badge" style="color:${Number(prob) > 50 ? "#EF4444" : "#22C55E"}">${prob}</span>`;

  let html = `<div class="tree-node" style="margin-left:${indent}px;border-left-color:${gateColor}">
    ${connector} <span class="node-label" style="color:${gateColor}">${esc(node.label)}</span>
    ${badge} ${probBadge}
  </div>`;

  if (Array.isArray(node.children)) {
    html += node.children.map((c: any) => renderFtaNode(c, depth + 1)).join("");
  }
  return html;
}

function paretoBar(mode: string, freq: number, max: number, cumPct: number): string {
  const pct = max > 0 ? Math.round((freq / max) * 100) : 0;
  const barColor = cumPct <= 80 ? "#3B82F6" : "#64748B";
  return `<div class="pareto-row">
    <div class="pareto-label">${esc(mode)}</div>
    <div class="pareto-bar-wrap">
      <div class="pareto-bar" style="width:${pct}%;background:${barColor}"></div>
    </div>
    <div class="pareto-freq">${freq}</div>
    <div class="pareto-cum">${cumPct.toFixed(0)}%</div>
  </div>`;
}

function timelinePhase(phase: any, idx: number): string {
  const colors = ["#3B82F6", "#8B5CF6", "#F59E0B", "#10B981", "#EF4444", "#06B6D4"];
  const color = colors[idx % colors.length];
  const events: string[] = Array.isArray(phase.events) ? phase.events : [];
  return `<div class="tl-phase" style="border-left:3px solid ${color}">
    <div class="tl-phase-header">
      <span class="tl-phase-name" style="color:${color}">${esc(phase.phase)}</span>
      <span class="tl-phase-meta">${esc(phase.start)} · ${esc(phase.duration)}</span>
    </div>
    <p class="tl-phase-desc">${esc(phase.description)}</p>
    <ul class="tl-events">
      ${events.map((e) => `<li>${esc(e)}</li>`).join("")}
    </ul>
  </div>`;
}

const HTML_CSS = `
  :root {
    --bg: #0A0F1E; --bg2: #0F172A; --bg3: #1E293B; --bg4: #334155;
    --text: #E2E8F0; --muted: #94A3B8; --accent: #3B82F6;
    --border: #1E293B; --success: #22C55E; --warning: #F59E0B; --danger: #EF4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Calibri, sans-serif; font-size: 13px; line-height: 1.6; }
  .page { max-width: 1100px; margin: 0 auto; padding: 0 32px 80px; }

  /* ── Cover ── */
  .cover { background: linear-gradient(135deg, #0A0F1E 0%, #0D2040 50%, #0A0F1E 100%);
    padding: 80px 60px; min-height: 320px; border-bottom: 1px solid #1E3A5F; position:relative; }
  .cover-logo { font-size: 11px; font-family: monospace; color: var(--accent); letter-spacing: 4px; text-transform: uppercase; margin-bottom: 40px; }
  .cover-title { font-size: 36px; font-weight: 800; color: #fff; line-height: 1.2; margin-bottom: 12px; }
  .cover-subtitle { font-size: 16px; color: var(--muted); margin-bottom: 40px; }
  .cover-meta { display: flex; flex-wrap: wrap; gap: 32px; }
  .cover-meta-item { display: flex; flex-direction: column; gap: 4px; }
  .cover-meta-label { font-size: 10px; font-family: monospace; text-transform: uppercase; color: var(--muted); letter-spacing: 2px; }
  .cover-meta-value { font-size: 14px; font-weight: 600; color: #fff; }
  .cover-stripe { position:absolute; top:0; right:0; width:4px; height:100%; background: linear-gradient(180deg, #3B82F6, #8B5CF6, #3B82F6); }

  /* ── TOC ── */
  .toc { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 28px 32px; margin: 40px 0; }
  .toc-title { font-size: 11px; font-family: monospace; color: var(--accent); letter-spacing: 3px; text-transform: uppercase; margin-bottom: 20px; }
  .toc-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .toc-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--bg3); border-radius: 8px;
    border: 1px solid var(--border); text-decoration: none; color: var(--text); transition: border-color .2s; }
  .toc-item:hover { border-color: var(--accent); }
  .toc-num { font-size: 11px; font-family: monospace; color: var(--muted); }
  .toc-name { font-size: 12px; font-weight: 600; }

  /* ── Sections ── */
  .section { margin: 48px 0; }
  .section-header { display: flex; align-items: center; gap: 14px; padding: 16px 20px; background: var(--bg2);
    border-radius: 10px; margin-bottom: 24px; }
  .step-badge { font-size: 10px; font-family: monospace; padding: 4px 10px; border-radius: 20px; font-weight: 700; letter-spacing: 1px; white-space: nowrap; }
  .section-title { font-size: 20px; font-weight: 700; }

  /* ── KV pairs ── */
  .kv-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
  .kv { display: flex; gap: 8px; padding: 10px 14px; background: var(--bg2); border-radius: 8px; border: 1px solid var(--border); }
  .kv-label { font-size: 10px; font-family: monospace; color: var(--muted); text-transform: uppercase; white-space: nowrap; min-width: 120px; padding-top: 2px; }
  .kv-value { font-size: 13px; font-weight: 500; color: var(--text); }
  .kv-hi .kv-value { color: #60A5FA; font-weight: 700; }
  .kv-full { grid-column: 1 / -1; }

  /* ── Tags ── */
  .tag-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .tag { padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 500; background: #1E3A5F; color: #93C5FD; border: 1px solid #2563EB44; }
  .tag-warn { background: #3D2400; color: #FBB60A; border-color: #F59E0B44; }

  /* ── Tables ── */
  .data-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 12px; }
  .data-table th { background: #1E3A5F; color: #93C5FD; font-family: monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
    padding: 10px 14px; text-align: left; border-bottom: 2px solid #3B82F6; }
  .data-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .data-table tr:nth-child(even) td { background: var(--bg2); }
  .data-table tr:hover td { background: #1E293B; }
  .status-pill { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 10px; font-weight: 700; }
  .status-done { background: #052E16; color: #22C55E; }
  .status-prog { background: #2D1900; color: #F59E0B; }
  .status-pend { background: #1E293B; color: #94A3B8; }

  /* ── Why-Why ── */
  .why-chain { display: flex; flex-direction: column; gap: 0; }
  .why-row { display: flex; gap: 0; }
  .why-label { font-size: 10px; font-family: monospace; color: var(--warning); background: #2D1900; border: 1px solid #F59E0B44;
    padding: 8px 12px; min-width: 80px; display: flex; align-items: center; justify-content: center; font-weight: 700; }
  .why-value { flex: 1; padding: 10px 14px; background: var(--bg2); border: 1px solid var(--border); border-left: none; font-size: 13px; }
  .why-connector { font-size: 16px; color: var(--warning); text-align: center; padding: 4px 0; margin-left: 80px; }
  .why-problem { background: #0D2040; border: 1px solid #3B82F644; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .why-problem-label { font-size: 10px; font-family: monospace; color: var(--accent); text-transform: uppercase; margin-bottom: 6px; }
  .why-problem-text { font-size: 14px; font-weight: 600; }
  .why-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .why-col-label { font-size: 10px; font-family: monospace; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }

  /* ── Fishbone ── */
  .fishbone-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .fishbone-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .fishbone-cat { font-size: 10px; font-family: monospace; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; font-weight: 700; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .fishbone-causes { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .fishbone-causes li { font-size: 12px; padding: 6px 10px; background: var(--bg3); border-radius: 6px; border-left: 3px solid currentColor; }
  .fishbone-sub { font-size: 11px; color: var(--muted); margin-left: 14px; margin-top: 4px; }

  /* ── FTA Tree ── */
  .fta-tree { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 20px; font-family: monospace; }
  .tree-node { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 2px 0;
    background: var(--bg3); border-left: 3px solid #60A5FA; border-radius: 0 6px 6px 0; }
  .tree-connector { font-size: 14px; }
  .node-label { font-size: 12px; font-weight: 600; flex: 1; }
  .gate-badge { font-size: 9px; padding: 2px 8px; background: #2D1900; color: #F59E0B; border: 1px solid #F59E0B44; border-radius: 10px; font-weight: 700; }
  .prob-badge { font-size: 11px; font-weight: 700; font-family: monospace; }

  /* ── Pareto ── */
  .pareto-chart { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .pareto-row { display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .pareto-label { width: 220px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .pareto-bar-wrap { flex: 1; height: 18px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
  .pareto-bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .pareto-freq { width: 40px; text-align: right; font-family: monospace; font-size: 12px; color: var(--muted); }
  .pareto-cum { width: 50px; text-align: right; font-family: monospace; font-size: 12px; color: var(--warning); }
  .pareto-header { display: flex; align-items: center; gap: 12px; font-size: 10px; font-family: monospace; color: var(--muted); text-transform: uppercase;
    padding: 0 0 8px 0; border-bottom: 2px solid #3B82F6; margin-bottom: 4px; }
  .pareto-legend { display: flex; gap: 16px; margin-top: 16px; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }

  /* ── Timeline ── */
  .tl-container { display: flex; flex-direction: column; gap: 0; }
  .tl-phase { padding: 16px 20px; background: var(--bg2); border-radius: 0; border-bottom: 1px solid var(--border); position: relative; }
  .tl-phase:first-child { border-radius: 10px 10px 0 0; }
  .tl-phase:last-child { border-radius: 0 0 10px 10px; border-bottom: none; }
  .tl-phase-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .tl-phase-name { font-size: 14px; font-weight: 700; }
  .tl-phase-meta { font-size: 11px; font-family: monospace; color: var(--muted); background: var(--bg3); padding: 3px 10px; border-radius: 10px; }
  .tl-phase-desc { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .tl-events { list-style: none; display: flex; flex-direction: column; gap: 5px; }
  .tl-events li { font-size: 12px; padding: 7px 12px; background: var(--bg3); border-radius: 6px; position: relative; padding-left: 22px; }
  .tl-events li::before { content: "›"; position: absolute; left: 8px; color: var(--muted); }

  /* ── Equipment ── */
  .metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .metric-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 16px; text-align: center; }
  .metric-label { font-size: 10px; font-family: monospace; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .metric-value { font-size: 22px; font-weight: 800; color: #60A5FA; margin-bottom: 6px; }
  .metric-trend { font-size: 11px; color: var(--muted); line-height: 1.4; }
  .rpn-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .rpn-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .rpn-label { font-size: 10px; font-family: monospace; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; }
  .rpn-bar-wrap { height: 12px; background: var(--bg3); border-radius: 6px; overflow: hidden; margin-bottom: 6px; }
  .rpn-bar { height: 100%; border-radius: 6px; }
  .rpn-value { font-size: 18px; font-weight: 800; }

  /* ── Report RC ── */
  .rc-card { background: linear-gradient(135deg, #1A0505, #2D0A0A); border: 1px solid #EF444444; border-radius: 10px; padding: 16px 20px; margin: 10px 0; }
  .rc-num { font-size: 11px; font-family: monospace; color: #EF4444; font-weight: 700; margin-bottom: 6px; }
  .rc-text { font-size: 14px; font-weight: 600; color: #FCA5A5; }

  /* ── Divider ── */
  .divider { height: 1px; background: linear-gradient(90deg, transparent, var(--accent), transparent); margin: 32px 0; opacity: 0.3; }

  /* ── Print ── */
  @media print {
    body { background: white; color: #1a1a1a; }
    .cover { background: #1E3A5F; }
    .section-header, .kv, .fishbone-card, .tl-phase, .metric-card, .rpn-card, .pareto-chart, .fta-tree { border: 1px solid #ccc !important; background: #f8fafc !important; }
    .section-title, .kv-value, .node-label { color: #1a1a1a !important; }
    .kv-label, .muted, .metric-label, .tl-phase-desc { color: #64748B !important; }
  }
`;

export function generateFullAnalysisHtml(data: AllAgentData): string {
  const c = data.collector || {};
  const fw = data.fiveWhy || { messages: [] };
  const fb = data.fishbone || {};
  const ft = data.faultTree || {};
  const pa = data.pareto || {};
  const tl = data.timeline || {};
  const eq = data.equipment || {};
  const rpt = data.report || {};

  // ── Fishbone categories ──
  const fbCats: Record<string, any[]> = fb.fishbone || fb.categories || {};
  const catConfig: Array<[string, string, string]> = [
    ["manpower", "Skill / Man", "#EF4444"],
    ["machine", "Design / Machine", "#F59E0B"],
    ["methods", "Method", "#8B5CF6"],
    ["materials", "Material", "#10B981"],
    ["measurements", "Measurement", "#06B6D4"],
    ["environment", "Environment", "#3B82F6"],
  ];

  // ── Pareto data ──
  let paretoItems: Array<{ mode: string; frequency: number }> = [];
  const paretoSrc = pa.paretoAnalysis?.byFailureMode || pa.byFailureMode || [];
  if (Array.isArray(paretoSrc)) paretoItems = paretoSrc;
  const paretoTotal = paretoItems.reduce((s, i) => s + (i.frequency || 0), 0);
  const paretoMax = Math.max(...paretoItems.map((i) => i.frequency), 1);
  let cumFreq = 0;

  // ── FTA tree ──
  let ftaTree: any = null;
  if (ft.tree) ftaTree = ft.tree;
  else if (ft.faultTreeAnalysis?.tree) ftaTree = ft.faultTreeAnalysis.tree;
  else if (ft.faultTreeAnalysis) {
    const fta = ft.faultTreeAnalysis;
    ftaTree = {
      id: "top", label: fta.topEvent || "Failure Event", type: "gate", gateType: "OR",
      probability: 1.0, children: Array.isArray(fta.branches) ? fta.branches : [],
    };
  } else if (ft.topEvent) {
    ftaTree = { id: "top", label: ft.topEvent, type: "gate", gateType: "OR", probability: 1.0, children: ft.branches || [] };
  }

  // ── Timeline phases ──
  const tlPhases: any[] = tl.timeline?.phases || tl.phases || [];

  // ── Equipment metrics ──
  const rm = eq.reliabilityMetrics || {};
  const rpn = rm.rpnScores || eq.rpnScores || {};

  // ── Report ──
  const rptCore = rpt.rcaReport || rpt;
  const rcs: string[] = Array.isArray(rptCore.rootCauses) ? rptCore.rootCauses.filter(Boolean) : [rpt.rootCause || ""].filter(Boolean);
  const capaList: any[] = rptCore.actionPlan || rpt.correctiveActionsList || [];

  // ── Five Why messages ──
  const whyMessages = fw.messages.filter((m) => m.role === "assistant" && m.parsed);
  const whySteps = whyMessages
    .map((m) => m.parsed)
    .filter((p) => p && (p.question || p.whyStep))
    .sort((a, b) => (a.whyStep || 0) - (b.whyStep || 0));

  // Also check for final summary with chains
  const whyFinal = whyMessages.map((m) => m.parsed).find((p) => p?.whyChains || p?.completeAnalysis || p?.summary);
  const whySummaryStream1 = rptCore.whyWhyAnalysis?.stream1 || {};
  const whySummaryStream2 = rptCore.whyWhyAnalysis?.stream2 || {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RCA Full Analysis — ${esc(data.caseTitle)}</title>
  <style>${HTML_CSS}</style>
</head>
<body>

<!-- ══ COVER ══════════════════════════════════════════════════════════ -->
<div class="cover">
  <div class="cover-stripe"></div>
  <div class="page">
    <div class="cover-logo">RCA.OPS · Industrial Root Cause Analysis Platform</div>
    <h1 class="cover-title">${esc(data.caseTitle)}</h1>
    <p class="cover-subtitle">Complete 8-Step Analysis Report</p>
    <div class="cover-meta">
      ${data.assetId ? `<div class="cover-meta-item"><div class="cover-meta-label">Asset / Equipment</div><div class="cover-meta-value">${esc(data.assetId)}</div></div>` : ""}
      ${c.equipmentName ? `<div class="cover-meta-item"><div class="cover-meta-label">Equipment Name</div><div class="cover-meta-value">${esc(c.equipmentName)}</div></div>` : ""}
      ${c.location ? `<div class="cover-meta-item"><div class="cover-meta-label">Location</div><div class="cover-meta-value">${esc(c.location)}</div></div>` : ""}
      ${c.timestamp ? `<div class="cover-meta-item"><div class="cover-meta-label">Incident Date/Time</div><div class="cover-meta-value">${esc(c.timestamp)}</div></div>` : ""}
      <div class="cover-meta-item"><div class="cover-meta-label">Generated</div><div class="cover-meta-value">${esc(data.generatedAt)}</div></div>
    </div>
  </div>
</div>

<div class="page">

<!-- ══ TABLE OF CONTENTS ════════════════════════════════════════════ -->
<div class="toc">
  <div class="toc-title">// Contents</div>
  <div class="toc-grid">
    <div class="toc-item"><span class="toc-num">01</span><span class="toc-name">Data Collection</span></div>
    <div class="toc-item"><span class="toc-num">02</span><span class="toc-name">5-Why Analysis</span></div>
    <div class="toc-item"><span class="toc-num">03</span><span class="toc-name">Fishbone / Ishikawa</span></div>
    <div class="toc-item"><span class="toc-num">04</span><span class="toc-name">Fault Tree (FTA)</span></div>
    <div class="toc-item"><span class="toc-num">05</span><span class="toc-name">Pareto Analysis</span></div>
    <div class="toc-item"><span class="toc-num">06</span><span class="toc-name">Timeline</span></div>
    <div class="toc-item"><span class="toc-num">07</span><span class="toc-name">Equipment Reliability</span></div>
    <div class="toc-item"><span class="toc-num">08</span><span class="toc-name">RCA Report & CAPA</span></div>
  </div>
</div>

<!-- ══ 01 DATA COLLECTION ══════════════════════════════════════════ -->
<div class="section" id="s1">
  ${sectionHeader(1, "Data Collection & Validation", "📋", "#3B82F6")}

  <div class="kv-grid">
    ${kv("Problem Statement", c.problemStatement, true)}
    ${kv("Effect / Impact", c.effect)}
    ${kv("Equipment Name", c.equipmentName)}
    ${kv("Location / Unit", c.location)}
    ${kv("Operating Conditions", c.operatingConditions)}
    ${kv("Incident Timestamp", c.timestamp)}
    ${kv("Witnessed Symptoms", c.witnessedSymptoms)}
    ${c.maintenanceHistoryChecked !== undefined ? kv("Maintenance History Checked", c.maintenanceHistoryChecked ? "Yes" : "No") : ""}
  </div>

  ${
    Array.isArray(c.gaps) && c.gaps.length
      ? `<div style="margin:16px 0">
          <div style="font-size:10px;font-family:monospace;color:#94A3B8;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">Identified Gaps</div>
          <div class="tag-list">${c.gaps.map((g: string) => `<span class="tag tag-warn">${esc(g)}</span>`).join("")}</div>
        </div>`
      : ""
  }
  ${
    Array.isArray(c.followUps) && c.followUps.length
      ? `<div style="margin:16px 0">
          <div style="font-size:10px;font-family:monospace;color:#94A3B8;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">Suggested Follow-Ups</div>
          <div class="tag-list">${c.followUps.map((f: string) => `<span class="tag">${esc(f)}</span>`).join("")}</div>
        </div>`
      : ""
  }
</div>

<div class="divider"></div>

<!-- ══ 02 FIVE-WHY ANALYSIS ════════════════════════════════════════ -->
<div class="section" id="s2">
  ${sectionHeader(2, "5-Why Root Cause Analysis", "🔍", "#F59E0B")}

  ${
    whySummaryStream1 && Object.values(whySummaryStream1).some(Boolean)
      ? `
    ${rptCore.whyWhyAnalysis?.problem ? `<div class="why-problem"><div class="why-problem-label">Problem Statement</div><div class="why-problem-text">${esc(rptCore.whyWhyAnalysis.problem)}</div></div>` : ""}
    <div class="why-cols">
      <div>
        <div class="why-col-label">Stream 1 — Primary Chain</div>
        <div class="why-chain">
          ${Object.entries(whySummaryStream1)
            .filter(([, v]) => v)
            .map(([k, v], i, arr) => `
            <div class="why-row">
              <div class="why-label">${k.replace("why", "Why ")}</div>
              <div class="why-value">${esc(v as string)}</div>
            </div>
            ${i < arr.length - 1 ? '<div class="why-connector">↓</div>' : ""}
          `).join("")}
        </div>
      </div>
      ${Object.values(whySummaryStream2).some(Boolean) ? `
      <div>
        <div class="why-col-label">Stream 2 — Contributing Chain</div>
        <div class="why-chain">
          ${Object.entries(whySummaryStream2)
            .filter(([, v]) => v)
            .map(([k, v], i, arr) => `
            <div class="why-row">
              <div class="why-label">${k.replace("why", "Why ")}</div>
              <div class="why-value">${esc(v as string)}</div>
            </div>
            ${i < arr.length - 1 ? '<div class="why-connector">↓</div>' : ""}
          `).join("")}
        </div>
      </div>` : ""}
    </div>`
      : whySteps.length
      ? `
    ${whySteps[0]?.problemStatement ? `<div class="why-problem"><div class="why-problem-label">Problem Statement</div><div class="why-problem-text">${esc(whySteps[0].problemStatement)}</div></div>` : ""}
    <div class="why-chain">
      ${whySteps
        .map((step, i) => `
        <div class="why-row">
          <div class="why-label">Why ${step.whyStep || i + 1}</div>
          <div class="why-value">
            ${step.question ? `<strong>Q: ${esc(step.question)}</strong>` : ""}
            ${step.selectedAnswer || step.operatorInstruction ? `<div style="color:#94A3B8;margin-top:4px">A: ${esc(step.selectedAnswer || step.operatorInstruction)}</div>` : ""}
          </div>
        </div>
        ${i < whySteps.length - 1 ? '<div class="why-connector">↓</div>' : ""}
      `).join("")}
    </div>`
      : `<div class="kv"><span class="kv-label">Status</span><span class="kv-value" style="color:#94A3B8">No 5-Why data available — run the analysis step</span></div>`
  }
</div>

<div class="divider"></div>

<!-- ══ 03 FISHBONE / ISHIKAWA ══════════════════════════════════════ -->
<div class="section" id="s3">
  ${sectionHeader(3, "Fishbone / Ishikawa Cause Analysis", "🐟", "#8B5CF6")}

  <div class="fishbone-grid">
    ${catConfig
      .map(([key, label, color]) => {
        const causes: any[] = fbCats[key] || fbCats[key + "s"] || [];
        if (!causes.length) return "";
        return `<div class="fishbone-card" style="border-top:3px solid ${color}">
          <div class="fishbone-cat" style="color:${color}">${label}</div>
          <ul class="fishbone-causes" style="color:${color}">
            ${causes
              .map((c: any) => {
                const name = typeof c === "string" ? c : c.cause || "";
                const status = typeof c === "object" ? c.status : "confirmed";
                const subs: string[] = typeof c === "object" ? (c.subCauses || []) : [];
                const opacity = status === "confirmed" ? "1" : "0.5";
                return `<li style="opacity:${opacity}">${esc(name)}
                  ${subs.map((s) => `<div class="fishbone-sub">↳ ${esc(s)}</div>`).join("")}
                </li>`;
              })
              .join("")}
          </ul>
        </div>`;
      })
      .join("")}
  </div>
  ${!Object.values(fbCats).some((v) => (Array.isArray(v) ? v.length : false))
    ? `<div class="kv"><span class="kv-label">Status</span><span class="kv-value" style="color:#94A3B8">No Fishbone data available — run the analysis step</span></div>`
    : ""}
</div>

<div class="divider"></div>

<!-- ══ 04 FAULT TREE ANALYSIS ═════════════════════════════════════ -->
<div class="section" id="s4">
  ${sectionHeader(4, "Fault Tree Analysis (FTA)", "🌲", "#10B981")}

  ${
    ftaTree
      ? `<div class="fta-tree">${renderFtaNode(ftaTree)}</div>
         <div style="display:flex;gap:20px;margin-top:14px;font-size:11px;color:#94A3B8;font-family:monospace">
           <span>◈ Gate node (AND/OR/NOT)</span>
           <span>◉ Basic event</span>
           <span style="color:#EF4444">Red probability = high risk (&gt;50%)</span>
         </div>`
      : `<div class="kv"><span class="kv-label">Status</span><span class="kv-value" style="color:#94A3B8">No FTA tree data available — run the analysis step</span></div>`
  }
</div>

<div class="divider"></div>

<!-- ══ 05 PARETO ANALYSIS ═════════════════════════════════════════ -->
<div class="section" id="s5">
  ${sectionHeader(5, "Pareto Analysis", "📊", "#06B6D4")}

  ${
    paretoItems.length
      ? `<div class="pareto-chart">
          <div class="pareto-header">
            <div style="width:220px">Failure Mode</div>
            <div style="flex:1">Frequency Distribution</div>
            <div style="width:40px;text-align:right">Freq</div>
            <div style="width:50px;text-align:right">Cum %</div>
          </div>
          ${paretoItems
            .map((item) => {
              cumFreq += item.frequency;
              const cumPct = paretoTotal > 0 ? (cumFreq / paretoTotal) * 100 : 0;
              return paretoBar(item.mode, item.frequency, paretoMax, cumPct);
            })
            .join("")}
          <div class="pareto-legend">
            <div class="legend-item"><div class="legend-dot" style="background:#3B82F6"></div>Top contributors (≤80% cumulative)</div>
            <div class="legend-item"><div class="legend-dot" style="background:#64748B"></div>Remaining causes (&gt;80%)</div>
          </div>
        </div>`
      : `<div class="kv"><span class="kv-label">Status</span><span class="kv-value" style="color:#94A3B8">No Pareto data available — run the analysis step</span></div>`
  }
</div>

<div class="divider"></div>

<!-- ══ 06 TIMELINE ════════════════════════════════════════════════ -->
<div class="section" id="s6">
  ${sectionHeader(6, "Incident Timeline", "⏱", "#F97316")}

  ${
    tlPhases.length
      ? `<div class="tl-container">${tlPhases.map((p: any, i: number) => timelinePhase(p, i)).join("")}</div>`
      : `<div class="kv"><span class="kv-label">Status</span><span class="kv-value" style="color:#94A3B8">No Timeline data available — run the analysis step</span></div>`
  }
</div>

<div class="divider"></div>

<!-- ══ 07 EQUIPMENT RELIABILITY ═══════════════════════════════════ -->
<div class="section" id="s7">
  ${sectionHeader(7, "Equipment Reliability & RPN Analysis", "⚙️", "#EC4899")}

  ${
    rm.mtbf || rm.mttr || rm.availability || rm.failureRate
      ? `<div class="metric-grid">
          ${[
            ["MTBF", rm.mtbf?.value, rm.mtbf?.trend, "#60A5FA"],
            ["MTTR", rm.mttr?.value, rm.mttr?.trend, "#A78BFA"],
            ["Availability", rm.availability?.value, rm.availability?.trend, "#34D399"],
            ["Failure Rate", rm.failureRate?.value, rm.failureRate?.trend, "#F87171"],
          ]
            .filter(([, v]) => v)
            .map(([label, value, trend, color]) => `
            <div class="metric-card" style="border-top:3px solid ${color}">
              <div class="metric-label">${label}</div>
              <div class="metric-value" style="color:${color}">${esc(value)}</div>
              <div class="metric-trend">${esc(trend)}</div>
            </div>
          `).join("")}
        </div>`
      : ""
  }

  ${
    Object.keys(rpn).length
      ? `<div style="font-size:10px;font-family:monospace;color:#94A3B8;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">RPN Scores (Risk Priority Number, 1–100)</div>
        <div class="rpn-grid">
          ${Object.entries(rpn)
            .map(([k, v]) => {
              const score = Number(v) || 0;
              const rpnColor = score >= 70 ? "#EF4444" : score >= 40 ? "#F59E0B" : "#22C55E";
              return `<div class="rpn-card">
                <div class="rpn-label">${esc(k)}</div>
                <div class="rpn-bar-wrap"><div class="rpn-bar" style="width:${score}%;background:${rpnColor}"></div></div>
                <div class="rpn-value" style="color:${rpnColor}">${score}</div>
              </div>`;
            })
            .join("")}
        </div>`
      : ""
  }
  ${
    !rm.mtbf && !Object.keys(rpn).length
      ? `<div class="kv"><span class="kv-label">Status</span><span class="kv-value" style="color:#94A3B8">No Equipment data available — run the analysis step</span></div>`
      : ""
  }
</div>

<div class="divider"></div>

<!-- ══ 08 RCA REPORT & CAPA ════════════════════════════════════════ -->
<div class="section" id="s8">
  ${sectionHeader(8, "RCA Executive Report & CAPA", "📄", "#3B82F6")}

  ${rcs.length ? `<div style="margin-bottom:20px">${rcs.map((rc, i) => `<div class="rc-card"><div class="rc-num">// ROOT CAUSE ${i + 1}</div><div class="rc-text">${esc(rc)}</div></div>`).join("")}</div>` : ""}

  ${
    rptCore.header?.rcaNumber || rptCore.equipment?.name
      ? `<div class="kv-grid">
          ${kv("RCA Number", rptCore.header?.rcaNumber)}
          ${kv("Plant", rptCore.header?.plant)}
          ${kv("Department", rptCore.header?.department)}
          ${kv("Section", rptCore.header?.section)}
          ${kv("Equipment", rptCore.equipment?.name)}
          ${kv("Occurrence", rptCore.equipment?.occurrenceDateTime)}
          ${kv("Restoration", rptCore.equipment?.restorationDateTime)}
          ${kv("Production Affected", rptCore.equipment?.productionAffectedHours)}
        </div>`
      : ""
  }

  ${
    capaList.length
      ? `<div style="margin-top:20px">
          <div style="font-size:10px;font-family:monospace;color:#3B82F6;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">CAPA Action Plan</div>
          ${table(
            ["#", "Action", "Type", "Responsible", "Dept", "Target Date", "Status"],
            capaList.map((a: any, idx: number) => [
              String(a.srNo ?? idx + 1),
              a.action || a.desc || "",
              a.type || "CA",
              a.responsible || a.owner || "—",
              a.department || a.dept || "—",
              a.target || a.date || "—",
              `<span class="status-pill ${a.status === "Completed" ? "status-done" : a.status === "In Progress" ? "status-prog" : "status-pend"}">${esc(a.status || "Pending")}</span>`,
            ])
          )}</div>`
      : ""
  }

  ${
    rptCore.horizontalDeployment || rptCore.preventiveMeasures
      ? `<div class="kv-grid" style="margin-top:16px">
          ${kv("Horizontal Deployment", rptCore.horizontalDeployment)}
          ${kv("Preventive Measures", rptCore.preventiveMeasures)}
          ${kv("Sustainable Measures", rptCore.sustainableMeasures)}
          ${kv("FMEA Update Required?", rptCore.changesRequiredInFMEA)}
        </div>`
      : ""
  }
</div>

<!-- ── Footer ── -->
<div style="margin-top:60px;padding-top:24px;border-top:1px solid #1E293B;display:flex;justify-content:space-between;align-items:center">
  <div style="font-size:11px;font-family:monospace;color:#475569">Generated by RCA.OPS Platform · ${esc(data.generatedAt)}</div>
  <div style="font-size:11px;font-family:monospace;color:#475569">${esc(data.caseTitle)} · ${esc(data.assetId || "")}</div>
</div>

</div><!-- /page -->
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX GENERATOR (All 8 Steps)
// ─────────────────────────────────────────────────────────────────────────────

function dHeading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_2): Paragraph {
  return new Paragraph({ text, heading: level, spacing: { before: 280, after: 120 } });
}

function dPara(text: string, opts: { bold?: boolean; color?: string; size?: number; mono?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({
      text: text || "—",
      bold: opts.bold,
      color: opts.color || "FFFFFF",
      size: opts.size || 20,
      font: opts.mono ? "Courier New" : "Calibri",
    })],
    spacing: { after: 80 },
  });
}

function dTable(headers: string[], rows: string[][]): Table {
  const hRow = new TableRow({
    children: headers.map(h => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 18 })] })],
      shading: { type: ShadingType.SOLID, color: "1E3A5F", fill: "1E3A5F" },
      borders: { top: { style: BorderStyle.SINGLE, size: 2, color: "3B82F6" }, bottom: { style: BorderStyle.SINGLE, size: 2, color: "3B82F6" }, left: { style: BorderStyle.SINGLE, size: 1, color: "3B82F6" }, right: { style: BorderStyle.SINGLE, size: 1, color: "3B82F6" } },
    })),
    tableHeader: true,
  });
  const dataRows = rows.map(r => new TableRow({
    children: r.map(c => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: c || "—", color: "FFFFFF", size: 18 })] })],
      shading: { type: ShadingType.SOLID, color: "0F172A", fill: "0F172A" },
      borders: { top: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, bottom: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, left: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, right: { style: BorderStyle.SINGLE, size: 1, color: "334155" } },
    })),
  }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [hRow, ...dataRows] });
}

function dKv(label: string, value: any): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, color: "94A3B8", size: 18 })] })],
        shading: { type: ShadingType.SOLID, color: "1E293B", fill: "1E293B" },
        width: { size: 30, type: WidthType.PERCENTAGE },
        borders: { top: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, bottom: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.SINGLE, size: 1, color: "3B82F6" } },
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: String(value ?? "—"), color: "FFFFFF", size: 18 })] })],
        shading: { type: ShadingType.SOLID, color: "0F172A", fill: "0F172A" },
        width: { size: 70, type: WidthType.PERCENTAGE },
        borders: { top: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, bottom: { style: BorderStyle.SINGLE, size: 1, color: "334155" }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
      }),
    ],
  });
}

function dKvTable(pairs: Array<[string, any]>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: pairs.filter(([, v]) => v != null && v !== "").map(([l, v]) => dKv(l, v)),
  });
}

function dSeparator(): Paragraph {
  return new Paragraph({ text: "─".repeat(80), spacing: { before: 200, after: 200 }, children: [new TextRun({ text: "─".repeat(80), color: "334155", size: 16 })] });
}

function dStepHeading(num: number, title: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `STEP ${num}  `, bold: true, color: "3B82F6", size: 26, font: "Courier New" }),
      new TextRun({ text: title.toUpperCase(), bold: true, color: "FFFFFF", size: 26 }),
    ],
    spacing: { before: 400, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "3B82F6", space: 4 } },
  });
}

function dTreeNode(node: any, depth = 0): Paragraph[] {
  if (!node) return [];
  const indent = "  ".repeat(depth);
  const prefix = depth === 0 ? "⬟" : node.type === "gate" ? "◈" : "◉";
  const prob = typeof node.probability === "number" ? ` [${(node.probability * 100).toFixed(1)}%]` : "";
  const gate = node.gateType ? ` (${node.gateType})` : "";
  const line = `${indent}${prefix} ${node.label}${gate}${prob}`;

  return [
    new Paragraph({
      children: [new TextRun({ text: line, color: depth === 0 ? "F59E0B" : node.type === "gate" ? "60A5FA" : "94A3B8", size: 18, font: "Courier New" })],
      spacing: { after: 40 },
    }),
    ...(Array.isArray(node.children) ? node.children.flatMap((c: any) => dTreeNode(c, depth + 1)) : []),
  ];
}

export async function generateFullAnalysisDocx(data: AllAgentData): Promise<Buffer> {
  const c = data.collector || {};
  const fw = data.fiveWhy || { messages: [] };
  const fb = data.fishbone || {};
  const ft = data.faultTree || {};
  const pa = data.pareto || {};
  const tl = data.timeline || {};
  const eq = data.equipment || {};
  const rpt = data.report || {};

  const fbCats: Record<string, any[]> = fb.fishbone || fb.categories || {};
  const paretoItems: Array<{ mode: string; frequency: number }> = pa.paretoAnalysis?.byFailureMode || pa.byFailureMode || [];
  const tlPhases: any[] = tl.timeline?.phases || tl.phases || [];
  const rm = eq.reliabilityMetrics || {};
  const rpn = rm.rpnScores || eq.rpnScores || {};
  const rptCore = rpt.rcaReport || rpt;
  const rcs: string[] = Array.isArray(rptCore.rootCauses) ? rptCore.rootCauses.filter(Boolean) : [rpt.rootCause || ""].filter(Boolean);
  const capaList: any[] = rptCore.actionPlan || rpt.correctiveActionsList || [];

  const whySummaryStream1 = rptCore.whyWhyAnalysis?.stream1 || {};
  const whySummaryStream2 = rptCore.whyWhyAnalysis?.stream2 || {};

  let ftaTree: any = null;
  if (ft.tree) ftaTree = ft.tree;
  else if (ft.faultTreeAnalysis?.tree) ftaTree = ft.faultTreeAnalysis.tree;
  else if (ft.faultTreeAnalysis) {
    const fta = ft.faultTreeAnalysis;
    ftaTree = { id: "top", label: fta.topEvent || "Failure Event", type: "gate", gateType: "OR", probability: 1.0, children: Array.isArray(fta.branches) ? fta.branches : [] };
  }

  const catLabels: Record<string, string> = { manpower: "Skill / Man", machine: "Design / Machine", methods: "Method", method: "Method", materials: "Material", material: "Material", measurements: "Measurement", measurement: "Measurement", environment: "Environment" };

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", color: "FFFFFF", size: 20 } } } },
    background: { color: "0F172A" },
    numbering: {
      config: [{
        reference: "bullet",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }],
      }],
    },
    sections: [{
      properties: {},
      children: [
        // ── Cover ──
        new Paragraph({
          children: [new TextRun({ text: "RCA.OPS · ROOT CAUSE ANALYSIS PLATFORM", color: "3B82F6", size: 20, bold: true, font: "Courier New" })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        }),
        new Paragraph({
          children: [new TextRun({ text: data.caseTitle, bold: true, size: 48, color: "FFFFFF" })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
        }),
        new Paragraph({
          children: [new TextRun({ text: "Complete 8-Step Analysis Report", size: 24, color: "94A3B8" })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        }),
        dKvTable([
          ["Asset / Equipment", data.assetId || "—"],
          ["Equipment Name", c.equipmentName || "—"],
          ["Location", c.location || "—"],
          ["Incident Timestamp", c.timestamp || "—"],
          ["Generated", data.generatedAt],
        ]),

        new Paragraph({ children: [new PageBreak()] }),

        // ── Step 1: Data Collection ──
        dStepHeading(1, "Data Collection & Validation"),
        dKvTable([
          ["Problem Statement", c.problemStatement],
          ["Effect / Impact", c.effect],
          ["Equipment Name", c.equipmentName],
          ["Location / Process Unit", c.location],
          ["Operating Conditions", c.operatingConditions],
          ["Incident Timestamp", c.timestamp],
          ["Witnessed Symptoms", c.witnessedSymptoms],
          ["Maintenance History Checked", c.maintenanceHistoryChecked ? "Yes" : "No"],
        ]),
        ...(Array.isArray(c.gaps) && c.gaps.length ? [
          dPara(""),
          dPara("Identified Gaps:", { bold: true, color: "F59E0B" }),
          ...c.gaps.map((g: string) => new Paragraph({ children: [new TextRun({ text: `• ${g}`, color: "FBB60A", size: 18 })], spacing: { after: 60 }, numbering: undefined })),
        ] : []),
        ...(Array.isArray(c.followUps) && c.followUps.length ? [
          dPara(""),
          dPara("Suggested Follow-Ups:", { bold: true, color: "60A5FA" }),
          ...c.followUps.map((f: string) => new Paragraph({ children: [new TextRun({ text: `• ${f}`, color: "93C5FD", size: 18 })], spacing: { after: 60 } })),
        ] : []),

        dSeparator(),

        // ── Step 2: 5-Why ──
        dStepHeading(2, "5-Why Root Cause Analysis"),
        rptCore.whyWhyAnalysis?.problem ? dPara(`Problem: ${rptCore.whyWhyAnalysis.problem}`, { bold: true, color: "E2E8F0" }) : dPara(""),

        ...(Object.values(whySummaryStream1).some(Boolean)
          ? [
            dPara("Stream 1 — Primary Why Chain:", { bold: true, color: "F59E0B" }),
            ...Object.entries(whySummaryStream1)
              .filter(([, v]) => v)
              .map(([k, v]) => new Paragraph({
                children: [
                  new TextRun({ text: `${k.replace("why", "Why ")}  `, bold: true, color: "F59E0B", size: 18, font: "Courier New" }),
                  new TextRun({ text: String(v), color: "FFFFFF", size: 18 }),
                ],
                spacing: { after: 80 },
              })),
            ...(Object.values(whySummaryStream2).some(Boolean) ? [
              dPara(""),
              dPara("Stream 2 — Contributing Chain:", { bold: true, color: "A78BFA" }),
              ...Object.entries(whySummaryStream2)
                .filter(([, v]) => v)
                .map(([k, v]) => new Paragraph({
                  children: [
                    new TextRun({ text: `${k.replace("why", "Why ")}  `, bold: true, color: "A78BFA", size: 18, font: "Courier New" }),
                    new TextRun({ text: String(v), color: "FFFFFF", size: 18 }),
                  ],
                  spacing: { after: 80 },
                })),
            ] : []),
          ]
          : [dPara("No 5-Why data captured yet.", { color: "64748B" })]),

        dSeparator(),

        // ── Step 3: Fishbone ──
        dStepHeading(3, "Fishbone / Ishikawa Cause Analysis"),
        ...(Object.keys(fbCats).length
          ? Object.entries(fbCats).flatMap(([key, causes]) => {
            if (!Array.isArray(causes) || !causes.length) return [];
            return [
              dPara(catLabels[key] || key, { bold: true, color: "60A5FA" }),
              ...causes.map((cause: any) => {
                const name = typeof cause === "string" ? cause : cause.cause || "";
                const subs: string[] = typeof cause === "object" ? (cause.subCauses || []) : [];
                return new Paragraph({
                  children: [
                    new TextRun({ text: `  • ${name}`, color: "FFFFFF", size: 18 }),
                    ...(subs.length ? [new TextRun({ text: `  ↳ ${subs.join(", ")}`, color: "94A3B8", size: 16 })] : []),
                  ],
                  spacing: { after: 60 },
                });
              }),
              new Paragraph({ text: "", spacing: { after: 120 } }),
            ];
          })
          : [dPara("No Fishbone data captured yet.", { color: "64748B" })]),

        dSeparator(),

        // ── Step 4: FTA ──
        dStepHeading(4, "Fault Tree Analysis (FTA)"),
        ...(ftaTree
          ? dTreeNode(ftaTree)
          : [dPara("No FTA tree data captured yet.", { color: "64748B" })]),

        dSeparator(),

        // ── Step 5: Pareto ──
        dStepHeading(5, "Pareto Analysis"),
        ...(paretoItems.length
          ? [dTable(
            ["Failure Mode", "Frequency", "% of Total"],
            (() => {
              const total = paretoItems.reduce((s, i) => s + (i.frequency || 0), 0);
              return paretoItems.map((item) => [
                item.mode,
                String(item.frequency),
                total > 0 ? `${((item.frequency / total) * 100).toFixed(1)}%` : "—",
              ]);
            })()
          )]
          : [dPara("No Pareto data captured yet.", { color: "64748B" })]),

        dSeparator(),

        // ── Step 6: Timeline ──
        dStepHeading(6, "Incident Timeline"),
        ...(tlPhases.length
          ? tlPhases.flatMap((phase: any) => [
            new Paragraph({
              children: [
                new TextRun({ text: phase.phase, bold: true, color: "60A5FA", size: 22 }),
                new TextRun({ text: `  ${phase.start || ""} · ${phase.duration || ""}`, color: "94A3B8", size: 18 }),
              ],
              spacing: { before: 200, after: 80 },
            }),
            phase.description ? dPara(phase.description, { color: "94A3B8" }) : new Paragraph({ text: "" }),
            ...(Array.isArray(phase.events) ? phase.events.map((e: string) => new Paragraph({
              children: [new TextRun({ text: `  • ${e}`, color: "FFFFFF", size: 18 })],
              spacing: { after: 60 },
            })) : []),
          ])
          : [dPara("No Timeline data captured yet.", { color: "64748B" })]),

        dSeparator(),

        // ── Step 7: Equipment ──
        dStepHeading(7, "Equipment Reliability & RPN Analysis"),
        ...((rm.mtbf || rm.mttr || rm.availability || rm.failureRate)
          ? [dKvTable([
            ["MTBF", `${rm.mtbf?.value || "—"}  ${rm.mtbf?.trend ? `(${rm.mtbf.trend})` : ""}`],
            ["MTTR", `${rm.mttr?.value || "—"}  ${rm.mttr?.trend ? `(${rm.mttr.trend})` : ""}`],
            ["Availability", `${rm.availability?.value || "—"}  ${rm.availability?.trend ? `(${rm.availability.trend})` : ""}`],
            ["Failure Rate", `${rm.failureRate?.value || "—"}  ${rm.failureRate?.trend ? `(${rm.failureRate.trend})` : ""}`],
          ])]
          : []),
        ...(Object.keys(rpn).length
          ? [
            dPara(""),
            dPara("RPN Scores (Risk Priority Number, 1–100):", { bold: true, color: "EC4899" }),
            dTable(["Component", "RPN Score", "Risk Level"],
              Object.entries(rpn).map(([k, v]) => {
                const s = Number(v) || 0;
                return [k, String(s), s >= 70 ? "HIGH" : s >= 40 ? "MEDIUM" : "LOW"];
              })
            ),
          ]
          : []),
        ...(!rm.mtbf && !Object.keys(rpn).length ? [dPara("No Equipment data captured yet.", { color: "64748B" })] : []),

        dSeparator(),

        // ── Step 8: Report ──
        dStepHeading(8, "RCA Executive Report & CAPA"),
        ...(rcs.length ? [
          dPara("Identified Root Causes:", { bold: true, color: "EF4444" }),
          ...rcs.map((rc, i) => new Paragraph({
            children: [new TextRun({ text: `${i + 1}. ${rc}`, color: "FCA5A5", size: 20, bold: true })],
            spacing: { after: 100 },
          })),
          dPara(""),
        ] : []),
        ...((rptCore.header?.rcaNumber || rptCore.equipment?.name) ? [
          dKvTable([
            ["RCA Number", rptCore.header?.rcaNumber],
            ["Plant", rptCore.header?.plant],
            ["Department", rptCore.header?.department],
            ["Equipment", rptCore.equipment?.name],
            ["Occurrence", rptCore.equipment?.occurrenceDateTime],
            ["Restoration", rptCore.equipment?.restorationDateTime],
            ["Production Affected", rptCore.equipment?.productionAffectedHours],
          ]),
          dPara(""),
        ] : []),
        ...(capaList.length ? [
          dPara("CAPA Action Plan:", { bold: true, color: "3B82F6" }),
          dTable(
            ["#", "Action", "Type", "Responsible", "Department", "Target", "Status"],
            capaList.map((a: any, idx: number) => [
              String(a.srNo ?? idx + 1),
              a.action || a.desc || "—",
              a.type || "CA",
              a.responsible || a.owner || "—",
              a.department || a.dept || "—",
              a.target || a.date || "—",
              a.status || "Pending",
            ])
          ),
        ] : [dPara("No CAPA data captured yet.", { color: "64748B" })]),

        ...((rptCore.horizontalDeployment || rptCore.preventiveMeasures) ? [
          dPara(""),
          dKvTable([
            ["Horizontal Deployment", rptCore.horizontalDeployment],
            ["Preventive Measures", rptCore.preventiveMeasures],
            ["Sustainable Measures (SOP/SMP)", rptCore.sustainableMeasures],
            ["FMEA Update Required?", rptCore.changesRequiredInFMEA],
          ]),
        ] : []),

        new Paragraph({ text: "", spacing: { before: 600 } }),
        new Paragraph({
          children: [new TextRun({ text: `Generated by RCA.OPS Platform · ${data.generatedAt}`, color: "475569", size: 16, italics: true })],
          alignment: AlignmentType.CENTER,
        }),
      ],
    }],
  });

  return await Packer.toBuffer(doc);
}
