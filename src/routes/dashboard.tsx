import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useRef } from "react";
import { AuthGate } from "@/components/app-shell";
import { listMyCases, createRcaCase, deleteCase, preAnalyzeIncident } from "@/lib/rca.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, FileText, CheckCircle2, Clock, Paperclip, X, Eye, Sparkles, Loader2 } from "lucide-react";
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

export const Route = createFileRoute("/dashboard")({
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">RCA Cases</h1>
          <p className="text-sm text-muted-foreground mono">// {cases.length} total incidents</p>
        </div>
        <Button onClick={() => setShowNew((v) => !v)}>
          <Plus className="w-4 h-4 mr-2" />
          New RCA
        </Button>
      </div>

      {showNew && (
        <div className="panel">
          <div className="panel-header">
            <span>// NEW INCIDENT</span>
          </div>
          <div className="p-4 space-y-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground mono">// TITLE</label>
              <Input
                placeholder="Incident title (e.g. Furnace-01 trip due to Zone 3 overheating)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground mono">// ASSET ID</label>
              <Input
                placeholder="Asset ID (optional, e.g. FURN-01)"
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground mono">// INITIAL PROBLEM DETAILS / SYMPTOMS (PASTE IMAGES HERE ALSO)</label>
              <Textarea
                placeholder="Describe the symptoms, initial observations, sequence of alarms, etc. You can paste screenshots here directly."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                rows={5}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground mono flex items-center gap-1">
                <Paperclip className="w-3.5 h-3.5" /> // ATTACH FILES (photos, docs, reports)
              </label>
              <input
                type="file"
                multiple
                accept="image/*,.pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.pptx,.ppt"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileChange}
              />
              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose Files
                </Button>
                <span className="text-xs text-muted-foreground">
                  Images, PDF (max 120 pages), Excel, Word, CSV — up to 50MB each
                </span>
              </div>
              {attachments.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-2">
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
            </div>
            {/* Step 2: Pre-Analysis Result Panel (if generated) */}
            {preAnalyzeStreamText !== null && (
              <div className="border border-border/80 rounded-lg p-4 bg-secondary/15 space-y-4">
                <div className="flex items-center justify-between border-b border-border/40 pb-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary animate-pulse" />
                    <span className="text-sm font-bold mono uppercase">// AI Incident Pre-Analysis Findings</span>
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
                    <label className="text-xs text-muted-foreground mono">// PROBLEM STATEMENT</label>
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
                    <label className="text-xs text-muted-foreground mono">// OPERATIONAL EFFECT / IMPACT</label>
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
                    <label className="text-xs text-primary mono">// GAPS & UNRESOLVED QUESTIONS (ONE PER LINE)</label>
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
                    <label className="text-xs text-accent mono">// SUGGESTED FOLLOW-UPS (ONE PER LINE)</label>
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
                  disabled={!title || preAnalyzeMut.isPending || createMut.isPending}
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
        <p className="text-muted-foreground mono text-sm">// loading cases…</p>
      ) : cases.length === 0 ? (
        <div className="panel p-10 text-center">
          <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">
            No RCA cases yet. Click <strong>New RCA</strong> to begin.
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cases.map((c: any) => (
            <div key={c.id} className="panel hover:border-primary/50 transition-colors group">
              <div className="panel-header">
                <span>// {c.asset_id ?? "no asset"}</span>
                <span className="flex items-center gap-1">
                  {c.status === "completed" ? (
                    <CheckCircle2 className="w-3 h-3 text-[color:var(--signal-ok)]" />
                  ) : (
                    <Clock className="w-3 h-3 text-[color:var(--signal-warn)]" />
                  )}
                  {c.status}
                </span>
              </div>
              <Link to="/rca/$caseId" params={{ caseId: c.id }} className="block p-4">
                <h3 className="font-semibold line-clamp-2">{c.title}</h3>
                <p className="text-xs text-muted-foreground mono mt-2">
                  {new Date(c.updated_at).toLocaleString()}
                </p>
              </Link>
              <div className="px-4 pb-3 flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm("Delete this case?")) delMut.mutate(c.id);
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
