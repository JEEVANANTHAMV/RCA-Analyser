/**
 * RCA Report generation utilities.
 * Produces styled .xlsx and .docx files from the AI-generated rcaReport JSON.
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
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  ShadingType,
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
    sparePartCost: number;
    serviceCost: number;
    manpowerCost: number;
    productionLoss: number;
  };
  chronologyEvents: Array<{ srNo: number; event: string; date: string; time: string }>;
  teamMembers: Array<{ no: number; name: string; department: string; type: string }>;
  maintenanceHistory: {
    lastPMDate: string;
    lastPMObservations: string;
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
  // Pass-through fields merged from other agents
  rootCause?: string;
  correctiveActionsList?: any[];
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX Generator
// ─────────────────────────────────────────────────────────────────────────────

const DARK_BG = "1A1A2E";
const ACCENT = "3B82F6";
const HEADER_FILL = "1E293B";
const ROW_ODD = "0F172A";
const ROW_EVEN = "1E293B";
const TEXT_WHITE = "FFFFFF";
const TEXT_LIGHT = "94A3B8";
const TEXT_ACCENT = "60A5FA";

function styleHeader(cell: ExcelJS.Cell, text: string) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: `FF${TEXT_WHITE}` }, size: 11, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_FILL}` } };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: `FF${ACCENT}` } },
    bottom: { style: "thin", color: { argb: `FF${ACCENT}` } },
    left: { style: "thin", color: { argb: `FF${ACCENT}` } },
    right: { style: "thin", color: { argb: `FF${ACCENT}` } },
  };
}

function styleLabel(cell: ExcelJS.Cell, text: string) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: `FF${TEXT_LIGHT}` }, size: 9, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ROW_EVEN}` } };
  cell.alignment = { vertical: "middle", wrapText: true };
}

function styleValue(cell: ExcelJS.Cell, text: string | number) {
  cell.value = text;
  cell.font = { color: { argb: `FF${TEXT_WHITE}` }, size: 10, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ROW_ODD}` } };
  cell.alignment = { vertical: "middle", wrapText: true };
  cell.border = {
    bottom: { style: "hair", color: { argb: `FF334155` } },
  };
}

function styleSectionTitle(cell: ExcelJS.Cell, text: string) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: `FF${TEXT_ACCENT}` }, size: 12, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${DARK_BG}` } };
  cell.border = {
    bottom: { style: "medium", color: { argb: `FF${ACCENT}` } },
  };
}

export async function generateRcaXlsx(report: RcaReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "RCA.OPS Platform";
  wb.created = new Date();

  const ws = wb.addWorksheet("RCA FORMAT", {
    properties: { tabColor: { argb: `FF${ACCENT}` } },
    views: [{ state: "frozen", ySplit: 3 }],
  });

  ws.properties.defaultRowHeight = 18;

  // Column widths matching template proportions
  ws.columns = [
    { key: "A", width: 6 },
    { key: "B", width: 28 },
    { key: "C", width: 18 },
    { key: "D", width: 18 },
    { key: "E", width: 10 },
    { key: "F", width: 18 },
    { key: "G", width: 18 },
    { key: "H", width: 18 },
    { key: "I", width: 14 },
    { key: "J", width: 20 },
    { key: "K", width: 20 },
    { key: "L", width: 16 },
  ];

  // ─── Row 1: Title Banner ───────────────────────────────────────────────────
  ws.mergeCells("A1:L1");
  const titleCell = ws.getCell("A1");
  titleCell.value = "FAILURE ANALYSIS — ROOT CAUSE ANALYSIS REPORT";
  titleCell.font = { bold: true, size: 14, color: { argb: `FF${TEXT_WHITE}` }, name: "Calibri" };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ACCENT}` } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 28;

  // ─── Row 2: RCA No / Plant ─────────────────────────────────────────────────
  ws.getRow(2).height = 20;
  styleLabel(ws.getCell("A2"), "RCA No.");
  ws.mergeCells("B2:D2");
  styleValue(ws.getCell("B2"), report.header.rcaNumber);
  styleLabel(ws.getCell("E2"), "Plant");
  ws.mergeCells("F2:H2");
  styleValue(ws.getCell("F2"), report.header.plant);
  styleLabel(ws.getCell("I2"), "Department");
  ws.mergeCells("J2:L2");
  styleValue(ws.getCell("J2"), report.header.department);

  // ─── Row 3: Dates ──────────────────────────────────────────────────────────
  ws.getRow(3).height = 20;
  styleLabel(ws.getCell("A3"), "Initiation Date");
  ws.mergeCells("B3:D3");
  styleValue(ws.getCell("B3"), report.header.initiationDate);
  styleLabel(ws.getCell("E3"), "Submission Date");
  ws.mergeCells("F3:H3");
  styleValue(ws.getCell("F3"), report.header.submissionDate);
  styleLabel(ws.getCell("I3"), "Section / Area");
  ws.mergeCells("J3:L3");
  styleValue(ws.getCell("J3"), report.header.section);

  // ─── Row 4: Equipment ─────────────────────────────────────────────────────
  ws.getRow(4).height = 20;
  styleLabel(ws.getCell("A4"), "Equipment No.");
  ws.mergeCells("B4:D4");
  styleValue(ws.getCell("B4"), report.equipment.number);
  styleLabel(ws.getCell("E4"), "Equipment Name");
  ws.mergeCells("F4:H4");
  styleValue(ws.getCell("F4"), report.equipment.name);
  styleLabel(ws.getCell("I4"), "Z2 Notification");
  ws.mergeCells("J4:L4");
  styleValue(ws.getCell("J4"), report.header.z2NotificationNumber || "—");

  // ─── Row 5: Occurrence ────────────────────────────────────────────────────
  ws.getRow(5).height = 20;
  styleLabel(ws.getCell("A5"), "Occurrence Date/Time");
  ws.mergeCells("B5:D5");
  styleValue(ws.getCell("B5"), report.equipment.occurrenceDateTime);
  styleLabel(ws.getCell("E5"), "Restoration Date/Time");
  ws.mergeCells("F5:H5");
  styleValue(ws.getCell("F5"), report.equipment.restorationDateTime);
  styleLabel(ws.getCell("I5"), "Prod. Affected (Hr)");
  ws.mergeCells("J5:K5");
  styleValue(ws.getCell("J5"), report.equipment.productionAffectedHours);
  styleLabel(ws.getCell("L5"), "Affects Prod?");
  styleValue(ws.getCell("L5"), report.equipment.affectsProduction);

  // ─── Row 6: Problem Description ───────────────────────────────────────────
  ws.getRow(6).height = 20;
  styleLabel(ws.getCell("A6"), "Problem Description");
  ws.mergeCells("B6:L6");
  const probCell = ws.getCell("B6");
  probCell.value = report.problemDescription;
  probCell.font = { color: { argb: `FF${TEXT_WHITE}` }, size: 10 };
  probCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ROW_ODD}` } };
  probCell.alignment = { wrapText: true, vertical: "middle" };

  // ─── Row 7: Gap row ───────────────────────────────────────────────────────
  ws.getRow(7).height = 8;

  // ─── Cost of Failure ──────────────────────────────────────────────────────
  let r = 8;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// COST OF FAILURE");
  ws.getRow(r).height = 22;
  r++;

  styleHeader(ws.getCell(`A${r}`), "Spare Part Cost (Lacs)");
  ws.mergeCells(`A${r}:C${r}`);
  styleHeader(ws.getCell(`D${r}`), "Service Cost (Lacs)");
  ws.mergeCells(`D${r}:F${r}`);
  styleHeader(ws.getCell(`G${r}`), "Manpower Cost (Lacs)");
  ws.mergeCells(`G${r}:I${r}`);
  styleHeader(ws.getCell(`J${r}`), "Production Loss (Lacs)");
  ws.mergeCells(`J${r}:L${r}`);
  r++;

  styleValue(ws.getCell(`A${r}`), report.costOfFailure.sparePartCost);
  ws.mergeCells(`A${r}:C${r}`);
  styleValue(ws.getCell(`D${r}`), report.costOfFailure.serviceCost);
  ws.mergeCells(`D${r}:F${r}`);
  styleValue(ws.getCell(`G${r}`), report.costOfFailure.manpowerCost);
  ws.mergeCells(`G${r}:I${r}`);
  styleValue(ws.getCell(`J${r}`), report.costOfFailure.productionLoss);
  ws.mergeCells(`J${r}:L${r}`);
  r++;

  // ─── Chronology of Events ─────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// CHRONOLOGY OF KEY EVENTS");
  ws.getRow(r).height = 22;
  r++;

  // Header
  styleHeader(ws.getCell(`A${r}`), "Sr No");
  styleHeader(ws.getCell(`B${r}`), "Event Description");
  ws.mergeCells(`B${r}:H${r}`);
  styleHeader(ws.getCell(`I${r}`), "Date");
  ws.mergeCells(`I${r}:J${r}`);
  styleHeader(ws.getCell(`K${r}`), "Time");
  ws.mergeCells(`K${r}:L${r}`);
  r++;

  for (const ev of report.chronologyEvents) {
    styleValue(ws.getCell(`A${r}`), ev.srNo);
    styleValue(ws.getCell(`B${r}`), ev.event);
    ws.mergeCells(`B${r}:H${r}`);
    styleValue(ws.getCell(`I${r}`), ev.date);
    ws.mergeCells(`I${r}:J${r}`);
    styleValue(ws.getCell(`K${r}`), ev.time);
    ws.mergeCells(`K${r}:L${r}`);
    ws.getRow(r).height = 30;
    r++;
  }

  // ─── Team Members ─────────────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// TEAM MEMBERS");
  ws.getRow(r).height = 22;
  r++;

  styleHeader(ws.getCell(`A${r}`), "#");
  styleHeader(ws.getCell(`B${r}`), "Name");
  ws.mergeCells(`B${r}:E${r}`);
  styleHeader(ws.getCell(`F${r}`), "Department");
  ws.mergeCells(`F${r}:I${r}`);
  styleHeader(ws.getCell(`J${r}`), "HZL / BP");
  ws.mergeCells(`J${r}:L${r}`);
  r++;

  for (const tm of report.teamMembers) {
    styleValue(ws.getCell(`A${r}`), tm.no);
    styleValue(ws.getCell(`B${r}`), tm.name);
    ws.mergeCells(`B${r}:E${r}`);
    styleValue(ws.getCell(`F${r}`), tm.department);
    ws.mergeCells(`F${r}:I${r}`);
    styleValue(ws.getCell(`J${r}`), tm.type);
    ws.mergeCells(`J${r}:L${r}`);
    r++;
  }

  // ─── Maintenance History ──────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// BRIEF MAINTENANCE HISTORY");
  ws.getRow(r).height = 22;
  r++;

  const mh = report.maintenanceHistory;
  const mhRows = [
    ["Last PM Date", mh.lastPMDate, "Last PM Observations", mh.lastPMObservations],
    ["CBM Date", mh.cbmDate, "CBM Status/Result", mh.cbmStatus],
    ["Root Cause by CBM?", mh.rootCauseIdentifiableByCBM, "Last Failure Date", report.lastFailure.date],
    ["Last Failure Detail", report.lastFailure.detail, "Root Cause of Last Failure", report.lastFailure.rootCause],
  ];
  for (const [l1, v1, l2, v2] of mhRows) {
    styleLabel(ws.getCell(`A${r}`), l1 as string);
    ws.mergeCells(`A${r}:B${r}`);
    styleValue(ws.getCell(`C${r}`), v1 as string);
    ws.mergeCells(`C${r}:F${r}`);
    styleLabel(ws.getCell(`G${r}`), l2 as string);
    ws.mergeCells(`G${r}:H${r}`);
    styleValue(ws.getCell(`I${r}`), v2 as string);
    ws.mergeCells(`I${r}:L${r}`);
    ws.getRow(r).height = 22;
    r++;
  }

  // FMEA row
  styleLabel(ws.getCell(`A${r}`), "FMEA Analysis Done?");
  ws.mergeCells(`A${r}:B${r}`);
  styleValue(ws.getCell(`C${r}`), report.fmeaExists);
  ws.mergeCells(`C${r}:F${r}`);
  styleLabel(ws.getCell(`G${r}`), "Current Failure in FMEA?");
  ws.mergeCells(`G${r}:H${r}`);
  styleValue(ws.getCell(`I${r}`), report.currentFailureInFMEA);
  ws.mergeCells(`I${r}:L${r}`);
  r++;

  // ─── Why-Why Analysis ─────────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// WHY-WHY ANALYSIS (5-WHY METHOD)");
  ws.getRow(r).height = 22;
  r++;

  // Problem row
  styleLabel(ws.getCell(`A${r}`), "Problem");
  ws.mergeCells(`A${r}:B${r}`);
  styleValue(ws.getCell(`C${r}`), report.whyWhyAnalysis.problem);
  ws.mergeCells(`C${r}:L${r}`);
  r++;

  // Stream headers
  styleHeader(ws.getCell(`A${r}`), "Why Level");
  ws.mergeCells(`A${r}:B${r}`);
  styleHeader(ws.getCell(`C${r}`), "Stream 1");
  ws.mergeCells(`C${r}:F${r}`);
  styleHeader(ws.getCell(`G${r}`), "Stream 2");
  ws.mergeCells(`G${r}:L${r}`);
  r++;

  const whyKeys = ["why1", "why2", "why3", "why4", "why5", "why6"];
  for (const key of whyKeys) {
    const s1 = report.whyWhyAnalysis.stream1[key];
    const s2 = report.whyWhyAnalysis.stream2[key];
    if (!s1 && !s2) continue;
    styleLabel(ws.getCell(`A${r}`), key.replace("why", "Why-").toUpperCase());
    ws.mergeCells(`A${r}:B${r}`);
    styleValue(ws.getCell(`C${r}`), s1 || "—");
    ws.mergeCells(`C${r}:F${r}`);
    styleValue(ws.getCell(`G${r}`), s2 || "—");
    ws.mergeCells(`G${r}:L${r}`);
    ws.getRow(r).height = 28;
    r++;
  }

  // ─── Root Causes ──────────────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// IDENTIFIED ROOT CAUSES");
  ws.getRow(r).height = 22;
  r++;

  report.rootCauses.filter(Boolean).forEach((rc, idx) => {
    styleValue(ws.getCell(`A${r}`), idx + 1);
    styleValue(ws.getCell(`B${r}`), rc);
    ws.mergeCells(`B${r}:L${r}`);
    ws.getRow(r).height = 30;
    r++;
  });

  // ─── Fishbone Categories ──────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// FISHBONE / ISHIKAWA CAUSE CATEGORIES");
  ws.getRow(r).height = 22;
  r++;

  const fbCols: Array<[string, string]> = [
    ["Skill / Man", "manpower"],
    ["Design / Machine", "machine"],
    ["Method", "method"],
    ["Material", "material"],
    ["Measurement", "measurement"],
    ["Environment", "environment"],
  ];

  const colLetterPairs: Array<[string, string]> = [
    ["A", "B"], ["C", "D"], ["E", "F"], ["G", "H"], ["I", "J"], ["K", "L"],
  ];

  // Category headers row
  fbCols.forEach(([label], i) => {
    const [s, e] = colLetterPairs[i];
    styleHeader(ws.getCell(`${s}${r}`), label);
    ws.mergeCells(`${s}${r}:${e}${r}`);
  });
  r++;

  // Find max length
  const maxCauses = Math.max(
    ...fbCols.map(([, key]) => (report.fishboneCategories[key] || []).length),
    1
  );

  for (let ci = 0; ci < maxCauses; ci++) {
    fbCols.forEach(([, key], i) => {
      const cause = (report.fishboneCategories[key] || [])[ci] || "";
      const [s, e] = colLetterPairs[i];
      styleValue(ws.getCell(`${s}${r}`), cause);
      ws.mergeCells(`${s}${r}:${e}${r}`);
    });
    ws.getRow(r).height = 24;
    r++;
  }

  // ─── Action Plan (CAPA) ───────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// ACTION PLAN FOR RCA (CAPA)");
  ws.getRow(r).height = 22;
  r++;

  const capaHeaders = ["Sr", "Action", "Type", "Classification", "Responsible", "Dept", "Target Date", "Status"];
  const capaCols = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const capaMerge: Array<[string, string] | null> = [null, ["B", "C"], null, null, null, null, null, ["H", "L"]];

  capaHeaders.forEach((h, i) => {
    const col = capaCols[i];
    const merge = capaMerge[i];
    if (merge) {
      styleHeader(ws.getCell(`${merge[0]}${r}`), h);
      ws.mergeCells(`${merge[0]}${r}:${merge[1]}${r}`);
    } else {
      styleHeader(ws.getCell(`${col}${r}`), h);
    }
  });
  r++;

  const capaList = report.actionPlan?.length ? report.actionPlan : (report.correctiveActionsList || []).map((a: any, idx: number) => ({
    srNo: idx + 1,
    action: typeof a === "string" ? a : a.desc || a.description || "",
    type: a.type || "CA",
    classification: a.classification || "—",
    responsible: a.owner || a.responsible || "—",
    department: a.dept || a.department || "—",
    target: a.date || a.target || "—",
    status: a.status || "Pending",
  }));

  for (const act of capaList) {
    styleValue(ws.getCell(`A${r}`), act.srNo);
    styleValue(ws.getCell(`B${r}`), act.action);
    ws.mergeCells(`B${r}:C${r}`);
    styleValue(ws.getCell(`D${r}`), act.type);
    styleValue(ws.getCell(`E${r}`), act.classification);
    styleValue(ws.getCell(`F${r}`), act.responsible);
    styleValue(ws.getCell(`G${r}`), act.department);
    styleValue(ws.getCell(`H${r}`), act.target);
    styleValue(ws.getCell(`I${r}`), act.status);
    ws.mergeCells(`I${r}:L${r}`);
    ws.getRow(r).height = 32;
    r++;
  }

  // ─── Deployment / Measures ────────────────────────────────────────────────
  r++;
  ws.mergeCells(`A${r}:L${r}`);
  styleSectionTitle(ws.getCell(`A${r}`), "// DEPLOYMENT & SUSTAINABLE MEASURES");
  ws.getRow(r).height = 22;
  r++;

  const deployRows = [
    ["Horizontal Deployment", report.horizontalDeployment],
    ["Preventive / Predictive Measures", report.preventiveMeasures],
    ["Sustainable Measures (SOP/SMP)", report.sustainableMeasures],
    ["External Investigation Required?", report.externalInvestigationRequired],
    ["External Testing Required?", report.externalTestingRequired],
    ["Changes Required in ODC?", report.changesRequiredInODC],
    ["Changes Required in FMEA?", report.changesRequiredInFMEA],
  ];

  for (const [label, value] of deployRows) {
    styleLabel(ws.getCell(`A${r}`), label as string);
    ws.mergeCells(`A${r}:C${r}`);
    styleValue(ws.getCell(`D${r}`), value as string);
    ws.mergeCells(`D${r}:L${r}`);
    ws.getRow(r).height = 26;
    r++;
  }

  // ─── Signature Block ─────────────────────────────────────────────────────
  r += 2;
  const sigHeaders = ["OEM Incharge", "HOD Signature", "Lead AO Signature", "Reliability Group Rep."];
  sigHeaders.forEach((h, i) => {
    const col = String.fromCharCode(65 + i * 3); // A, D, G, J
    ws.mergeCells(`${col}${r}:${String.fromCharCode(65 + i * 3 + 2)}${r}`);
    const c = ws.getCell(`${col}${r}`);
    c.value = h;
    c.font = { bold: true, color: { argb: `FF${TEXT_LIGHT}` }, size: 9 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_FILL}` } };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = { bottom: { style: "medium", color: { argb: `FF${ACCENT}` } } };
  });
  ws.getRow(r).height = 40;

  // Set worksheet background
  ws.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (!cell.fill || (cell.fill as ExcelJS.FillPattern).fgColor?.argb === undefined) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${DARK_BG}` } };
      }
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX Generator
// ─────────────────────────────────────────────────────────────────────────────

function docxHeading(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 100 },
    shading: { type: ShadingType.SOLID, color: "1E293B", fill: "1E293B" },
  });
}

function docxRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, color: "94A3B8", size: 18 })] })],
        shading: { type: ShadingType.SOLID, color: "1E293B", fill: "1E293B" },
        width: { size: 30, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
          left: { style: BorderStyle.NONE },
          right: { style: BorderStyle.SINGLE, size: 1, color: "3B82F6" },
        },
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: value || "—", color: "FFFFFF", size: 18 })] })],
        shading: { type: ShadingType.SOLID, color: "0F172A", fill: "0F172A" },
        width: { size: 70, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
          left: { style: BorderStyle.NONE },
          right: { style: BorderStyle.NONE },
        },
      }),
    ],
  });
}

function headerRow(cols: string[]): TableRow {
  return new TableRow({
    children: cols.map(
      (c) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, color: "FFFFFF", size: 18 })] })],
          shading: { type: ShadingType.SOLID, color: "1E3A5F", fill: "1E3A5F" },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 2, color: "3B82F6" },
            bottom: { style: BorderStyle.SINGLE, size: 2, color: "3B82F6" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "3B82F6" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "3B82F6" },
          },
        })
    ),
    tableHeader: true,
  });
}

function dataRow(cols: string[]): TableRow {
  return new TableRow({
    children: cols.map(
      (c) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: c || "—", color: "FFFFFF", size: 18 })] })],
          shading: { type: ShadingType.SOLID, color: "0F172A", fill: "0F172A" },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "334155" },
          },
        })
    ),
  });
}

export async function generateRcaDocx(report: RcaReportData): Promise<Buffer> {
  const { header, equipment, costOfFailure: cost, maintenanceHistory: mh } = report;

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", color: "FFFFFF", size: 20 },
        },
      },
    },
    background: { color: "0F172A" },
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            children: [new TextRun({ text: "FAILURE ANALYSIS — RCA REPORT", bold: true, size: 36, color: "60A5FA" })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          }),

          docxHeading("1. REPORT HEADER"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              docxRow("RCA Number", header.rcaNumber),
              docxRow("Plant", header.plant),
              docxRow("Department", header.department),
              docxRow("Section / Area", header.section),
              docxRow("Initiation Date", header.initiationDate),
              docxRow("Submission Date", header.submissionDate),
            ],
          }),

          docxHeading("2. EQUIPMENT & INCIDENT DETAILS"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              docxRow("Equipment Number", equipment.number),
              docxRow("Equipment Name", equipment.name),
              docxRow("Occurrence Date/Time", equipment.occurrenceDateTime),
              docxRow("Restoration Date/Time", equipment.restorationDateTime),
              docxRow("Production Affected (Hrs)", equipment.productionAffectedHours),
              docxRow("Affects Production?", equipment.affectsProduction),
            ],
          }),

          docxHeading("3. PROBLEM DESCRIPTION"),
          new Paragraph({
            children: [new TextRun({ text: report.problemDescription, color: "FFFFFF", size: 20 })],
            spacing: { after: 200 },
          }),

          docxHeading("4. COST OF FAILURE"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(["Spare Part Cost (Lacs)", "Service Cost (Lacs)", "Manpower Cost (Lacs)", "Production Loss (Lacs)"]),
              dataRow([
                String(cost.sparePartCost),
                String(cost.serviceCost),
                String(cost.manpowerCost),
                String(cost.productionLoss),
              ]),
            ],
          }),

          docxHeading("5. CHRONOLOGY OF EVENTS"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(["Sr No", "Event", "Date", "Time"]),
              ...report.chronologyEvents.map((ev) => dataRow([String(ev.srNo), ev.event, ev.date, ev.time])),
            ],
          }),

          docxHeading("6. TEAM MEMBERS"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(["#", "Name", "Department", "Type"]),
              ...report.teamMembers.map((tm) => dataRow([String(tm.no), tm.name, tm.department, tm.type])),
            ],
          }),

          docxHeading("7. MAINTENANCE HISTORY"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              docxRow("Last PM Date", mh.lastPMDate),
              docxRow("Last PM Observations", mh.lastPMObservations),
              docxRow("CBM Date", mh.cbmDate),
              docxRow("CBM Status/Result", mh.cbmStatus),
              docxRow("Root Cause Identifiable by CBM?", mh.rootCauseIdentifiableByCBM),
              docxRow("Last Failure Date", report.lastFailure.date),
              docxRow("Last Failure Detail", report.lastFailure.detail),
              docxRow("Root Cause of Last Failure", report.lastFailure.rootCause),
              docxRow("FMEA Done?", report.fmeaExists),
              docxRow("Current Failure in FMEA?", report.currentFailureInFMEA),
            ],
          }),

          docxHeading("8. WHY-WHY ANALYSIS"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(["Why Level", "Stream 1", "Stream 2"]),
              ...["why1", "why2", "why3", "why4", "why5", "why6"]
                .filter((k) => report.whyWhyAnalysis.stream1[k] || report.whyWhyAnalysis.stream2[k])
                .map((k) =>
                  dataRow([
                    k.replace("why", "Why-"),
                    report.whyWhyAnalysis.stream1[k] || "—",
                    report.whyWhyAnalysis.stream2[k] || "—",
                  ])
                ),
            ],
          }),

          docxHeading("9. IDENTIFIED ROOT CAUSES"),
          ...report.rootCauses.filter(Boolean).map(
            (rc, i) =>
              new Paragraph({
                children: [new TextRun({ text: `${i + 1}. ${rc}`, color: "FFFFFF", size: 20 })],
                spacing: { after: 100 },
              })
          ),

          docxHeading("10. FISHBONE CATEGORIES"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(["Category", "Identified Causes"]),
              ...(["manpower", "machine", "method", "material", "measurement", "environment"] as const).map((cat) => {
                const label = { manpower: "Skill / Man", machine: "Design / Machine", method: "Method", material: "Material", measurement: "Measurement", environment: "Environment" }[cat];
                const causes = (report.fishboneCategories[cat] || []).join("; ") || "—";
                return dataRow([label, causes]);
              }),
            ],
          }),

          docxHeading("11. ACTION PLAN (CAPA)"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow(["Sr", "Action", "Type", "Responsible", "Department", "Target", "Status"]),
              ...report.actionPlan.map((act) =>
                dataRow([String(act.srNo), act.action, act.type, act.responsible, act.department, act.target, act.status])
              ),
            ],
          }),

          docxHeading("12. DEPLOYMENT & MEASURES"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              docxRow("Horizontal Deployment", report.horizontalDeployment),
              docxRow("Preventive / Predictive Measures", report.preventiveMeasures),
              docxRow("Sustainable Measures (SOP/SMP)", report.sustainableMeasures),
              docxRow("External Investigation Required?", report.externalInvestigationRequired),
              docxRow("Changes Required in FMEA?", report.changesRequiredInFMEA),
            ],
          }),

          new Paragraph({ text: "", spacing: { before: 600 } }),
          new Paragraph({
            children: [new TextRun({ text: "Generated by RCA.OPS Platform", color: "64748B", size: 16, italics: true })],
            alignment: AlignmentType.CENTER,
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer;
}
