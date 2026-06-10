import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getPublicCase, downloadPublicReport } from "@/lib/rca.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Download, Loader2, Globe, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/p/$slug")({
  component: PublicCasePage,
});

function PublicCasePage() {
  const { slug } = Route.useParams();
  const getCaseFn = useServerFn(getPublicCase);
  const caseQ = useQuery({
    queryKey: ["public-case", slug],
    queryFn: () => getCaseFn({ data: { slug } }),
    retry: false,
  });

  const downloadFn = useServerFn(downloadPublicReport);
  const [downloading, setDownloading] = useState<string | null>(null);

  async function handleDownload(format: "xlsx" | "docx" | "pdf" | "html") {
    setDownloading(format);
    try {
      const r = await downloadFn({ data: { slug, format } });
      if (!r?.base64) throw new Error("No data returned");
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: r.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${r.filename}`);
    } catch (e: any) {
      toast.error(e.message || "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  if (caseQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground font-mono">Loading public RCA report…</p>
        </div>
      </div>
    );
  }

  if (!caseQ.data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center px-4">
          <AlertTriangle className="w-12 h-12 text-amber-500" />
          <h1 className="text-xl font-bold">Report Not Found</h1>
          <p className="text-sm text-muted-foreground max-w-sm">
            This RCA report is not publicly available, or the link may have expired.
          </p>
        </div>
      </div>
    );
  }

  const rcaData = caseQ.data;
  let incidentData: any = {};
  let finalReport: any = null;
  try { incidentData = rcaData.incident_data ? JSON.parse(rcaData.incident_data) : {}; } catch {}
  try { finalReport = rcaData.final_report ? JSON.parse(rcaData.final_report) : null; } catch {}

  const reportPayload = finalReport?.rcaReport ?? finalReport;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border/60 bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Globe className="w-5 h-5 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-sm font-bold truncate">{rcaData.title}</h1>
              <p className="text-[10px] text-muted-foreground font-mono">Public RCA Report</p>
            </div>
          </div>
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40 flex-shrink-0">
            Completed
          </Badge>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Download Panel */}
        <div className="rounded-xl border border-blue-500/25 bg-gradient-to-r from-blue-950/40 to-indigo-950/40 p-5">
          <p className="text-xs font-bold font-mono text-blue-300 mb-3">DOWNLOAD REPORT</p>
          <div className="flex flex-wrap gap-2">
            {(["xlsx", "docx", "pdf", "html"] as const).map((fmt) => (
              <Button
                key={fmt}
                size="sm"
                variant="outline"
                className="gap-1.5 h-8"
                disabled={!!downloading}
                onClick={() => handleDownload(fmt)}
              >
                {downloading === fmt ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Download className="w-3 h-3" />
                )}
                {fmt.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>

        {/* Incident Summary */}
        <div className="rounded-xl border border-border/60 p-5 space-y-4">
          <h2 className="text-sm font-bold font-mono uppercase tracking-wide border-b border-border/40 pb-2">
            Incident Summary
          </h2>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            {incidentData.problemStatement && (
              <div className="sm:col-span-2">
                <p className="text-[10px] text-muted-foreground font-mono mb-1">PROBLEM STATEMENT</p>
                <p className="text-sm">{incidentData.problemStatement}</p>
              </div>
            )}
            {incidentData.equipmentName && (
              <div>
                <p className="text-[10px] text-muted-foreground font-mono mb-1">EQUIPMENT</p>
                <p>{incidentData.equipmentName}</p>
              </div>
            )}
            {incidentData.location && (
              <div>
                <p className="text-[10px] text-muted-foreground font-mono mb-1">LOCATION</p>
                <p>{incidentData.location}</p>
              </div>
            )}
            {incidentData.timestamp && (
              <div>
                <p className="text-[10px] text-muted-foreground font-mono mb-1">FAILURE TIMESTAMP</p>
                <p>{incidentData.timestamp}</p>
              </div>
            )}
            {incidentData.effect && (
              <div className="sm:col-span-2">
                <p className="text-[10px] text-muted-foreground font-mono mb-1">OPERATIONAL EFFECT</p>
                <p className="text-destructive/90">{incidentData.effect}</p>
              </div>
            )}
          </div>
        </div>

        {/* Root Causes */}
        {reportPayload?.rootCauses?.length > 0 && (
          <div className="rounded-xl border border-border/60 p-5 space-y-3">
            <h2 className="text-sm font-bold font-mono uppercase tracking-wide border-b border-border/40 pb-2">
              Root Causes Identified
            </h2>
            <ul className="space-y-2">
              {reportPayload.rootCauses.map((rc: string, i: number) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="w-5 h-5 rounded-full bg-destructive/20 text-destructive flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  {rc}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Action Plan */}
        {Array.isArray(reportPayload?.actionPlan) && reportPayload.actionPlan.length > 0 && (
          <div className="rounded-xl border border-border/60 p-5 space-y-3">
            <h2 className="text-sm font-bold font-mono uppercase tracking-wide border-b border-border/40 pb-2">
              CAPA Action Plan
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40">
                    <th className="text-left py-2 pr-3 text-muted-foreground font-mono">#</th>
                    <th className="text-left py-2 pr-3 text-muted-foreground font-mono">Action</th>
                    <th className="text-left py-2 pr-3 text-muted-foreground font-mono">Type</th>
                    <th className="text-left py-2 pr-3 text-muted-foreground font-mono">Responsible</th>
                    <th className="text-left py-2 text-muted-foreground font-mono">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {reportPayload.actionPlan.map((a: any, i: number) => (
                    <tr key={i} className="border-b border-border/20">
                      <td className="py-2 pr-3 text-muted-foreground">{a.srNo ?? i + 1}</td>
                      <td className="py-2 pr-3">{a.action}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{a.type}</td>
                      <td className="py-2 pr-3">{a.responsible}</td>
                      <td className="py-2">{a.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Team Members */}
        {Array.isArray(reportPayload?.teamMembers) && reportPayload.teamMembers.length > 0 && (
          <div className="rounded-xl border border-border/60 p-5 space-y-3">
            <h2 className="text-sm font-bold font-mono uppercase tracking-wide border-b border-border/40 pb-2">
              Investigation Team
            </h2>
            <div className="flex flex-wrap gap-2">
              {reportPayload.teamMembers.map((m: any, i: number) => (
                <div key={i} className="px-3 py-1.5 rounded-lg border border-border/60 bg-secondary/20 text-xs">
                  <p className="font-medium">{m.name || m.email}</p>
                  {m.department && <p className="text-muted-foreground">{m.department}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-[10px] text-muted-foreground font-mono pb-4">
          Generated by RCA Analyser · This report is publicly shared
        </p>
      </div>
    </div>
  );
}
