/**
 * RCA Report generation utilities.
 * Produces the HZL "Failure Analysis" report in .xlsx / .docx / .html from the
 * AI-generated rcaReport JSON. All three formats share one normalized model
 * (normalizeReport) and a single light theme that mirrors the on-screen report.
 */
import ExcelJS from "exceljs";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
  ImageRun,
} from "docx";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RcaReportData {
  header: {
    rcaNumber: string;
    plant: string;
    initiationDate: string;
    submissionDate: string;
    department: string;
    section: string;
    z2NotificationNumber?: string;
    zrNumber?: string;
  };
  equipment: {
    number: string;
    name: string;
    occurrenceDateTime: string;
    restorationDateTime: string;
    productionAffectedHours: string;
    affectsProduction: string;
  };
  problemDescription: string;
  immediateActions: Array<{ action: string; who: string; when: string }>;
  costOfFailure: {
    sparePartCost: number | string;
    serviceCost: number | string;
    manpowerCost: number | string;
    productionLoss: number | string;
    totalBreakdownCost?: number | string;
  };
  chronologyEvents: Array<{ srNo: number; event: string; date: string; time: string }>;
  teamMembers: Array<{ no: number; name: string; department: string; type: string }>;
  maintenanceHistory: {
    coveredInPM?: string;
    lastPMDate: string;
    lastPMObservations: string;
    coveredInCBM?: string;
    cbmDate: string;
    cbmStatus: string;
    rootCauseIdentifiableByCBM: string;
  };
  lastFailure: { date: string; detail: string; rootCause: string };
  fmeaExists: string;
  currentFailureInFMEA: string;
  whyWhyAnalysis: {
    problem: string;
    stream1: Record<string, string>;
    stream2: Record<string, string>;
  };
  rootCauses: string[];
  fishboneCategories: Record<string, string[]>;
  rootCauseCloseout: { selectedCategories: string[] };
  actionPlan: Array<{
    srNo: number;
    action: string;
    type: string;
    classification: string;
    responsible: string;
    department: string;
    target: string;
    status: string;
  }>;
  horizontalDeployment: string;
  preventiveMeasures: string;
  sustainableMeasures: string;
  externalInvestigationRequired: string;
  externalTestingRequired: string;
  changesRequiredInODC: string;
  changesRequiredInFMEA: string;
  totalBreakdownTimeHours?: string;
  rootCause?: string;
  correctiveActionsList?: any[];
}

export interface ReportImage {
  buffer: Buffer;
  extension: "png" | "jpeg" | "gif";
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizer — raw agent JSON + incident metadata → RcaReportData
// ─────────────────────────────────────────────────────────────────────────────

const DASH = "—";

export function normalizeReport(
  reportJson: any,
  incidentMeta: any = {},
  rcaCase: { title?: string; asset_id?: string } = {},
): RcaReportData {
  const raw = reportJson?.rcaReport || reportJson || {};
  const today = new Date().toISOString().split("T")[0];

  const actionPlan: RcaReportData["actionPlan"] = Array.isArray(raw.actionPlan) && raw.actionPlan.length
    ? raw.actionPlan.map((a: any, i: number) => ({
        srNo: a.srNo ?? i + 1,
        action: a.action || a.desc || a.description || "",
        type: a.type || "CA",
        classification: a.classification || "NA",
        responsible: a.responsible || a.owner || DASH,
        department: a.department || a.dept || DASH,
        target: a.target || a.date || DASH,
        status: a.status || "Pending",
      }))
    : (Array.isArray(reportJson?.correctiveActionsList) ? reportJson.correctiveActionsList : []).map(
        (a: any, i: number) => ({
          srNo: i + 1,
          action: typeof a === "string" ? a : a.desc || a.description || a.action || "",
          type: a.type || "CA",
          classification: a.classification || "NA",
          responsible: a.owner || a.responsible || DASH,
          department: a.dept || a.department || DASH,
          target: a.date || a.target || DASH,
          status: a.status || "Pending",
        }),
      );

  return {
    header: {
      rcaNumber: raw.header?.rcaNumber || `RCA/${today}`,
      plant: raw.header?.plant || incidentMeta.location || DASH,
      initiationDate: raw.header?.initiationDate || today,
      submissionDate: raw.header?.submissionDate || today,
      department: raw.header?.department || incidentMeta.department || DASH,
      section: raw.header?.section || incidentMeta.location || DASH,
      z2NotificationNumber: raw.header?.z2NotificationNumber || "",
      zrNumber: raw.header?.zrNumber || "",
    },
    equipment: {
      number: raw.equipment?.number || rcaCase.asset_id || DASH,
      name: raw.equipment?.name || incidentMeta.equipmentName || rcaCase.title || DASH,
      occurrenceDateTime: raw.equipment?.occurrenceDateTime || incidentMeta.timestamp || DASH,
      restorationDateTime: raw.equipment?.restorationDateTime || DASH,
      productionAffectedHours: raw.equipment?.productionAffectedHours || DASH,
      affectsProduction: raw.equipment?.affectsProduction || DASH,
    },
    problemDescription:
      raw.problemDescription || reportJson?.rootCause || incidentMeta.problemStatement || DASH,
    immediateActions: Array.isArray(raw.immediateActions) ? raw.immediateActions : [],
    costOfFailure: {
      sparePartCost: raw.costOfFailure?.sparePartCost ?? 0,
      serviceCost: raw.costOfFailure?.serviceCost ?? 0,
      manpowerCost: raw.costOfFailure?.manpowerCost ?? 0,
      productionLoss: raw.costOfFailure?.productionLoss ?? 0,
      totalBreakdownCost: raw.costOfFailure?.totalBreakdownCost,
    },
    chronologyEvents: Array.isArray(raw.chronologyEvents) ? raw.chronologyEvents : [],
    teamMembers: Array.isArray(raw.teamMembers) ? raw.teamMembers : [],
    maintenanceHistory: {
      coveredInPM: raw.maintenanceHistory?.coveredInPM,
      lastPMDate: raw.maintenanceHistory?.lastPMDate || DASH,
      lastPMObservations: raw.maintenanceHistory?.lastPMObservations || DASH,
      coveredInCBM: raw.maintenanceHistory?.coveredInCBM,
      cbmDate: raw.maintenanceHistory?.cbmDate || DASH,
      cbmStatus: raw.maintenanceHistory?.cbmStatus || DASH,
      rootCauseIdentifiableByCBM: raw.maintenanceHistory?.rootCauseIdentifiableByCBM || DASH,
    },
    lastFailure: {
      date: raw.lastFailure?.date || DASH,
      detail: raw.lastFailure?.detail || DASH,
      rootCause: raw.lastFailure?.rootCause || DASH,
    },
    fmeaExists: raw.fmeaExists || "NA",
    currentFailureInFMEA: raw.currentFailureInFMEA || "NA",
    whyWhyAnalysis: raw.whyWhyAnalysis || {
      problem: incidentMeta.problemStatement || DASH,
      stream1: {},
      stream2: {},
    },
    rootCauses: Array.isArray(raw.rootCauses)
      ? raw.rootCauses.filter(Boolean)
      : [reportJson?.rootCause || DASH].filter(Boolean),
    fishboneCategories: raw.fishboneCategories || {},
    rootCauseCloseout: raw.rootCauseCloseout || { selectedCategories: [] },
    actionPlan,
    horizontalDeployment: raw.horizontalDeployment || DASH,
    preventiveMeasures: raw.preventiveMeasures || DASH,
    sustainableMeasures: raw.sustainableMeasures || DASH,
    externalInvestigationRequired: raw.externalInvestigationRequired || "No",
    externalTestingRequired: raw.externalTestingRequired || "No",
    changesRequiredInODC: raw.changesRequiredInODC || "No",
    changesRequiredInFMEA: raw.changesRequiredInFMEA || "No",
    totalBreakdownTimeHours: raw.totalBreakdownTimeHours,
    rootCause: reportJson?.rootCause,
    correctiveActionsList: reportJson?.correctiveActionsList,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared light "HZL" palette
// ─────────────────────────────────────────────────────────────────────────────

const BAND = "2E75B6"; // section band — medium blue, white text
const SUBHEAD = "BDD7EE"; // sub-header — light blue, black text
const LABEL = "DDEBF7"; // label cell — very light blue
const RED = "C00000"; // "Problem" marker
const YELLOW = "FFFF00"; // pursuit band
const WHITE = "FFFFFF";
const BLACK = "000000";
const BORDER = "808080";

const FB_LABELS: Record<string, string> = {
  manpower: "Man",
  machine: "Design / Machine",
  method: "Method",
  methods: "Method",
  material: "Material",
  materials: "Material",
  measurement: "Measurement",
  measurements: "Measurement",
  environment: "Environment",
};
const FB_ORDER = ["manpower", "machine", "method", "material", "measurement", "environment"];

function fbVal(cats: Record<string, string[]>, key: string): string[] {
  // tolerate singular/plural variants
  const alt = key.endsWith("s") ? key.slice(0, -1) : key + "s";
  return (cats[key] || cats[alt] || []) as string[];
}

const WHY_KEYS = ["why1", "why2", "why3", "why4", "why5", "why6", "why7", "why8", "why9"];

// ═════════════════════════════════════════════════════════════════════════════
// XLSX — HZL Failure Analysis template
// ═════════════════════════════════════════════════════════════════════════════

const COLS = 14; // A..N
const colLetter = (i: number) => String.fromCharCode(65 + i); // 0->A

export async function generateRcaXlsx(report: RcaReportData, image?: ReportImage): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "RCA.OPS";
  wb.created = new Date();
  const ws = wb.addWorksheet("Failure Analysis", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
  });
  ws.properties.defaultRowHeight = 16;
  ws.columns = [
    { width: 5 }, { width: 22 }, { width: 12 }, { width: 11 }, { width: 22 },
    { width: 12 }, { width: 10 }, { width: 14 }, { width: 10 }, { width: 12 },
    { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 },
  ];

  const thin = { style: "thin" as const, color: { argb: `FF${BORDER}` } };
  const allBorders = { top: thin, bottom: thin, left: thin, right: thin };

  let r = 1;
  const A = (n: number) => `${colLetter(n)}${r}`;

  const band = (text: string, fill = BAND, color = WHITE, height = 20) => {
    ws.mergeCells(`A${r}:${colLetter(COLS - 1)}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = text;
    c.font = { bold: true, color: { argb: `FF${color}` }, size: 11, name: "Calibri" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${fill}` } };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = allBorders;
    ws.getRow(r).height = height;
    r++;
  };

  // label cell at column index `col`, value spanning to `endCol`
  const labelCell = (col: number, text: string, fill = LABEL, color = BLACK) => {
    const c = ws.getCell(A(col));
    c.value = text;
    c.font = { bold: true, color: { argb: `FF${color}` }, size: 9, name: "Calibri" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${fill}` } };
    c.alignment = { vertical: "middle", wrapText: true };
    c.border = allBorders;
    return c;
  };
  const valueCell = (col: number, text: string | number, opts: { bold?: boolean; align?: "left" | "center" } = {}) => {
    const c = ws.getCell(A(col));
    c.value = text ?? "";
    c.font = { color: { argb: `FF${BLACK}` }, size: 9, name: "Calibri", bold: !!opts.bold };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${WHITE}` } };
    c.alignment = { vertical: "middle", wrapText: true, horizontal: opts.align || "left" };
    c.border = allBorders;
    return c;
  };
  const subHead = (col: number, text: string) => {
    const c = ws.getCell(A(col));
    c.value = text;
    c.font = { bold: true, color: { argb: `FF${BLACK}` }, size: 9, name: "Calibri" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${SUBHEAD}` } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    c.border = allBorders;
    return c;
  };
  const merge = (c1: number, c2: number) => ws.mergeCells(`${colLetter(c1)}${r}:${colLetter(c2)}${r}`);

  // ── Title ──
  ws.mergeCells(`A${r}:${colLetter(COLS - 1)}${r}`);
  const title = ws.getCell(`A${r}`);
  title.value = "Failure Analysis";
  title.font = { bold: true, size: 16, color: { argb: `FF${BLACK}` }, name: "Calibri" };
  title.alignment = { horizontal: "center", vertical: "middle" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${SUBHEAD}` } };
  title.border = allBorders;
  ws.getRow(r).height = 26;
  r++;

  // ── Identity block ──
  // Row: Z2 | val | ZR | val | RCA Number | val
  labelCell(0, "Z2 Notification Number"); merge(0, 1);
  valueCell(2, report.header.z2NotificationNumber || ""); merge(2, 4);
  labelCell(5, "ZR Notification Number"); merge(5, 6);
  valueCell(7, report.header.zrNumber || ""); merge(7, 9);
  labelCell(10, "RCA Number"); merge(10, 10);
  valueCell(11, report.header.rcaNumber, { bold: true }); merge(11, 13);
  ws.getRow(r).height = 18; r++;

  labelCell(0, "Equipment Number"); merge(0, 1);
  valueCell(2, report.equipment.number, { bold: true, align: "center" }); merge(2, 4);
  labelCell(5, "Name of the equipment"); merge(5, 6);
  valueCell(7, report.equipment.name); merge(7, 9);
  labelCell(10, "RCA initiation Date"); merge(10, 10);
  valueCell(11, report.header.initiationDate, { align: "center" }); merge(11, 13);
  ws.getRow(r).height = 18; r++;

  labelCell(0, "Date & time of Occurance"); merge(0, 1);
  valueCell(2, report.equipment.occurrenceDateTime, { align: "center" }); merge(2, 4);
  labelCell(5, "Total Breakdown Time ( in Hour)"); merge(5, 6);
  valueCell(7, report.totalBreakdownTimeHours || ""); merge(7, 9);
  labelCell(10, "Plant"); merge(10, 10);
  valueCell(11, report.header.plant, { align: "center" }); merge(11, 13);
  ws.getRow(r).height = 18; r++;

  labelCell(0, "Date & time of Restoration"); merge(0, 1);
  valueCell(2, report.equipment.restorationDateTime, { align: "center" }); merge(2, 4);
  labelCell(5, "Affecting Production or not"); merge(5, 6);
  valueCell(7, report.equipment.affectsProduction, { align: "center" }); merge(7, 9);
  labelCell(10, "Department"); merge(10, 10);
  valueCell(11, report.header.department); merge(11, 12);
  valueCell(13, report.header.section);
  ws.getRow(r).height = 18; r++;

  // ── Problem / Corrective action bands ──
  const problemBandRow = r;
  ws.mergeCells(`A${r}:F${r}`);
  let pc = ws.getCell(`A${r}`);
  pc.value = "Clear description of Problem";
  pc.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
  pc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BAND}` } };
  pc.alignment = { horizontal: "center", vertical: "middle" };
  pc.border = allBorders;
  ws.mergeCells(`G${r}:N${r}`);
  let ac = ws.getCell(`G${r}`);
  ac.value = "Action taken for Restoration: Corrective Action";
  ac.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
  ac.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BAND}` } };
  ac.alignment = { horizontal: "center", vertical: "middle" };
  ac.border = allBorders;
  ws.getRow(r).height = 18; r++;

  // sub-row: problem text (left A:F) + What/Who/When sub-headers (right)
  const act0 = report.immediateActions[0] || { action: DASH, who: DASH, when: DASH };
  valueCell(0, report.problemDescription);
  subHead(6, "What"); merge(6, 9);
  subHead(10, "Who"); merge(10, 11);
  subHead(12, "When"); merge(12, 13);
  ws.getRow(r).height = 28; r++;

  // value row: action values (right). Left A:F merges vertically with the problem text above.
  valueCell(6, act0.action); merge(6, 9);
  valueCell(10, act0.who); merge(10, 11);
  valueCell(12, act0.when); merge(12, 13);
  ws.getRow(r).height = 28;
  ws.mergeCells(`A${problemBandRow + 1}:F${r}`);
  r++;

  // ── Chronology ──
  band("Chronology of Key Events - beginning with the clear symptoms to the resolutions");
  // two side-by-side tables
  subHead(0, "Sr. No.");
  subHead(1, "Events"); merge(1, 4);
  subHead(5, "Date");
  subHead(6, "Time");
  subHead(7, "Sr. No.");
  subHead(8, "Events"); merge(8, 11);
  subHead(12, "Date");
  subHead(13, "Time");
  ws.getRow(r).height = 16; r++;

  const ev = report.chronologyEvents;
  const half = Math.ceil(ev.length / 2);
  const rowsNeeded = Math.max(half, ev.length - half, 1);
  for (let i = 0; i < rowsNeeded; i++) {
    const left = ev[i];
    const right = ev[half + i];
    valueCell(0, left ? left.srNo : "", { align: "center" });
    valueCell(1, left ? left.event : ""); merge(1, 4);
    valueCell(5, left ? left.date : "", { align: "center" });
    valueCell(6, left ? left.time : "", { align: "center" });
    valueCell(7, right ? right.srNo : "", { align: "center" });
    valueCell(8, right ? right.event : ""); merge(8, 11);
    valueCell(12, right ? right.date : "", { align: "center" });
    valueCell(13, right ? right.time : "", { align: "center" });
    ws.getRow(r).height = 20; r++;
  }

  // ── Cost of Failure ──
  band("Cost of Failure");
  labelCell(0, "Total Breakdown Cost ( Rupees )"); merge(0, 1);
  valueCell(2, report.costOfFailure.totalBreakdownCost ?? ""); merge(2, 3);
  labelCell(4, "Production Loss (in ₹ Lakhs)");
  valueCell(5, report.costOfFailure.productionLoss); merge(5, 6);
  labelCell(7, "Spare Part Cost (in ₹ Lakhs)");
  valueCell(8, report.costOfFailure.sparePartCost); merge(8, 9);
  labelCell(10, "Manpower Cost (in ₹ Lakhs)");
  valueCell(11, report.costOfFailure.manpowerCost);
  labelCell(12, "Service Cost (in ₹ Lakhs)");
  valueCell(13, report.costOfFailure.serviceCost);
  ws.getRow(r).height = 24; r++;

  // ── Team members + Maintenance history bands ──
  ws.mergeCells(`A${r}:F${r}`);
  let tmb = ws.getCell(`A${r}`);
  tmb.value = "Team members"; tmb.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
  tmb.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BAND}` } };
  tmb.alignment = { horizontal: "center", vertical: "middle" }; tmb.border = allBorders;
  ws.mergeCells(`G${r}:N${r}`);
  let mhb = ws.getCell(`G${r}`);
  mhb.value = "Brief Maintenance History"; mhb.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
  mhb.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BAND}` } };
  mhb.alignment = { horizontal: "center", vertical: "middle" }; mhb.border = allBorders;
  ws.getRow(r).height = 18; r++;

  // team header row + maintenance rows interleaved
  const team = report.teamMembers;
  const mh = report.maintenanceHistory;
  const mhRows: Array<[string, string, string, string]> = [
    ["Covered in PM", mh.coveredInPM || DASH, "Covered in CBM", mh.coveredInCBM || DASH],
    ["PM Date", mh.lastPMDate, "CBM Date", mh.cbmDate],
    ["Observation:", mh.lastPMObservations, "CBM status/result", mh.cbmStatus],
    ["", "", "Root Cause can be identified by CBM?", mh.rootCauseIdentifiableByCBM],
  ];
  // header row (team col headers + first MH row)
  subHead(0, "Sr.No.");
  subHead(1, "Name"); merge(1, 3);
  subHead(4, "Dept");
  subHead(5, "HZL/BP");
  // right side: first mh row
  labelCell(6, mhRows[0][0]); merge(6, 7);
  valueCell(8, mhRows[0][1], { align: "center" }); merge(8, 9);
  labelCell(10, mhRows[0][2]); merge(10, 12);
  valueCell(13, mhRows[0][3], { align: "center" });
  ws.getRow(r).height = 16; r++;

  const teamRowsCount = Math.max(team.length, 6);
  for (let i = 0; i < teamRowsCount; i++) {
    const tm = team[i];
    valueCell(0, tm ? tm.no : i + 1, { align: "center" });
    valueCell(1, tm ? tm.name : ""); merge(1, 3);
    valueCell(4, tm ? tm.department : "", { align: "center" });
    valueCell(5, tm ? tm.type : "", { align: "center" });
    // right side mapping
    if (i < mhRows.length - 1) {
      const m = mhRows[i + 1];
      labelCell(6, m[0]); merge(6, 7);
      valueCell(8, m[1], { align: "center" }); merge(8, 9);
      labelCell(10, m[2]); merge(10, 12);
      valueCell(13, m[3], { align: "center" });
    } else if (i === mhRows.length - 1) {
      // Last Failure band on the right
      ws.mergeCells(`G${r}:N${r}`);
      const lf = ws.getCell(`G${r}`);
      lf.value = "Last Failure Detail";
      lf.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 10 };
      lf.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BAND}` } };
      lf.alignment = { horizontal: "center", vertical: "middle" }; lf.border = allBorders;
    } else if (i === mhRows.length) {
      labelCell(6, "Date"); merge(6, 7);
      valueCell(8, report.lastFailure.date, { align: "center" }); merge(8, 9);
      labelCell(10, "Root Cause of Last failure"); merge(10, 11);
      valueCell(12, report.lastFailure.rootCause); merge(12, 13);
    } else if (i === mhRows.length + 1) {
      labelCell(6, "Detail"); merge(6, 7);
      valueCell(8, report.lastFailure.detail); merge(8, 13);
    } else {
      // fill blank right side
      valueCell(6, ""); merge(6, 13);
    }
    ws.getRow(r).height = 18; r++;
  }

  // FMEA rows
  labelCell(0, "Is FMEA analysis done for this equipment"); merge(0, 9);
  valueCell(10, report.fmeaExists, { align: "center" }); merge(10, 13);
  ws.getRow(r).height = 16; r++;
  labelCell(0, "Is the current Failure mode identified in existing FMEA"); merge(0, 9);
  valueCell(10, report.currentFailureInFMEA, { align: "center" }); merge(10, 13);
  ws.getRow(r).height = 16; r++;

  // ── Breakdown photographs ──
  band("Breakdown the problem (Observation and Photographs)");
  if (image) {
    const imgId = wb.addImage({ buffer: image.buffer as any, extension: image.extension });
    const imgTopRow = r - 1; // place starting at current row
    // reserve rows for the image
    for (let k = 0; k < 10; k++) { ws.getRow(r + k).height = 18; }
    ws.addImage(imgId, {
      tl: { col: 0.2, row: imgTopRow + 0.2 } as any,
      ext: { width: 420, height: 230 },
    });
    r += 11;
  }

  // ── Pursuit of root cause (yellow band) ──
  band("Pursuit of most important cause : Use of Any quality tools for identification of proper root cause", YELLOW, BLACK);

  // Problem (red label)
  labelCell(0, "Problem", RED, WHITE);
  valueCell(1, report.whyWhyAnalysis.problem || report.problemDescription, { bold: true }); merge(1, 13);
  ws.getRow(r).height = 18; r++;

  // Why rows (two columns: this level | resulting next level)
  const s1 = report.whyWhyAnalysis.stream1 || {};
  for (let i = 0; i < WHY_KEYS.length; i++) {
    const key = WHY_KEYS[i];
    const cur = s1[key] || "";
    const next = s1[WHY_KEYS[i + 1]] || "";
    if (!cur && i > 4) break; // always show at least 5
    labelCell(0, `Why-${i + 1}`);
    valueCell(1, cur); merge(1, 6);
    valueCell(7, next); merge(7, 13);
    ws.getRow(r).height = 20; r++;
  }

  // Identified root causes
  band("Identified Root Cause(s)");
  const rcs = report.rootCauses.length ? report.rootCauses : [DASH];
  for (let i = 0; i < Math.max(rcs.length, 1); i++) {
    valueCell(0, i + 1, { align: "center" });
    valueCell(1, rcs[i] || ""); merge(1, 13);
    ws.getRow(r).height = 20; r++;
  }

  // ── 6M categories ── (6 categories across A..N, 2 cols each; last spans to N)
  band("Fishbone / 6M Cause Categories");
  const fbColPairs: Array<[number, number]> = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 13]];
  FB_ORDER.forEach((key, i) => {
    const [s, e] = fbColPairs[i];
    const c = ws.getCell(A(s));
    c.value = FB_LABELS[key];
    c.font = { bold: true, color: { argb: `FF${WHITE}` }, size: 9 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BAND}` } };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = allBorders;
    if (e > s) merge(s, e);
  });
  ws.getRow(r).height = 18; r++;

  const fbData = FB_ORDER.map((k) => fbVal(report.fishboneCategories, k));
  const fbMax = Math.max(...fbData.map((a) => a.length), 1);
  for (let row = 0; row < fbMax; row++) {
    FB_ORDER.forEach((key, i) => {
      const [s, e] = fbColPairs[i];
      valueCell(s, fbData[i][row] || "");
      if (e > s) merge(s, e);
    });
    ws.getRow(r).height = 18; r++;
  }

  // ── Root cause resolution actions ──
  band("Root Cause Resolution Actions");
  subHead(0, "Sr.No.");
  subHead(1, "Action Plan for RCA"); merge(1, 4);
  subHead(5, "Type");
  subHead(6, "Classification"); merge(6, 7);
  subHead(8, "Responsibility"); merge(8, 9);
  subHead(10, "Dept");
  subHead(11, "Target");
  subHead(12, "Status"); merge(12, 13);
  ws.getRow(r).height = 24; r++;

  const ap = report.actionPlan.length ? report.actionPlan : [];
  for (const act of ap) {
    valueCell(0, act.srNo, { align: "center" });
    valueCell(1, act.action); merge(1, 4);
    valueCell(5, act.type, { align: "center" });
    valueCell(6, act.classification); merge(6, 7);
    valueCell(8, act.responsible); merge(8, 9);
    valueCell(10, act.department, { align: "center" });
    valueCell(11, act.target, { align: "center" });
    valueCell(12, act.status, { align: "center" }); merge(12, 13);
    ws.getRow(r).height = 26; r++;
  }

  // ── Deployment / measures ──
  band("Deployment & Sustainable Measures");
  const yn = (v: string) => (v && /yes|required|true/i.test(v) ? "Yes, Required" : v || "No");
  const deploy: Array<[string, string]> = [
    ["Horizontal Deployment", yn(report.horizontalDeployment)],
    ["Preventive/Predictive Measures", report.preventiveMeasures],
    ["Sustainable Measures (SOP/SMP)", report.sustainableMeasures],
    ["External (2nd / 3rd party) Investigation Reqd.", yn(report.externalInvestigationRequired)],
    ["External Testing Required", yn(report.externalTestingRequired)],
    ["Changes required in ODC", yn(report.changesRequiredInODC)],
    ["Changes required in FMEA", yn(report.changesRequiredInFMEA)],
  ];
  for (const [l, v] of deploy) {
    labelCell(0, l); merge(0, 4);
    valueCell(5, v); merge(5, 13);
    ws.getRow(r).height = 22; r++;
  }

  // ── Declaration + signatures ──
  band(
    "I hereby declare that the above root cause is best as per my knowledge and all the possible counter measures are being taken to prevent such type of failure.",
    SUBHEAD,
    BLACK,
    30,
  );
  const sigs = [
    "Signature of RCA Initiator & Date",
    "Signature of HOD & Date",
    "Signature of Head / Lead AO & Date",
    "Signature of Reliability Engineer & Date",
  ];
  // signature labels across 4 groups
  const sigPairs: Array<[number, number]> = [[0, 2], [3, 6], [7, 9], [10, 13]];
  ws.getRow(r).height = 40;
  sigs.forEach((s, i) => {
    const [a, b] = sigPairs[i];
    const c = ws.getCell(A(a));
    c.value = s;
    c.font = { bold: true, size: 8, color: { argb: `FF${BLACK}` } };
    c.alignment = { horizontal: "center", vertical: "bottom", wrapText: true };
    c.border = { top: thin, bottom: thin, left: thin, right: thin };
    merge(a, b);
  });
  r++;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML — clean light report (also used as the PDF source)
// ═════════════════════════════════════════════════════════════════════════════

function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function generateRcaHtml(report: RcaReportData, imageDataUri?: string): string {
  const h = report.header;
  const e = report.equipment;
  const cost = report.costOfFailure;
  const mh = report.maintenanceHistory;
  const s1 = report.whyWhyAnalysis.stream1 || {};

  const chronoRows = report.chronologyEvents
    .map((ev) => `<tr><td class="ctr">${esc(ev.srNo)}</td><td>${esc(ev.event)}</td><td class="ctr">${esc(ev.date)}</td><td class="ctr">${esc(ev.time)}</td></tr>`)
    .join("");

  const teamRows = report.teamMembers
    .map((t) => `<tr><td class="ctr">${esc(t.no)}</td><td>${esc(t.name)}</td><td>${esc(t.department)}</td><td class="ctr">${esc(t.type)}</td></tr>`)
    .join("");

  const whyRows = WHY_KEYS.map((k, i) => {
    const cur = s1[k];
    if (!cur && i >= 5) return "";
    return `<tr><td class="lbl">Why-${i + 1}</td><td>${esc(cur || "")}</td><td>${esc(s1[WHY_KEYS[i + 1]] || "")}</td></tr>`;
  }).join("");

  const rcRows = (report.rootCauses.length ? report.rootCauses : ["—"])
    .map((rc, i) => `<tr><td class="ctr">${i + 1}</td><td>${esc(rc)}</td></tr>`)
    .join("");

  const fbCells = FB_ORDER.map((k) => {
    const items = fbVal(report.fishboneCategories, k);
    return `<td><div class="fbh">${esc(FB_LABELS[k])}</div>${items.length ? "<ul>" + items.map((c) => `<li>${esc(c)}</li>`).join("") + "</ul>" : '<span class="muted">—</span>'}</td>`;
  }).join("");

  const apRows = report.actionPlan
    .map((a) => `<tr><td class="ctr">${esc(a.srNo)}</td><td>${esc(a.action)}</td><td class="ctr">${esc(a.type)}</td><td>${esc(a.responsible)}</td><td>${esc(a.department)}</td><td class="ctr">${esc(a.target)}</td><td class="ctr">${esc(a.status)}</td></tr>`)
    .join("");

  const act0 = report.immediateActions[0] || { action: "—", who: "—", when: "—" };

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<title>Failure Analysis — ${esc(h.rcaNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; color:#111; background:#fff; margin:0; padding:24px; font-size:12px; }
  h1 { text-align:center; font-size:20px; margin:0 0 16px; }
  table { width:100%; border-collapse:collapse; margin-bottom:14px; table-layout:fixed; }
  td, th { border:1px solid #808080; padding:4px 6px; vertical-align:top; word-wrap:break-word; }
  .band { background:#2E75B6; color:#fff; font-weight:bold; text-align:center; padding:5px; margin:14px 0 0; }
  .band.yellow { background:#FFFF00; color:#000; }
  .lbl { background:#DDEBF7; font-weight:bold; width:230px; }
  .sub { background:#BDD7EE; font-weight:bold; text-align:center; }
  .ctr { text-align:center; }
  .muted { color:#888; }
  .fbh { background:#2E75B6; color:#fff; font-weight:bold; text-align:center; padding:3px; margin:-4px -6px 4px; }
  ul { margin:2px 0; padding-left:16px; } li { margin-bottom:2px; }
  .prob { background:#C00000; color:#fff; font-weight:bold; }
  img.photo { max-width:520px; max-height:300px; border:1px solid #808080; }
  @media print { body { padding:0; } .band { -webkit-print-color-adjust:exact; print-color-adjust:exact; } table,tr,td,th{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<h1>Failure Analysis</h1>

<table>
  <tr><td class="lbl">Z2 Notification Number</td><td>${esc(h.z2NotificationNumber)}</td><td class="lbl">ZR Notification Number</td><td>${esc(h.zrNumber)}</td><td class="lbl">RCA Number</td><td><b>${esc(h.rcaNumber)}</b></td></tr>
  <tr><td class="lbl">Equipment Number</td><td class="ctr"><b>${esc(e.number)}</b></td><td class="lbl">Name of the equipment</td><td>${esc(e.name)}</td><td class="lbl">RCA initiation Date</td><td class="ctr">${esc(h.initiationDate)}</td></tr>
  <tr><td class="lbl">Date &amp; time of Occurance</td><td class="ctr">${esc(e.occurrenceDateTime)}</td><td class="lbl">Total Breakdown Time (Hr)</td><td class="ctr">${esc(report.totalBreakdownTimeHours || "—")}</td><td class="lbl">Plant</td><td class="ctr">${esc(h.plant)}</td></tr>
  <tr><td class="lbl">Date &amp; time of Restoration</td><td class="ctr">${esc(e.restorationDateTime)}</td><td class="lbl">Affecting Production or not</td><td class="ctr">${esc(e.affectsProduction)}</td><td class="lbl">Department / Area</td><td class="ctr">${esc(h.department)} / ${esc(h.section)}</td></tr>
</table>

<table>
  <tr><td class="band" colspan="3" style="width:40%">Clear description of Problem</td><td class="band" colspan="3">Action taken for Restoration: Corrective Action</td></tr>
  <tr><td colspan="3" rowspan="2">${esc(report.problemDescription)}</td><td class="sub">What</td><td class="sub">Who</td><td class="sub">When</td></tr>
  <tr><td>${esc(act0.action)}</td><td>${esc(act0.who)}</td><td class="ctr">${esc(act0.when)}</td></tr>
</table>

<div class="band">Chronology of Key Events</div>
<table><tr><td class="sub" style="width:50px">Sr.No.</td><td class="sub">Events</td><td class="sub" style="width:90px">Date</td><td class="sub" style="width:80px">Time</td></tr>${chronoRows || '<tr><td colspan="4" class="muted ctr">No chronology recorded</td></tr>'}</table>

<table>
  <tr><td class="band" colspan="4">Cost of Failure</td></tr>
  <tr><td class="lbl">Total Breakdown Cost (₹)</td><td>${esc(cost.totalBreakdownCost ?? "—")}</td><td class="lbl">Production Loss (₹ Lakhs)</td><td>${esc(cost.productionLoss)}</td></tr>
  <tr><td class="lbl">Spare Part Cost (₹ Lakhs)</td><td>${esc(cost.sparePartCost)}</td><td class="lbl">Manpower Cost (₹ Lakhs)</td><td>${esc(cost.manpowerCost)}</td></tr>
  <tr><td class="lbl">Service Cost (₹ Lakhs)</td><td colspan="3">${esc(cost.serviceCost)}</td></tr>
</table>

<table>
  <tr><td class="band" colspan="4" style="width:50%">Team members</td><td class="band" colspan="2">Brief Maintenance History</td></tr>
  <tr><td class="sub" style="width:40px">Sr.</td><td class="sub">Name</td><td class="sub">Dept</td><td class="sub">HZL/BP</td><td class="lbl">Covered in PM / CBM</td><td>${esc(mh.coveredInPM || "—")} / ${esc(mh.coveredInCBM || "—")}</td></tr>
  ${teamRows || '<tr><td colspan="4" class="muted ctr">—</td><td class="lbl">PM Date / CBM Date</td><td>'+esc(mh.lastPMDate)+' / '+esc(mh.cbmDate)+'</td></tr>'}
</table>
<table>
  <tr><td class="lbl">PM Date</td><td>${esc(mh.lastPMDate)}</td><td class="lbl">CBM Date</td><td>${esc(mh.cbmDate)}</td></tr>
  <tr><td class="lbl">PM Observation</td><td>${esc(mh.lastPMObservations)}</td><td class="lbl">CBM Status</td><td>${esc(mh.cbmStatus)}</td></tr>
  <tr><td class="lbl">Root Cause identifiable by CBM?</td><td>${esc(mh.rootCauseIdentifiableByCBM)}</td><td class="lbl">FMEA done / in FMEA?</td><td>${esc(report.fmeaExists)} / ${esc(report.currentFailureInFMEA)}</td></tr>
  <tr><td class="lbl">Last Failure Date</td><td>${esc(report.lastFailure.date)}</td><td class="lbl">Last Failure Root Cause</td><td>${esc(report.lastFailure.rootCause)}</td></tr>
</table>

${imageDataUri ? `<div class="band">Breakdown the problem (Observation &amp; Photographs)</div><div style="text-align:center;padding:8px;border:1px solid #808080;border-top:none;"><img class="photo" src="${imageDataUri}"/></div>` : ""}

<div class="band yellow">Pursuit of most important cause — 5-Why Analysis</div>
<table>
  <tr><td class="prob" style="width:120px">Problem</td><td colspan="2"><b>${esc(report.whyWhyAnalysis.problem || report.problemDescription)}</b></td></tr>
  ${whyRows}
</table>

<table><tr><td class="band" colspan="2">Identified Root Cause(s)</td></tr>${rcRows}</table>

<div class="band">Fishbone / 6M Cause Categories</div>
<table><tr>${fbCells}</tr></table>

<div class="band">Root Cause Resolution Actions (CAPA)</div>
<table>
  <tr><td class="sub" style="width:40px">Sr.</td><td class="sub">Action Plan</td><td class="sub" style="width:50px">Type</td><td class="sub">Responsibility</td><td class="sub">Dept</td><td class="sub" style="width:80px">Target</td><td class="sub" style="width:90px">Status</td></tr>
  ${apRows || '<tr><td colspan="7" class="muted ctr">No actions recorded</td></tr>'}
</table>

<table>
  <tr><td class="band" colspan="2">Deployment &amp; Sustainable Measures</td></tr>
  <tr><td class="lbl">Horizontal Deployment</td><td>${esc(report.horizontalDeployment)}</td></tr>
  <tr><td class="lbl">Preventive / Predictive Measures</td><td>${esc(report.preventiveMeasures)}</td></tr>
  <tr><td class="lbl">Sustainable Measures (SOP/SMP)</td><td>${esc(report.sustainableMeasures)}</td></tr>
  <tr><td class="lbl">External Investigation / Testing</td><td>${esc(report.externalInvestigationRequired)} / ${esc(report.externalTestingRequired)}</td></tr>
  <tr><td class="lbl">Changes required in ODC / FMEA</td><td>${esc(report.changesRequiredInODC)} / ${esc(report.changesRequiredInFMEA)}</td></tr>
</table>

<p style="font-size:11px;margin-top:16px;">I hereby declare that the above root cause is best as per my knowledge and all the possible counter measures are being taken to prevent such type of failure.</p>
<table style="margin-top:20px;"><tr>
  <td class="ctr" style="height:50px;vertical-align:bottom;">Signature of RCA Initiator &amp; Date</td>
  <td class="ctr" style="vertical-align:bottom;">Signature of HOD &amp; Date</td>
  <td class="ctr" style="vertical-align:bottom;">Signature of Lead AO &amp; Date</td>
  <td class="ctr" style="vertical-align:bottom;">Signature of Reliability Engineer &amp; Date</td>
</tr></table>
</body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// DOCX — light HZL report (with embedded image)
// ═════════════════════════════════════════════════════════════════════════════

const PCT = WidthType.PERCENTAGE;
const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
};

function tx(text: string, opts: { bold?: boolean; color?: string; size?: number } = {}) {
  return new TextRun({ text: text ?? "", bold: opts.bold, color: opts.color || BLACK, size: opts.size || 18 });
}
function para(text: string, opts: { bold?: boolean; color?: string; size?: number; align?: any } = {}) {
  return new Paragraph({ children: [tx(text, opts)], alignment: opts.align });
}
function cell(text: string, opts: { fill?: string; bold?: boolean; color?: string; width?: number; cols?: number } = {}) {
  return new TableCell({
    children: [para(text, { bold: opts.bold, color: opts.color })],
    shading: opts.fill ? { type: ShadingType.SOLID, color: opts.fill, fill: opts.fill } : undefined,
    width: opts.width ? { size: opts.width, type: PCT } : undefined,
    columnSpan: opts.cols,
    borders: cellBorders,
    margins: { top: 40, bottom: 40, left: 60, right: 60 },
  });
}
function bandRow(text: string, cols: number, fill = BAND, color = WHITE) {
  return new TableRow({
    children: [new TableCell({
      children: [para(text, { bold: true, color })],
      shading: { type: ShadingType.SOLID, color: fill, fill },
      columnSpan: cols,
      borders: cellBorders,
      margins: { top: 50, bottom: 50, left: 60, right: 60 },
    })],
  });
}
function fullTable(rows: TableRow[]) {
  return new Table({ width: { size: 100, type: PCT }, rows });
}

export async function generateRcaDocx(report: RcaReportData, image?: ReportImage): Promise<Buffer> {
  const h = report.header;
  const e = report.equipment;
  const mh = report.maintenanceHistory;
  const s1 = report.whyWhyAnalysis.stream1 || {};
  const act0 = report.immediateActions[0] || { action: "—", who: "—", when: "—" };

  const children: any[] = [
    para("Failure Analysis", { bold: true, size: 36, align: AlignmentType.CENTER }),
    new Paragraph({ text: "", spacing: { after: 120 } }),
  ];

  // Identity table
  children.push(fullTable([
    new TableRow({ children: [cell("Z2 Notification", { fill: LABEL, bold: true }), cell(h.z2NotificationNumber || "—"), cell("ZR Notification", { fill: LABEL, bold: true }), cell(h.zrNumber || "—"), cell("RCA Number", { fill: LABEL, bold: true }), cell(h.rcaNumber, { bold: true })] }),
    new TableRow({ children: [cell("Equipment No.", { fill: LABEL, bold: true }), cell(e.number, { bold: true }), cell("Equipment Name", { fill: LABEL, bold: true }), cell(e.name), cell("Initiation Date", { fill: LABEL, bold: true }), cell(h.initiationDate)] }),
    new TableRow({ children: [cell("Occurrence", { fill: LABEL, bold: true }), cell(e.occurrenceDateTime), cell("Restoration", { fill: LABEL, bold: true }), cell(e.restorationDateTime), cell("Plant", { fill: LABEL, bold: true }), cell(h.plant)] }),
    new TableRow({ children: [cell("Affects Production", { fill: LABEL, bold: true }), cell(e.affectsProduction), cell("Prod. Affected (Hr)", { fill: LABEL, bold: true }), cell(e.productionAffectedHours), cell("Dept / Area", { fill: LABEL, bold: true }), cell(`${h.department} / ${h.section}`)] }),
  ]));

  // Problem + corrective action
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Clear description of Problem", 6),
    new TableRow({ children: [cell(report.problemDescription, { cols: 6 })] }),
    new TableRow({ children: [cell("What", { fill: SUBHEAD, bold: true, cols: 3 }), cell("Who", { fill: SUBHEAD, bold: true, cols: 2 }), cell("When", { fill: SUBHEAD, bold: true })] }),
    new TableRow({ children: [cell(act0.action, { cols: 3 }), cell(act0.who, { cols: 2 }), cell(act0.when)] }),
  ]));

  // Chronology
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Chronology of Key Events", 4),
    new TableRow({ children: [cell("Sr.", { fill: SUBHEAD, bold: true, width: 8 }), cell("Event", { fill: SUBHEAD, bold: true, width: 64 }), cell("Date", { fill: SUBHEAD, bold: true, width: 16 }), cell("Time", { fill: SUBHEAD, bold: true, width: 12 })] }),
    ...(report.chronologyEvents.length ? report.chronologyEvents : [{ srNo: "—", event: "No chronology recorded", date: "", time: "" } as any]).map((ev) =>
      new TableRow({ children: [cell(String(ev.srNo)), cell(ev.event), cell(ev.date), cell(ev.time)] })),
  ]));

  // Cost
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Cost of Failure", 4),
    new TableRow({ children: [cell("Spare Part (₹L)", { fill: LABEL, bold: true }), cell(String(report.costOfFailure.sparePartCost)), cell("Service (₹L)", { fill: LABEL, bold: true }), cell(String(report.costOfFailure.serviceCost))] }),
    new TableRow({ children: [cell("Manpower (₹L)", { fill: LABEL, bold: true }), cell(String(report.costOfFailure.manpowerCost)), cell("Production Loss (₹L)", { fill: LABEL, bold: true }), cell(String(report.costOfFailure.productionLoss))] }),
  ]));

  // Team
  if (report.teamMembers.length) {
    children.push(para("", { size: 8 }));
    children.push(fullTable([
      bandRow("Team Members", 4),
      new TableRow({ children: [cell("Sr.", { fill: SUBHEAD, bold: true }), cell("Name", { fill: SUBHEAD, bold: true }), cell("Department", { fill: SUBHEAD, bold: true }), cell("HZL/BP", { fill: SUBHEAD, bold: true })] }),
      ...report.teamMembers.map((t) => new TableRow({ children: [cell(String(t.no)), cell(t.name), cell(t.department), cell(t.type)] })),
    ]));
  }

  // Maintenance history
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Brief Maintenance History", 4),
    new TableRow({ children: [cell("Covered in PM", { fill: LABEL, bold: true }), cell(mh.coveredInPM || "—"), cell("Covered in CBM", { fill: LABEL, bold: true }), cell(mh.coveredInCBM || "—")] }),
    new TableRow({ children: [cell("PM Date", { fill: LABEL, bold: true }), cell(mh.lastPMDate), cell("CBM Date", { fill: LABEL, bold: true }), cell(mh.cbmDate)] }),
    new TableRow({ children: [cell("PM Observation", { fill: LABEL, bold: true }), cell(mh.lastPMObservations), cell("CBM Status", { fill: LABEL, bold: true }), cell(mh.cbmStatus)] }),
    new TableRow({ children: [cell("Last Failure Date", { fill: LABEL, bold: true }), cell(report.lastFailure.date), cell("Last Failure Root Cause", { fill: LABEL, bold: true }), cell(report.lastFailure.rootCause)] }),
    new TableRow({ children: [cell("FMEA done?", { fill: LABEL, bold: true }), cell(report.fmeaExists), cell("Current failure in FMEA?", { fill: LABEL, bold: true }), cell(report.currentFailureInFMEA)] }),
  ]));

  // Image
  if (image) {
    children.push(para("", { size: 8 }));
    children.push(fullTable([bandRow("Breakdown the problem (Observation & Photographs)", 1)]));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 80 },
      children: [new ImageRun({ data: image.buffer as any, transformation: { width: 480, height: 270 }, type: image.extension === "jpeg" ? "jpg" : (image.extension as any) })],
    }));
  }

  // 5-Why
  children.push(para("", { size: 8 }));
  const whyRows: TableRow[] = [
    bandRow("Pursuit of Most Important Cause — 5-Why Analysis", 3, YELLOW, BLACK),
    new TableRow({ children: [cell("Problem", { fill: RED, color: WHITE, bold: true }), cell(report.whyWhyAnalysis.problem || report.problemDescription, { bold: true, cols: 2 })] }),
  ];
  WHY_KEYS.forEach((k, i) => {
    const cur = s1[k];
    if (!cur && i >= 5) return;
    whyRows.push(new TableRow({ children: [cell(`Why-${i + 1}`, { fill: LABEL, bold: true }), cell(cur || ""), cell(s1[WHY_KEYS[i + 1]] || "")] }));
  });
  children.push(fullTable(whyRows));

  // Root causes
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Identified Root Cause(s)", 2),
    ...(report.rootCauses.length ? report.rootCauses : ["—"]).map((rc, i) =>
      new TableRow({ children: [cell(String(i + 1), { width: 8 }), cell(rc, { width: 92 })] })),
  ]));

  // Fishbone
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Fishbone / 6M Cause Categories", 6),
    new TableRow({ children: FB_ORDER.map((k) => cell(FB_LABELS[k], { fill: BAND, color: WHITE, bold: true })) }),
    new TableRow({ children: FB_ORDER.map((k) => {
      const items = fbVal(report.fishboneCategories, k);
      return new TableCell({ children: items.length ? items.map((c) => para("• " + c)) : [para("—", { color: "888888" })], borders: cellBorders, margins: { top: 40, bottom: 40, left: 50, right: 50 } });
    }) }),
  ]));

  // CAPA
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Root Cause Resolution Actions (CAPA)", 7),
    new TableRow({ children: ["Sr.", "Action Plan", "Type", "Responsibility", "Dept", "Target", "Status"].map((c) => cell(c, { fill: SUBHEAD, bold: true })) }),
    ...(report.actionPlan.length ? report.actionPlan : [{ srNo: "—", action: "No actions recorded", type: "", responsible: "", department: "", target: "", status: "" } as any]).map((a) =>
      new TableRow({ children: [cell(String(a.srNo)), cell(a.action), cell(a.type), cell(a.responsible), cell(a.department), cell(a.target), cell(a.status)] })),
  ]));

  // Deployment
  children.push(para("", { size: 8 }));
  children.push(fullTable([
    bandRow("Deployment & Sustainable Measures", 2),
    new TableRow({ children: [cell("Horizontal Deployment", { fill: LABEL, bold: true, width: 35 }), cell(report.horizontalDeployment, { width: 65 })] }),
    new TableRow({ children: [cell("Preventive / Predictive Measures", { fill: LABEL, bold: true }), cell(report.preventiveMeasures)] }),
    new TableRow({ children: [cell("Sustainable Measures (SOP/SMP)", { fill: LABEL, bold: true }), cell(report.sustainableMeasures)] }),
    new TableRow({ children: [cell("External Investigation / Testing", { fill: LABEL, bold: true }), cell(`${report.externalInvestigationRequired} / ${report.externalTestingRequired}`)] }),
    new TableRow({ children: [cell("Changes required in ODC / FMEA", { fill: LABEL, bold: true }), cell(`${report.changesRequiredInODC} / ${report.changesRequiredInFMEA}`)] }),
  ]));

  children.push(new Paragraph({ text: "", spacing: { before: 300 } }));
  children.push(para("I hereby declare that the above root cause is best as per my knowledge and all the possible counter measures are being taken to prevent such type of failure.", { size: 16 }));

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", color: BLACK, size: 20 } } } },
    sections: [{ properties: {}, children }],
  });
  return await Packer.toBuffer(doc);
}
