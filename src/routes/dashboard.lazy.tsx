import { createLazyFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useRef } from "react";
import { AuthGate } from "@/components/app-shell";
import { listMyCases, createRcaCase, deleteCase, preAnalyzeIncident, downloadRcaReport } from "@/lib/rca.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, FileText, CheckCircle2, Clock, Paperclip, X, Eye, Sparkles, Loader2, Globe, Users, Download, Play, Search, Circle } from "lucide-react";
import { toast } from "sonner";

function parsePartialJson(jsonStr: string): any {
  let cleaned = jsonStr.trim();
  if (!cleaned) return null;

  // Remove leading ```json or ```
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1).trim();
    } else {
      cleaned = cleaned.slice(3).trim();
    }
  }
  // Remove trailing ```
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3).trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") openBraces++;
      else if (char === "}") openBraces--;
      else if (char === "[") openBrackets++;
      else if (char === "]") openBrackets--;
    }
  }

  if (inString) {
    cleaned += '"';
  }

  cleaned = cleaned.trim();
  if (cleaned.endsWith(",")) {
    cleaned = cleaned.slice(0, -1);
  }

  while (openBrackets > 0) {
    cleaned += "]";
    openBrackets--;
  }

  while (openBraces > 0) {
    cleaned += "}";
    openBraces--;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export const Route = createLazyFileRoute("/dashboard")({
  component: () => (
    <AuthGate>
      <DashboardPage />
    </AuthGate>
  ),
});

function DashboardPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [assetId, setAssetId] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<{ filename: string; contentType: string; data: string }[]>([]);
  const [attachmentsPreview, setAttachmentsPreview] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [preAnalyzeStreamText, setPreAnalyzeStreamText] = useState<string | null>(null);
  const [editProblemStatement, setEditProblemStatement] = useState("");
  const [editEffect, setEditEffect] = useState("");
  const [editGaps, setEditGaps] = useState("");
  const [editFollowUps, setEditFollowUps] = useState("");
  const [editEquipmentName, setEditEquipmentName] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editOperatingConditions, setEditOperatingConditions] = useState("");
  const [editTimestamp, setEditTimestamp] = useState("");
  const [editWitnessedSymptoms, setEditWitnessedSymptoms] = useState("");
  const [isApproved, setIsApproved] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [downloadingCaseId, setDownloadingCaseId] = useState<string | null>(null);

  const downloadReportFn = useServerFn(downloadRcaReport);

  const triggerDownload = async (caseId: string, format: "pdf" | "docx") => {
    setDownloadingCaseId(caseId);
    try {
      const r = await downloadReportFn({ data: { caseId, format } });
      if (!r?.base64) throw new Error("No data returned");
      const b = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const bl = new Blob([b], { type: r.mimeType });
      const u = URL.createObjectURL(bl);
      const a = document.createElement("a");
      a.href = u;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(u);
      toast.success(`${format.toUpperCase()} report downloaded successfully`);
    } catch (e: any) {
      toast.error(e.message || "Failed to download report");
    } finally {
      setDownloadingCaseId(null);
    }
  };

  const getNextStepIndex = (completedAgentsList: string[]) => {
    const completedSet = new Set(completedAgentsList || []);
    const agentsKeys = ["data_collector", "timeline", "equipment", "five_why", "fishbone", "fta", "pareto", "report"];
    const firstIncomplete = agentsKeys.findIndex(key => !completedSet.has(key));
    return firstIncomplete === -1 ? 7 : firstIncomplete;
  };

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (file.size > 50 * 1024 * 1024) {
        toast.error(`${file.name} exceeds 50MB limit`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = ev.target?.result as string;
        const base64 = result.split(",")[1] || result;
        setAttachments((prev) => [
          ...prev,
          { filename: file.name, contentType: file.type, data: base64 },
        ]);
        setAttachmentsPreview((prev) => [...prev, result]);
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.indexOf("image") !== -1) {
        const file = item.getAsFile();
        if (file) {
          if (file.size > 50 * 1024 * 1024) {
            toast.error("Pasted image exceeds 50MB limit");
            continue;
          }
          const reader = new FileReader();
          reader.onload = (ev) => {
            const result = ev.target?.result as string;
            const base64 = result.split(",")[1] || result;
            setAttachments((prev) => [
              ...prev,
              { filename: file.name || "pasted-image.png", contentType: file.type, data: base64 },
            ]);
            setAttachmentsPreview((prev) => [...prev, result]);
            toast.success("Image pasted from clipboard");
          };
          reader.readAsDataURL(file);
        }
      }
    }
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
    setAttachmentsPreview((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const listCasesFn = useServerFn(listMyCases);
  const { data, isLoading } = useQuery({
    queryKey: ["cases"],
    queryFn: () => listCasesFn(),
  });

  const preAnalyzeFn = useServerFn(preAnalyzeIncident);
  const preAnalyzeMut = useMutation({
    mutationFn: async () => {
      setPreAnalyzeStreamText("");
      setIsApproved(false);
      setEditProblemStatement("");
      setEditEffect("");
      setEditGaps("");
      setEditFollowUps("");
      setEditEquipmentName("");
      setEditLocation("");
      setEditOperatingConditions("");
      setEditTimestamp("");
      setEditWitnessedSymptoms("");
      const res = await preAnalyzeFn({ data: { title, assetId: assetId || null, description, attachments } });
      if (!(res instanceof Response)) {
        return res;
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || "Pre-analysis streaming failed");
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body available");

      const decoder = new TextDecoder();
      let accumulated = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        setPreAnalyzeStreamText(accumulated);

        const parsed = parsePartialJson(accumulated);
        if (parsed) {
          const problem = parsed.problemStatement || "";
          const effect = parsed.effect || parsed.effectImpact || "";
          const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.join("\n") : "";
          const followUps = Array.isArray(parsed.followUps) ? parsed.followUps.join("\n") : "";
          const context = parsed.operationalContext || {};
          const equip = parsed.equipmentName || context.equipmentName || "";
          const loc = parsed.location || context.location || "";
          const opCond = parsed.operatingConditions || context.operatingConditions || "";
          const tstamp = parsed.timestamp || context.timestamp || "";
          const symptoms = parsed.witnessedSymptoms || context.witnessedSymptoms || "";

          if (problem) setEditProblemStatement(problem);
          if (effect) setEditEffect(effect);
          if (gaps) setEditGaps(gaps);
          if (followUps) setEditFollowUps(followUps);
          if (equip) setEditEquipmentName(equip);
          if (loc) setEditLocation(loc);
          if (opCond) setEditOperatingConditions(opCond);
          if (tstamp) setEditTimestamp(tstamp);
          if (symptoms) setEditWitnessedSymptoms(symptoms);
        }
      }
      return accumulated;
    },
    onSuccess: () => {
      toast.success("Initial incident pre-analysis complete! Please review, edit, and approve findings below.");
    },
    onError: (err: any) => {
      setPreAnalyzeStreamText(null);
      toast.error(err.message || "Pre-analysis failed");
    },
  });

  const createFn = useServerFn(createRcaCase);
  const createMut = useMutation({
    mutationFn: async () => {
      const preAnalyzedData = isApproved ? {
        problemStatement: editProblemStatement,
        effect: editEffect,
        gaps: editGaps.split("\n").map(l => l.trim()).filter(Boolean),
        followUps: editFollowUps.split("\n").map(l => l.trim()).filter(Boolean),
        equipmentName: editEquipmentName || null,
        location: editLocation || null,
        operatingConditions: editOperatingConditions || null,
        timestamp: editTimestamp || null,
        witnessedSymptoms: editWitnessedSymptoms || null,
      } : null;

      return createFn({
        data: {
          title,
          assetId: assetId || null,
          description,
          attachments,
          preAnalyzedData,
        }
      });
    },
    onSuccess: (result: any) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      // Reset form fields
      setTitle("");
      setAssetId("");
      setDescription("");
      setAttachments([]);
      setAttachmentsPreview([]);
      setPreAnalyzeStreamText(null);
      setEditProblemStatement("");
      setEditEffect("");
      setEditGaps("");
      setEditFollowUps("");
      setEditEquipmentName("");
      setEditLocation("");
      setEditOperatingConditions("");
      setEditTimestamp("");
      setEditWitnessedSymptoms("");
      setIsApproved(false);
      nav({ to: "/rca/$caseId", params: { caseId: result.case.id } });
    },
  });

  const delFn = useServerFn(deleteCase);
  const delMut = useMutation({
    mutationFn: async (caseId: string) => delFn({ data: { caseId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cases"] }),
  });

  const cases = data?.cases ?? [];

  const filteredCases = cases.filter((c: any) => {
    const search = searchTerm.toLowerCase();
    const titleMatch = c.title?.toLowerCase().includes(search);
    const assetMatch = c.asset_id?.toLowerCase().includes(search);
    if (searchTerm && !titleMatch && !assetMatch) return false;

    const effectiveStatus = c.report_approved === true ? "completed" : c.status;
    if (statusFilter !== "all" && effectiveStatus !== statusFilter) return false;

    if (dateFilter !== "all") {
      const caseDate = new Date(c.updated_at).getTime();
      const now = Date.now();
      if (dateFilter === "7days" && now - caseDate > 7 * 24 * 60 * 60 * 1000) return false;
      if (dateFilter === "30days" && now - caseDate > 30 * 24 * 60 * 60 * 1000) return false;
    }

    return true;
  }).sort((a: any, b: any) => {
    if (sortBy === "newest") return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    if (sortBy === "oldest") return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    if (sortBy === "title_asc") return (a.title || "").localeCompare(b.title || "");
    if (sortBy === "title_desc") return (b.title || "").localeCompare(a.title || "");
    return 0;
  });

  const renderTrainTrack = (c: any) => {
    const agentKeys = ["data_collector", "timeline", "equipment", "five_why", "fishbone", "fta", "pareto", "report"];
    const completedSet = new Set(c.completed_agents || []);
    const isCompleted = c.report_approved === true;
    const firstIncompleteIdx = isCompleted ? -1 : agentKeys.findIndex(key => !completedSet.has(key));

    return (
      <div className="flex items-center w-full py-1.5">
        {agentKeys.map((key, idx) => {
          const stepNum = idx + 1;
          const isStepComplete = isCompleted || completedSet.has(key);
          const isStepActive = !isCompleted && idx === firstIncompleteIdx;
          
          return (
            <div key={key} className="flex-1 flex items-center min-w-0">
              <div 
                className={`relative z-10 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold mono shrink-0 border transition-all duration-300 ${
                  isStepComplete
                    ? "bg-emerald-500/10 border-emerald-500 text-emerald-400"
                    : isStepActive
                      ? "bg-primary/20 border-primary text-primary animate-pulse shadow-[0_0_6px_rgba(246,159,58,0.3)] font-black scale-110"
                      : "bg-secondary border-border text-muted-foreground/30"
                }`}
                title={`${stepNum}. ${key.replace("_", " ")} (${isStepComplete ? "Complete" : isStepActive ? "Active" : "Pending"})`}
              >
                {stepNum}
              </div>
              {idx < agentKeys.length - 1 && (
                <div 
                  className={`flex-1 h-0.5 min-w-[4px] transition-all duration-300 ${
                    isStepComplete && (isCompleted || completedSet.has(agentKeys[idx + 1]))
                      ? "bg-emerald-500"
                      : isStepComplete && !isCompleted && (idx + 1 === firstIncompleteIdx)
                        ? "bg-gradient-to-r from-emerald-500 to-primary"
                        : "bg-border/30"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">RCA Cases</h1>
          <p className="text-sm text-muted-foreground mono">{cases.length} total incidents</p>
        </div>
        <Button onClick={() => setShowNew((v) => !v)}>
          <Plus className="w-4 h-4 mr-2" />
          New RCA
        </Button>
      </div>

      {showNew && (
        <div className="panel">
          <div className="panel-header">
            <span>NEW INCIDENT</span>
          </div>
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2 space-y-1">
                <label className="text-xs text-muted-foreground mono">TITLE</label>
                <Input
                  placeholder="Incident title (e.g. Furnace-01 trip due to Zone 3 overheating)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground mono">ASSET ID</label>
                <Input
                  placeholder="Asset ID (optional, e.g. FURN-01)"
                  value={assetId}
                  onChange={(e) => setAssetId(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground mono">INITIAL PROBLEM DETAILS / SYMPTOMS (PASTE IMAGES HERE ALSO)</label>
              <div className="border border-input rounded-md bg-[var(--input-bg)] flex flex-col focus-within:ring-1 focus-within:ring-ring focus-within:border-primary transition-all">
                <Textarea
                  placeholder="Describe the symptoms, initial observations, sequence of alarms, etc. You can paste screenshots here directly."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onPaste={handlePaste}
                  rows={5}
                  className="borderless-textarea font-mono text-sm p-3 w-full resize-y min-h-[120px]"
                />
                <div className="border-t border-border/40 p-2.5 bg-muted/5 flex flex-col gap-2">
                  <input
                    type="file"
                    multiple
                    accept="image/*,.pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.pptx,.ppt"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                  />
                  {attachments.length > 0 && (
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-2">
                      {attachments.map((att, idx) => {
                        const isImage = att.contentType.startsWith("image/");
                        return (
                          <div key={idx} className="relative group border border-border rounded overflow-hidden aspect-video bg-background/50 flex items-center justify-center">
                            {isImage ? (
                              <img src={attachmentsPreview[idx] || ""} className="w-full h-full object-cover" alt="attachment" />
                            ) : (
                              <div className="flex flex-col items-center justify-center p-1 text-center">
                                <FileText className="w-6 h-6 text-primary/70 mb-1" />
                                <span className="text-[9px] text-muted-foreground truncate w-full px-1 text-center">{att.filename}</span>
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => removeAttachment(idx)}
                              className="absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 items-center justify-between">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-3 text-xs flex items-center gap-1.5 cursor-pointer"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip className="w-3.5 h-3.5 text-primary" />
                      Attach files
                    </Button>
                    <span className="text-[10px] text-muted-foreground hidden sm:inline">
                      Images, PDF, Excel, Word, CSV — up to 50MB each
                    </span>
                    <span className="text-[10px] text-muted-foreground sm:hidden">
                      Max 50MB per file
                    </span>
                  </div>
                </div>
              </div>
            </div>
            {/* Step 2: Pre-Analysis Result Panel (if generated) */}
            {preAnalyzeStreamText !== null && (
              <div className="border border-border/80 rounded-lg p-4 bg-secondary/15 space-y-4">
                <div className="flex items-center justify-between border-b border-border/40 pb-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary animate-pulse" />
                    <span className="text-sm font-bold mono uppercase">AI Incident Pre-Analysis Findings</span>
                  </div>
                  {preAnalyzeMut.isPending ? (
                    <span className="flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 bg-primary/10 text-primary rounded border border-primary/30 animate-pulse">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      STREAMING…
                    </span>
                  ) : isApproved ? (
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-green-500/20 text-green-500 rounded border border-green-500/40">
                      APPROVED & READY
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-yellow-500/20 text-yellow-500 rounded border border-yellow-500/40 animate-pulse">
                      AWAITING APPROVAL
                    </span>
                  )}
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground mono">PROBLEM STATEMENT</label>
                    {preAnalyzeMut.isPending && !editProblemStatement ? (
                      <div className="min-h-[72px] rounded-md border border-border/50 bg-background/50 p-3 space-y-2">
                        <div className="h-3 w-full rounded bg-muted/60 animate-pulse" />
                        <div className="h-3 w-5/6 rounded bg-muted/60 animate-pulse" />
                      </div>
                    ) : (
                      <Textarea
                        value={editProblemStatement}
                        onChange={(e) => {
                          setEditProblemStatement(e.target.value);
                          setIsApproved(false);
                        }}
                        className="font-semibold text-sm bg-background/50 font-sans border-border/50 focus:border-primary/50"
                        rows={3}
                        autoResize
                        placeholder="Enter problem statement..."
                      />
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground mono">OPERATIONAL EFFECT / IMPACT</label>
                    {preAnalyzeMut.isPending && !editEffect ? (
                      <div className="min-h-[72px] rounded-md border border-border/50 bg-background/50 p-3 space-y-2">
                        <div className="h-3 w-full rounded bg-muted/60 animate-pulse" />
                        <div className="h-3 w-4/5 rounded bg-muted/60 animate-pulse" />
                      </div>
                    ) : (
                      <Textarea
                        value={editEffect}
                        onChange={(e) => {
                          setEditEffect(e.target.value);
                          setIsApproved(false);
                        }}
                        className="font-semibold text-sm text-destructive bg-background/50 font-sans border-border/50 focus:border-primary/50"
                        rows={3}
                        autoResize
                        placeholder="Enter operational impact..."
                      />
                    )}
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-primary mono">GAPS & UNRESOLVED QUESTIONS (ONE PER LINE)</label>
                    {preAnalyzeMut.isPending && !editGaps ? (
                      <div className="min-h-[96px] rounded-md border border-border/50 bg-background/50 p-3 space-y-2">
                        <div className="h-2.5 w-4/5 rounded bg-muted/60 animate-pulse" />
                        <div className="h-2.5 w-3/5 rounded bg-muted/60 animate-pulse" />
                        <div className="h-2.5 w-2/3 rounded bg-muted/60 animate-pulse" />
                      </div>
                    ) : (
                      <Textarea
                        value={editGaps}
                        onChange={(e) => {
                          setEditGaps(e.target.value);
                          setIsApproved(false);
                        }}
                        className="text-xs text-muted-foreground bg-background/50 font-mono border-border/50 focus:border-primary/50"
                        rows={4}
                        autoResize
                        placeholder="Enter gaps..."
                      />
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-accent mono">SUGGESTED FOLLOW-UPS (ONE PER LINE)</label>
                    {preAnalyzeMut.isPending && !editFollowUps ? (
                      <div className="min-h-[96px] rounded-md border border-border/50 bg-background/50 p-3 space-y-2">
                        <div className="h-2.5 w-3/4 rounded bg-muted/60 animate-pulse" />
                        <div className="h-2.5 w-4/5 rounded bg-muted/60 animate-pulse" />
                        <div className="h-2.5 w-1/2 rounded bg-muted/60 animate-pulse" />
                      </div>
                    ) : (
                      <Textarea
                        value={editFollowUps}
                        onChange={(e) => {
                          setEditFollowUps(e.target.value);
                          setIsApproved(false);
                        }}
                        className="text-xs text-muted-foreground bg-background/50 font-mono border-border/50 focus:border-primary/50"
                        rows={4}
                        autoResize
                        placeholder="Enter follow-ups..."
                      />
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={isApproved ? "outline" : "default"}
                    size="sm"
                    onClick={() => {
                      setIsApproved(true);
                      toast.success("Findings approved! You can now open the workspace.");
                    }}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                    {isApproved ? "Approved" : "Approve & Lock Findings"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => preAnalyzeMut.mutate()}
                    disabled={preAnalyzeMut.isPending}
                  >
                    Regenerate Analysis
                  </Button>
                </div>
              </div>
            )}

            {/* Action footer */}
            <div className="flex flex-col sm:flex-row gap-2 pt-2 sm:items-center justify-between border-t border-border/40 mt-4">
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => preAnalyzeMut.mutate()}
                  disabled={!title || preAnalyzeMut.isPending || createMut.isPending || preAnalyzeStreamText !== null}
                >
                  {preAnalyzeMut.isPending ? (
                    <>
                      <Sparkles className="w-4 h-4 mr-2 animate-spin" />
                      Analyzing details...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Run AI Pre-Analysis
                    </>
                  )}
                </Button>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={() => createMut.mutate()}
                  disabled={!title || createMut.isPending || !isApproved}
                >
                  {createMut.isPending ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating…</>) : "Open workspace"}
                </Button>
                <Button variant="ghost" onClick={() => {
                  setShowNew(false);
                  setPreAnalyzeStreamText(null);
                  setIsApproved(false);
                }}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground mono text-sm">Loading cases…</p>
      ) : cases.length === 0 ? (
        <div className="panel p-10 text-center">
          <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">
            No RCA cases yet. Click <strong>New RCA</strong> to begin.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Search and Filters Bar */}
          <div className="panel p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-secondary/10">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search cases by title or asset ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 h-9 text-xs"
              />
            </div>
            
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 bg-secondary/50 border border-border/50 rounded-lg px-2.5 py-1 h-9">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Status</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-transparent border-0 text-xs font-semibold focus:ring-0 p-0 text-foreground cursor-pointer"
                >
                  <option value="all">All</option>
                  <option value="completed">Completed</option>
                  <option value="in_progress">In Progress</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-secondary/50 border border-border/50 rounded-lg px-2.5 py-1 h-9">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Updated</span>
                <select
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="bg-transparent border-0 text-xs font-semibold focus:ring-0 p-0 text-foreground cursor-pointer"
                >
                  <option value="all">All Time</option>
                  <option value="7days">Last 7 Days</option>
                  <option value="30days">Last 30 Days</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-secondary/50 border border-border/50 rounded-lg px-2.5 py-1 h-9">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Sort</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="bg-transparent border-0 text-xs font-semibold focus:ring-0 p-0 text-foreground cursor-pointer"
                >
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                  <option value="title_asc">Title (A-Z)</option>
                  <option value="title_desc">Title (Z-A)</option>
                </select>
              </div>
            </div>
          </div>

          {filteredCases.length === 0 ? (
            <div className="panel p-10 text-center">
              <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No matching RCA cases found.</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCases.map((c: any) => {
                const isCompleted = c.report_approved === true;
                const nextStepIdx = getNextStepIndex(c.completed_agents);

                return (
                  <div
                    key={c.id}
                    onClick={() => nav({ to: `/rca/${c.id}` as any, search: { step: nextStepIdx } as any })}
                    className={`panel hover:border-primary/50 transition-colors flex flex-col justify-between group cursor-pointer ${c.is_collaborator ? "border-blue-500/20" : ""}`}
                  >
                    <div>
                      <div className="panel-header">
                        <span className="flex items-center gap-1.5">
                          {c.asset_id ?? "no asset"}
                          {c.is_collaborator ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30 font-mono">Collaborator</span>
                          ) : null}
                          {c.is_public ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono flex items-center gap-0.5">
                              <Globe className="w-2.5 h-2.5" /> Public
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-1 font-mono text-[9px]">
                          {isCompleted ? (
                            <span className="flex items-center gap-1 text-[color:var(--signal-ok)] font-semibold">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              COMPLETED
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[color:var(--signal-warn)] font-semibold">
                              <Clock className="w-3.5 h-3.5 animate-pulse" />
                              IN PROGRESS
                            </span>
                          )}
                        </span>
                      </div>
                      
                      <div className="p-4 space-y-3">
                        <h3 className="font-semibold line-clamp-2 text-sm text-foreground">{c.title}</h3>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {new Date(c.updated_at).toLocaleString()}
                        </p>
                        
                        <div className="border-t border-border/30 pt-3">
                          <p className="text-[9px] text-muted-foreground font-mono mb-1.5 uppercase">Pipeline Progress</p>
                          {renderTrainTrack(c)}
                        </div>
                      </div>
                    </div>

                    <div
                      className="px-4 pb-4 flex justify-between items-center border-t border-border/20 pt-3 mt-auto"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex gap-1.5 items-center">
                        {isCompleted ? (
                          <div className="flex gap-1.5">
                            <Button
                              size="sm"
                              disabled={downloadingCaseId === c.id}
                              onClick={(e) => { e.stopPropagation(); triggerDownload(c.id, "pdf"); }}
                              className="h-8 text-xs font-semibold px-3 flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                            >
                              {downloadingCaseId === c.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Download className="w-3.5 h-3.5" />
                              )}
                              PDF
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={downloadingCaseId === c.id}
                              onClick={(e) => { e.stopPropagation(); triggerDownload(c.id, "docx"); }}
                              className="h-8 text-xs font-semibold px-2.5 flex items-center gap-1 cursor-pointer"
                            >
                              DOCX
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); nav({ to: `/rca/${c.id}` as any, search: { step: nextStepIdx } as any }); }}
                            className="h-8 text-xs font-semibold px-3 flex items-center gap-1.5 cursor-pointer bg-primary hover:bg-primary/90 text-primary-foreground border-0"
                          >
                            <Play className="w-3.5 h-3.5 text-current" />
                            Resume
                          </Button>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-1.5">
                        {c.is_public && c.public_slug ? (
                          <a
                            href={`/p/${c.public_slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[10px] font-mono flex items-center gap-1 text-emerald-400 hover:text-emerald-300 mr-2.5"
                          >
                            <Globe className="w-3 h-3" /> Public link
                          </a>
                        ) : null}
                        {!c.is_collaborator && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm("Delete this case?")) delMut.mutate(c.id);
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
