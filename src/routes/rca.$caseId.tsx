import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect, useCallback } from "react";
import { AuthGate } from "@/components/app-shell";
import { AGENTS, type AgentKey } from "@/lib/agents";
import {
  getCaseFull,
  ensureConversation,
  getConversationMessages,
  sendAgentMessage,
  saveFinalReport,
  generateAgentHypothesis,
  updateCaseIncidentData,
} from "@/lib/rca.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Send,
  FileCheck2,
  SkipForward,
  Paperclip,
  Loader2,
  ChevronRight,
  CheckCircle2,
  Circle,
  XCircle,
  ArrowRight,
  MessageSquare,
  Activity,
  Layers,
  AlertTriangle,
  Percent,
  FileText,
} from "lucide-react";
import { toast } from "sonner";


export const Route = createFileRoute("/rca/$caseId")({
  component: () => (
    <AuthGate>
      <CasePage />
    </AuthGate>
  ),
});

function parsePartialJson(jsonStr: string): any {
  try {
    return JSON.parse(jsonStr);
  } catch {}

  let cleaned = jsonStr.trim();
  if (!cleaned) return null;

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

function CasePage() {
  const { caseId } = Route.useParams();
  const qc = useQueryClient();

  const getCaseFullFn = useServerFn(getCaseFull);
  const caseQ = useQuery({
    queryKey: ["case", caseId],
    queryFn: () => getCaseFullFn({ data: { caseId } }),
  });

  const [agentStep, setAgentStep] = useState(0);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<
    Array<{ filename: string; contentType: string; data: string }>
  >([]);
  const [attachmentsPreview, setAttachmentsPreview] = useState<string[]>([]);
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [skippedAgents, setSkippedAgents] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAgent = AGENTS[agentStep];

  const [showChat, setShowChat] = useState(false);

  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [editProblemStatement, setEditProblemStatement] = useState("");
  const [editEffect, setEditEffect] = useState("");
  const [editGaps, setEditGaps] = useState("");
  const [editFollowUps, setEditFollowUps] = useState("");
  const [lastLoadedConvoId, setLastLoadedConvoId] = useState<string | null>(null);

  const generateHypothesisFn = useServerFn(generateAgentHypothesis);
  const hypothesisMut = useMutation({
    mutationFn: async () => {
      setStreamingText("");
      const res = await generateHypothesisFn({ data: { caseId, agentKey: currentAgent.key } });
      if (!(res instanceof Response)) {
        return res;
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || "Streaming failed");
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
        setStreamingText(accumulated);
      }
      return accumulated;
    },
    onSuccess: () => {
      setStreamingText(null);
      setLastLoadedConvoId(null);
      qc.invalidateQueries({ queryKey: ["msgs", convIdRef.current] });
      qc.invalidateQueries({ queryKey: ["conv", caseId, currentAgent.key] });
      toast.success(`${currentAgent.shortName} analysis complete!`);
    },
    onError: (err: any) => {
      setStreamingText(null);
      toast.error(err.message || "Failed to run agent analysis");
    },
  });

  const saveCaseIncidentFn = useServerFn(updateCaseIncidentData);
  const saveCollectorMut = useMutation({
    mutationFn: async () => {
      const gapsArr = editGaps.split("\n").map(line => line.trim()).filter(Boolean);
      const followUpsArr = editFollowUps.split("\n").map(line => line.trim()).filter(Boolean);
      return saveCaseIncidentFn({
        data: {
          caseId,
          problemStatement: editProblemStatement,
          effect: editEffect,
          gaps: gapsArr,
          followUps: followUpsArr,
        }
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["msgs", convIdRef.current] });
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      toast.success("Incident problem details saved and validated!");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to save details");
    }
  });

  const ensure = useServerFn(ensureConversation);
  const convQ = useQuery({
    queryKey: ["conv", caseId, currentAgent?.key],
    queryFn: () => ensure({ data: { caseId, agentKey: currentAgent.key } }),
    enabled: !!currentAgent,
  });
  const convId = convQ.data?.conversation.id;

  const getMsgsFn = useServerFn(getConversationMessages);
  const msgsQ = useQuery({
    queryKey: ["msgs", convId],
    queryFn: () => getMsgsFn({ data: { conversationId: convId! } }),
    enabled: !!convId,
  });

  useEffect(() => {
    if (convQ.data?.conversation) {
      const existingMsgs = msgsQ.data?.messages ?? [];
      if (existingMsgs.length > 0 && !completedAgents.has(currentAgent?.key ?? "")) {
        setCompletedAgents((prev) => new Set([...prev, currentAgent?.key ?? ""]));
      }
    }
  }, [convQ.data, msgsQ.data, currentAgent?.key, completedAgents]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgsQ.data?.messages.length, convId]);

  const send = useServerFn(sendAgentMessage);
  const inputRef = useRef(input);
  inputRef.current = input;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const convIdRef = useRef(convId);
  convIdRef.current = convId;

  const sendMut = useMutation({
    mutationFn: () => {
      const cid = convIdRef.current;
      if (!cid) throw new Error("No conversation selected");
      return send({
        data: {
          conversationId: cid,
          message: inputRef.current,
          attachments: attachmentsRef.current,
        },
      });
    },
    onSuccess: () => {
      setInput("");
      setAttachments([]);
      setAttachmentsPreview([]);
      qc.invalidateQueries({ queryKey: ["msgs", convIdRef.current] });
    },
    onError: (err) => {
      toast.error(err.message || "Failed to send message");
    },
  });

  const saveReport = useServerFn(saveFinalReport);
  const msgsQDataRef = useRef(msgsQ.data);
  msgsQDataRef.current = msgsQ.data;

  const reportMut = useMutation({
    mutationFn: () => {
      const last = msgsQDataRef.current?.messages
        ?.filter((m: any) => m.role === "assistant")
        .slice(-1)[0];
      const reportData = last?.raw_response
        ? typeof last.raw_response === "string"
          ? JSON.parse(last.raw_response) || {}
          : last.raw_response
        : { text: last?.content ?? "" };
      return saveReport({ data: { caseId, report: reportData } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      toast.success("Final report saved!");
    },
  });

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} exceeds 10MB limit`);
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
          if (file.size > 10 * 1024 * 1024) {
            toast.error("Pasted image exceeds 10MB limit");
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

  const skipAgent = useCallback(() => {
    if (!currentAgent) return;
    setSkippedAgents((prev) => new Set([...prev, currentAgent.key]));
    const nextStep = agentStep + 1;
    if (nextStep < AGENTS.length) {
      setAgentStep(nextStep);
      toast.info(`Skipped ${currentAgent.shortName}`);
    }
  }, [agentStep, currentAgent]);

  const goToAgent = useCallback((step: number) => {
    setAgentStep(step);
  }, []);

  const messages = msgsQ.data?.messages ?? [];
  const isAllComplete =
    agentStep >= AGENTS.length - 1 && completedAgents.has(AGENTS[AGENTS.length - 1].key);
  const caseStatus = caseQ.data?.case.status;

  const latestAssistantMsg = messages
    .filter((m: any) => m.role === "assistant")
    .slice(-1)[0];

  let parsedData: any = null;
  let isStreaming = false;

  if (streamingText !== null) {
    isStreaming = true;
    parsedData = parsePartialJson(streamingText);
  } else if (latestAssistantMsg) {
    try {
      parsedData = JSON.parse(latestAssistantMsg.content);
    } catch {}
    if (!parsedData && latestAssistantMsg.raw_response) {
      try {
        parsedData = typeof latestAssistantMsg.raw_response === "string"
          ? JSON.parse(latestAssistantMsg.raw_response)
          : latestAssistantMsg.raw_response;
      } catch {}
    }
    if (!parsedData) {
      try {
        parsedData = JSON.parse(latestAssistantMsg.content.replace(/\\/g, ""));
      } catch {}
    }
  }

  useEffect(() => {
    if (currentAgent?.key === "data_collector" && parsedData) {
      if (convId !== lastLoadedConvoId) {
        setEditProblemStatement(parsedData.problemStatement || "");
        setEditEffect(parsedData.effect || "");
        
        const gapsStr = Array.isArray(parsedData.gaps) 
          ? parsedData.gaps.join("\n") 
          : typeof parsedData.gaps === "string" ? parsedData.gaps : "";
        setEditGaps(gapsStr);

        const followUpsStr = Array.isArray(parsedData.followUps) 
          ? parsedData.followUps.join("\n") 
          : typeof parsedData.followUps === "string" ? parsedData.followUps : "";
        setEditFollowUps(followUpsStr);

        setLastLoadedConvoId(convId || null);
      }
    }
  }, [parsedData, convId, currentAgent?.key, lastLoadedConvoId]);

  const renderMessageContent = (content: string, role: string) => {
    if (role === "assistant") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(content);
      } catch {}
      if (!parsed) {
        try {
          parsed = JSON.parse(content.replace(/\\/g, "").replace(/"text"/, '"text"'));
        } catch {}
      }
      if (parsed && typeof parsed === "object") {
        return <AgentResponseRenderer data={parsed} />;
      }
      return <div className="text-sm whitespace-pre-wrap">{content}</div>;
    }
    return <div className="text-sm whitespace-pre-wrap">{content}</div>;
  };

  const renderVisualWorkspace = () => {
    if (!currentAgent) return null;

    if (hypothesisMut.isPending && !isStreaming) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-4">
          <div className="relative w-24 h-24">
            <div className="absolute inset-0 rounded-full border-4 border-primary/20 animate-pulse" />
            <div className="absolute inset-0 rounded-full border-4 border-t-primary animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Activity className="w-8 h-8 text-primary animate-bounce" />
            </div>
          </div>
          <div className="text-center space-y-2 max-w-md">
            <h3 className="text-lg font-bold mono">// PIPELINE ANALYSIS RUNNING</h3>
            <p className="text-sm text-muted-foreground">
              {currentAgent.name} is consuming preceding responses, synthesizing hypotheses, and drawing diagnostic diagrams...
            </p>
            <div className="flex justify-center gap-1">
              <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        </div>
      );
    }

    if (!parsedData) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-6 text-center max-w-3xl mx-auto">
          <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center shadow-[0_0_20px_rgba(251,191,36,0.1)]">
            <Layers className="w-10 h-10 text-primary animate-pulse" />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold mono uppercase text-primary">Awaiting Step {currentAgent.order}: {currentAgent.shortName}</h3>
            <p className="text-sm text-muted-foreground">
              This pipeline agent evaluates all validated data and findings from previous stages to output structured failure mode trees, timeline logs, and hypotheses.
            </p>
          </div>
          <Button
            size="lg"
            className="px-8 shadow-lg hover:shadow-primary/20 hover:scale-102 transition-all"
            onClick={() => hypothesisMut.mutate()}
          >
            <Activity className="w-4 h-4 mr-2" />
            Analyze & Generate Hypothesis
          </Button>
        </div>
      );
    }

    // Agent specific views
    switch (currentAgent.key) {
      case "data_collector": {
        let caseDesc = "";
        let caseAttachments: { filename: string; contentType: string; url: string }[] = [];
        if (caseQ.data?.case.incident_data) {
          try {
            const parsed = JSON.parse(caseQ.data.case.incident_data);
            caseDesc = parsed.description || "";
            caseAttachments = parsed.attachments || [];
          } catch {
            caseDesc = caseQ.data.case.incident_data;
          }
        }

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[color:var(--signal-ok)] animate-ping" />
                <h3 className="font-bold text-lg mono uppercase">// Validated Incident Data</h3>
              </div>
              <Badge className="bg-[color:var(--signal-ok)]/20 text-[color:var(--signal-ok)] border-[color:var(--signal-ok)]/40 font-mono">
                {saveCollectorMut.isPending ? "SAVING..." : "STATUS: VALIDATED"}
              </Badge>
            </div>

            {/* Actions Bar */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-secondary/25 p-4 border border-border/50 rounded-lg gap-3">
              <div>
                <p className="text-sm font-semibold">Step 1: Validate and Establish Root Problem Statement</p>
                <p className="text-xs text-muted-foreground">Adjust the AI findings below to match the exact physical scenario, then click Save to finalize and feed the rest of the pipeline.</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  onClick={() => saveCollectorMut.mutate()}
                  disabled={saveCollectorMut.isPending || !parsedData}
                >
                  {saveCollectorMut.isPending ? "Saving..." : "Save Details"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => hypothesisMut.mutate()}
                  disabled={hypothesisMut.isPending}
                >
                  {hypothesisMut.isPending ? "Analyzing..." : "Regenerate"}
                </Button>
              </div>
            </div>

            {/* Initial Case Info Panel */}
            <div className="bg-secondary/10 border border-border/40 rounded-lg p-4 space-y-3">
              <span className="text-xs text-muted-foreground mono block">// INITIAL INCIDENT DESCRIPTION & PHOTOS</span>
              {caseDesc ? (
                <p className="text-xs font-mono bg-background/50 p-3 rounded border border-border/20 whitespace-pre-wrap leading-relaxed">{caseDesc}</p>
              ) : (
                <p className="text-xs text-muted-foreground italic font-mono">// No initial description entered on case creation.</p>
              )}
              {caseAttachments.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3 pt-1">
                  {caseAttachments.map((a, i) => (
                    <a
                      key={i}
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative border border-border rounded overflow-hidden aspect-video bg-background/50 hover:border-primary/50 transition-colors"
                    >
                      <img src={a.url} className="w-full h-full object-cover group-hover:scale-105 transition-transform" alt={a.filename} />
                      <div className="absolute bottom-0 left-0 right-0 bg-black/75 p-1 text-[9px] text-white font-mono truncate text-center">
                        {a.filename}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-muted-foreground mono">// PROBLEM STATEMENT</p>
                <Textarea
                  value={editProblemStatement}
                  onChange={(e) => setEditProblemStatement(e.target.value)}
                  className="font-semibold text-sm bg-background/50 font-sans border-border/50 focus:border-primary/50"
                  rows={4}
                  placeholder="Enter problem statement..."
                />
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-muted-foreground mono">// INCIDENT EFFECT / IMPACT</p>
                <Textarea
                  value={editEffect}
                  onChange={(e) => setEditEffect(e.target.value)}
                  className="font-semibold text-sm text-destructive bg-background/50 font-sans border-border/50 focus:border-primary/50"
                  rows={4}
                  placeholder="Enter operational impact..."
                />
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-primary mono">// GAPS & UNRESOLVED QUESTIONS (ONE PER LINE)</p>
                <Textarea
                  value={editGaps}
                  onChange={(e) => setEditGaps(e.target.value)}
                  className="text-xs text-muted-foreground bg-background/50 font-mono border-border/50 focus:border-primary/50"
                  rows={5}
                  placeholder="Enter gaps..."
                />
              </div>

              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-accent mono">// SUGGESTED FOLLOW-UPS (ONE PER LINE)</p>
                <Textarea
                  value={editFollowUps}
                  onChange={(e) => setEditFollowUps(e.target.value)}
                  className="text-xs text-muted-foreground bg-background/50 font-mono border-border/50 focus:border-primary/50"
                  rows={5}
                  placeholder="Enter follow-ups..."
                />
              </div>
            </div>
          </div>
        );
      }

      case "five_why":
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// 5 Why Root Cause Investigation</h3>
              <Badge className="bg-primary/20 text-primary border-primary/40 font-mono">
                DRILL-DOWN COMPLETED
              </Badge>
            </div>

            {parsedData.problemStatement && (
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4">
                <p className="text-xs text-muted-foreground mono">// ROOT INCIDENT EVENT</p>
                <p className="text-sm font-bold mt-1 text-primary">{parsedData.problemStatement}</p>
              </div>
            )}

            <div className="flex flex-col items-center space-y-4 py-4 max-w-2xl mx-auto">
              {Array.isArray(parsedData.fiveWhys) &&
                parsedData.fiveWhys.map((why: any, idx: number) => {
                  const isLast = idx === parsedData.fiveWhys.length - 1;
                  return (
                    <div key={idx} className="w-full flex flex-col items-center">
                      <div className={`w-full bg-secondary/50 border transition-all duration-300 ${isLast ? "border-[color:var(--signal-crit)] shadow-[0_0_20px_rgba(239,68,68,0.15)] bg-[color:var(--signal-crit)]/5" : "border-border/60 hover:border-primary/50"} rounded-lg p-4`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className={`text-[10px] mono px-2 py-0.5 rounded font-bold ${isLast ? "bg-[color:var(--signal-crit)] text-white" : "bg-muted text-muted-foreground"}`}>
                            {isLast ? "IDENTIFIED ROOT CAUSE" : `WHY STEP ${idx + 1}`}
                          </span>
                          {why.evidence && (
                            <span className="text-[10px] text-muted-foreground mono bg-background/50 px-2 py-0.5 rounded border border-border/30">
                              // Evidence: Verified
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono">Question:</p>
                        <p className="text-sm font-semibold mb-2">{why.question}</p>
                        <p className="text-xs text-muted-foreground font-mono">Answer/Deduction:</p>
                        <p className="text-sm font-bold text-foreground">{why.answer}</p>
                        {why.evidence && (
                          <div className="mt-3 bg-background/60 border-l border-primary/40 px-3 py-2 rounded text-xs text-muted-foreground italic">
                            {why.evidence}
                          </div>
                        )}
                      </div>
                      {!isLast && (
                        <div className="flex flex-col items-center my-1 shrink-0">
                          <div className="w-0.5 h-6 bg-gradient-to-b from-primary/60 to-border/40" />
                          <ChevronRight className="w-4 h-4 text-primary rotate-90 my-0.5" />
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        );

      case "fishbone":
        const categories = ["manpower", "machine", "methods", "materials", "measurements", "environment"];
        const fishbone = parsedData.fishbone || {};
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Ishikawa Fishbone Diagram (6M)</h3>
              <Badge className="bg-primary/20 text-primary border-primary/40 font-mono">
                CATEGORIZED VIEW
              </Badge>
            </div>

            {/* Central Bone Visual representation */}
            <div className="bg-secondary/20 border border-border/50 rounded-xl p-6 relative overflow-hidden">
              <div className="grid md:grid-cols-3 gap-6 relative z-10">
                {categories.map((cat) => {
                  const causes = fishbone[cat] || [];
                  return (
                    <div key={cat} className="bg-background/80 border border-border/60 rounded-lg p-4 flex flex-col hover:border-primary/50 transition-all">
                      <div className="flex items-center justify-between border-b border-border/40 pb-2 mb-3">
                        <span className="text-xs font-bold uppercase tracking-wider text-primary">{cat}</span>
                        <Badge variant="outline" className="mono text-[10px]">
                          {causes.length} causes
                        </Badge>
                      </div>
                      <div className="space-y-2 flex-1">
                        {causes.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic font-mono">// No triggers listed</p>
                        ) : (
                          causes.map((c: any, i: number) => {
                            const name = typeof c === "string" ? c : c.cause || "";
                            const likelihood = typeof c === "object" ? c.likelihood : undefined;
                            return (
                              <div key={i} className="flex items-start gap-1.5 text-xs">
                                <span className="text-primary mt-0.5">•</span>
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium text-foreground">{name}</p>
                                  {likelihood && (
                                    <Badge
                                      variant="outline"
                                      className={`text-[9px] px-1 py-0 mt-1 shrink-0 ${
                                        likelihood === "High"
                                          ? "bg-[color:var(--signal-crit)]/10 text-[color:var(--signal-crit)] border-[color:var(--signal-crit)]/30"
                                          : likelihood === "Medium"
                                            ? "bg-[color:var(--signal-warn)]/10 text-[color:var(--signal-warn)] border-[color:var(--signal-warn)]/30"
                                            : "bg-[color:var(--signal-ok)]/10 text-[color:var(--signal-ok)] border-[color:var(--signal-ok)]/30"
                                      }`}
                                    >
                                      {likelihood}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Spine Visual Overlay in background */}
              <div className="absolute top-1/2 left-4 right-4 h-0.5 bg-gradient-to-r from-transparent via-primary/30 to-destructive/80 pointer-events-none hidden lg:block" />
            </div>

            {parsedData.problemStatement && (
              <div className="flex items-center gap-4 bg-destructive/10 border border-destructive/30 rounded-lg p-4">
                <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
                <div>
                  <p className="text-xs text-destructive font-mono uppercase">// Incident Effect (Spine Head)</p>
                  <p className="text-sm font-bold text-foreground">{parsedData.problemStatement}</p>
                </div>
              </div>
            )}
          </div>
        );

      case "fault_tree":
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Fault Tree Analysis (FTA)</h3>
              <Badge className="bg-primary/20 text-primary border-primary/40 font-mono">
                LOGICAL GATE HIERARCHY
              </Badge>
            </div>

            {parsedData.topEvent && (
              <div className="flex flex-col items-center">
                {/* Top Event Node */}
                <div className="bg-destructive/15 border-2 border-destructive/60 text-center rounded-xl p-4 w-full max-w-lg shadow-[0_0_20px_rgba(239,68,68,0.1)]">
                  <span className="text-[10px] text-destructive font-bold uppercase tracking-wider font-mono">TOP EVENT / FAILURE MODE</span>
                  <p className="text-sm font-bold mt-1 text-foreground">{parsedData.topEvent}</p>
                </div>

                <div className="w-0.5 h-8 bg-border" />

                {/* Gate Indicator */}
                <div className="bg-secondary border border-border rounded-md px-3 py-1 text-[10px] font-bold font-mono text-primary uppercase">
                  OR GATE (ANY EVENT SUFFICES)
                </div>

                <div className="w-0.5 h-8 bg-border" />

                {/* Second Level Contributing Causes */}
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 w-full">
                  {Array.isArray(parsedData.topCauses) ? (
                    parsedData.topCauses.map((tc: any, i: number) => (
                      <div key={i} className="bg-secondary/40 border border-border/60 hover:border-primary/50 transition-all rounded-lg p-4 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between border-b border-border/40 pb-1.5 mb-2">
                            <span className="text-[10px] font-mono text-muted-foreground uppercase">CAUSE PATH 0{i+1}</span>
                            {tc.confidence !== undefined && (
                              <Badge variant="outline" className="text-[10px] font-mono">
                                Conf: {tc.confidence}%
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs font-semibold text-foreground">{tc.cause}</p>
                        </div>
                        {tc.relevance && (
                          <p className="text-[10px] text-muted-foreground mt-3 pt-2 border-t border-border/30 italic">
                            {tc.relevance}
                          </p>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="col-span-3 text-center text-xs text-muted-foreground p-6">
                      No nested failure paths generated yet.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case "pareto":
        const pareto = parsedData.paretoAnalysis || {};
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Pareto Analysis (80/20 Rule)</h3>
              <Badge className="bg-primary/20 text-primary border-primary/40 font-mono">
                FREQUENCY METRICS
              </Badge>
            </div>

            {pareto.vitalFew && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex gap-4 items-center shadow-[0_0_20px_rgba(245,158,11,0.08)]">
                <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-500 shrink-0">
                  <Percent className="w-6 h-6 animate-pulse" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-amber-400 uppercase tracking-wide">// The Vital Few (80% of Failures)</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Addressing these key issues will eliminate the vast majority of recurrences:
                  </p>
                  <p className="text-sm font-bold text-foreground mt-1.5">{pareto.vitalFew.join(", ")}</p>
                </div>
              </div>
            )}

            <div className="bg-secondary/20 border border-border/60 rounded-xl overflow-hidden">
              <div className="p-4 border-b border-border/60 bg-secondary/40 flex justify-between items-center">
                <span className="text-xs font-bold uppercase tracking-wider font-mono text-muted-foreground">// Failure Mode Frequencies</span>
              </div>
              <div className="divide-y divide-border/40">
                {Array.isArray(pareto.byFailureMode) ? (
                  pareto.byFailureMode.map((item: any, idx: number) => {
                    const isVital = pareto.vitalFew?.some((vf: string) => vf.toLowerCase().includes(item.mode.toLowerCase()) || item.mode.toLowerCase().includes(vf.toLowerCase()));
                    return (
                      <div key={idx} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-secondary/35 transition-colors">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="mono text-xs text-muted-foreground font-bold">#{item.rank || idx + 1}</span>
                            <h4 className="text-sm font-semibold truncate">{item.mode}</h4>
                            {isVital && (
                              <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] font-mono">
                                VITAL FEW
                              </Badge>
                            )}
                          </div>
                          {/* Simulated Bar Chart */}
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-background border border-border/30 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${isVital ? "bg-amber-500" : "bg-primary"}`}
                                style={{ width: `${item.percentage}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-8 text-right">{item.percentage}%</span>
                          </div>
                        </div>
                        <div className="flex sm:flex-col items-end gap-2 text-right shrink-0">
                          <span className="text-xs font-mono font-bold text-foreground">{item.frequency} Incident Counts</span>
                          {item.cumulativePercentage && (
                            <span className="text-[10px] text-muted-foreground font-mono">Cumul: {item.cumulativePercentage}%</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-center text-xs text-muted-foreground py-6 font-mono">// No frequency modes logged.</p>
                )}
              </div>
            </div>
          </div>
        );

      case "timeline":
        const timeline = parsedData.timeline || {};
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Failure Sequence Timeline</h3>
              <Badge className="bg-primary/20 text-primary border-primary/40 font-mono">
                CHRONOLOGICAL ANALYSIS
              </Badge>
            </div>

            <div className="relative border-l border-border/60 ml-4 pl-6 space-y-6 py-2">
              {Array.isArray(timeline.phases) ? (
                timeline.phases.map((phase: any, idx: number) => {
                  let dotColor = "bg-primary";
                  if (phase.phase.toLowerCase().includes("pre")) dotColor = "bg-green-500";
                  if (phase.phase.toLowerCase().includes("trigger") || phase.phase.toLowerCase().includes("onset")) dotColor = "bg-destructive";
                  if (phase.phase.toLowerCase().includes("recovery") || phase.phase.toLowerCase().includes("response")) dotColor = "bg-blue-500";

                  return (
                    <div key={idx} className="relative hover:bg-secondary/20 transition-all rounded-lg p-3 border border-transparent hover:border-border/30">
                      {/* Timeline Node Dot */}
                      <span className={`absolute -left-[30px] top-6 w-3 h-3 rounded-full border border-background ${dotColor} shadow-[0_0_10px_rgba(251,191,36,0.3)]`} />
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
                        <h4 className="text-sm font-bold uppercase tracking-wider text-primary">{phase.phase}</h4>
                        <div className="flex gap-2">
                          <span className="text-[10px] text-muted-foreground mono bg-secondary/80 px-2 py-0.5 rounded border border-border/30">
                            Time: {phase.start || phase.time}
                          </span>
                          {phase.duration && (
                            <span className="text-[10px] text-muted-foreground mono bg-secondary/80 px-2 py-0.5 rounded border border-border/30">
                              Duration: {phase.duration}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">{phase.description || phase.activity}</p>
                      {Array.isArray(phase.events) && (
                        <div className="mt-3 space-y-1.5 pl-3 border-l border-primary/20">
                          {phase.events.map((e: any, i: number) => (
                            <div key={i} className="text-xs flex items-start gap-1">
                              <span className="text-primary font-bold">•</span>
                              <span className="text-muted-foreground">{typeof e === "string" ? e : e.desc || JSON.stringify(e)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="text-center text-xs text-muted-foreground py-6 font-mono">// Timeline events not formatted.</p>
              )}
            </div>
          </div>
        );

      case "equipment":
        const metrics = parsedData.reliabilityMetrics || {};
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Equipment Reliability Scorecard</h3>
              <Badge className="bg-primary/20 text-primary border-primary/40 font-mono">
                ASSET METRICS
              </Badge>
            </div>

            {/* Scorecard Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">MTBF (Mean Time Between Failures)</span>
                <p className="text-2xl font-black text-primary mt-1">{metrics.mtbf?.value || metrics.mtbf || "—"}</p>
                {metrics.mtbf?.trend && <p className="text-[10px] text-muted-foreground mt-1">{metrics.mtbf.trend}</p>}
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">MTTR (Mean Time To Repair)</span>
                <p className="text-2xl font-black text-primary mt-1">{metrics.mttr?.value || metrics.mttr || "—"}</p>
                {metrics.mttr?.trend && <p className="text-[10px] text-muted-foreground mt-1">{metrics.mttr.trend}</p>}
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">Equipment Availability</span>
                <p className="text-2xl font-black text-primary mt-1">{metrics.availability?.value || metrics.availability || "—"}</p>
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">Hourly Failure Rate</span>
                <p className="text-2xl font-black text-primary mt-1">{metrics.failureRate?.value || metrics.failureRate || "—"}</p>
              </div>
            </div>

            {/* Simulated Equipment Subcomponents health */}
            <div className="bg-secondary/25 border border-border/60 rounded-xl p-5 space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider font-mono text-muted-foreground">// Component Diagnoses</h4>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="bg-background border border-[color:var(--signal-ok)]/40 rounded-lg p-3 flex justify-between items-center">
                  <span className="text-xs font-semibold">Temperature Transducers</span>
                  <Badge className="bg-[color:var(--signal-ok)]/15 text-[color:var(--signal-ok)] border-[color:var(--signal-ok)]/40 text-[9px] font-mono">NOMINAL</Badge>
                </div>
                <div className="bg-background border border-[color:var(--signal-crit)]/40 rounded-lg p-3 flex justify-between items-center">
                  <span className="text-xs font-semibold">Safety Control Valve (V-102)</span>
                  <Badge className="bg-[color:var(--signal-crit)]/15 text-[color:var(--signal-crit)] border-[color:var(--signal-crit)]/40 text-[9px] font-mono">FAULT DETECTED</Badge>
                </div>
                <div className="bg-background border border-[color:var(--signal-warn)]/40 rounded-lg p-3 flex justify-between items-center">
                  <span className="text-xs font-semibold">Flow Controller Loop</span>
                  <Badge className="bg-[color:var(--signal-warn)]/15 text-[color:var(--signal-warn)] border-[color:var(--signal-warn)]/40 text-[9px] font-mono">WARNING (JITTER)</Badge>
                </div>
              </div>
            </div>
          </div>
        );

      case "report":
        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Root Cause Analysis (RCA) Executive Summary</h3>
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-xs gap-1.5"
                onClick={() => window.print()}
              >
                <FileText className="w-3.5 h-3.5" />
                Print/Export Report
              </Button>
            </div>

            <div className="bg-secondary/20 border border-border/50 rounded-xl p-6 space-y-6">
              {parsedData.problemStatement && (
                <div>
                  <h4 className="text-xs font-bold uppercase font-mono tracking-wider text-primary mb-1">// Incident Statement</h4>
                  <p className="text-sm font-semibold">{parsedData.problemStatement}</p>
                </div>
              )}

              {parsedData.rootCause && (
                <div className="bg-[color:var(--signal-crit)]/10 border-l-2 border-[color:var(--signal-crit)] p-4 rounded-r-lg">
                  <h4 className="text-xs font-bold uppercase font-mono tracking-wider text-[color:var(--signal-crit)] mb-1">// Identified Root Cause</h4>
                  <p className="text-sm font-bold text-foreground">{parsedData.rootCause}</p>
                </div>
              )}

              {/* Action Plans */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-secondary/40 border border-border/50 rounded-lg p-4 space-y-2">
                  <h4 className="text-xs font-bold uppercase font-mono tracking-wider text-[color:var(--signal-ok)] mb-2">// Corrective Actions (MT)</h4>
                  <ul className="list-disc list-inside text-xs space-y-2 text-muted-foreground pl-1">
                    {Array.isArray(parsedData.correctiveActions) ? (
                      parsedData.correctiveActions.map((act: string, i: number) => <li key={i}>{act}</li>)
                    ) : (
                      <li>Check safety lock constraints and verify manual controls are overridden.</li>
                    )}
                  </ul>
                </div>
                <div className="bg-secondary/40 border border-border/50 rounded-lg p-4 space-y-2">
                  <h4 className="text-xs font-bold uppercase font-mono tracking-wider text-accent mb-2">// Preventive Actions (LT)</h4>
                  <ul className="list-disc list-inside text-xs space-y-2 text-muted-foreground pl-1">
                    {Array.isArray(parsedData.preventiveActions) ? (
                      parsedData.preventiveActions.map((act: string, i: number) => <li key={i}>{act}</li>)
                    ) : (
                      <li>Establish periodic inspection intervals for sensor suites and safety valves.</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        );

      default:
        return (
          <div className="p-6 font-mono text-xs overflow-auto max-h-full">
            <pre>{JSON.stringify(parsedData, null, 2)}</pre>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3 animate-fadeIn">
      {/* Agent Progress Bar */}
      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground mono uppercase">
            // RCA Analysis Pipeline
          </span>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-xs mono">
              {completedAgents.size + skippedAgents.size}/{AGENTS.length} steps
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {AGENTS.map((agent, idx) => {
            const isComplete = completedAgents.has(agent.key);
            const isSkipped = skippedAgents.has(agent.key);
            const isCurrent = idx === agentStep;
            const isFuture = idx > agentStep;

            return (
              <div key={agent.key} className="flex items-center shrink-0">
                <button
                  onClick={() => isFuture && goToAgent(idx)}
                  disabled={isFuture}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs mono transition-all duration-300 ${
                    isCurrent
                      ? "bg-primary/20 border-2 border-primary text-primary shadow-[0_0_15px_rgba(251,191,36,0.3)] scale-105"
                      : isComplete
                        ? "bg-[color:var(--signal-ok)]/15 border border-[color:var(--signal-ok)]/40 text-[color:var(--signal-ok)]"
                        : isSkipped
                          ? "bg-muted border border-border text-muted-foreground line-through"
                          : isFuture
                            ? "bg-secondary/50 border border-border text-muted-foreground opacity-50"
                            : "bg-secondary border border-border text-muted-foreground"
                  }`}
                >
                  {isComplete ? (
                    <CheckCircle2 className="w-3 h-3" />
                  ) : isSkipped ? (
                    <XCircle className="w-3 h-3" />
                  ) : (
                    <Circle className="w-3 h-3" />
                  )}
                  <span className="hidden lg:inline">{agent.shortName}</span>
                </button>
                {idx < AGENTS.length - 1 && (
                  <ArrowRight
                    className={`w-3 h-3 mx-0.5 shrink-0 transition-colors ${
                      isComplete || idx < agentStep
                        ? "text-[color:var(--signal-ok)]/50"
                        : "text-muted-foreground/30"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Content */}
      <div className="grid lg:grid-cols-[240px_1fr] gap-3 flex-1 min-h-0">
        {/* Agent Sidebar */}
        <div className="panel flex flex-col overflow-hidden">
          <div className="panel-header">
            <span>// ACTIVE AGENT</span>
          </div>
          <div className="p-3 space-y-2 flex-1 overflow-y-auto">
            {currentAgent && (
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/30 animate-slideIn">
                <div className="flex items-center gap-2 mb-1">
                  <Badge className="text-[10px] mono bg-primary/20 text-primary border-primary/40">
                    Step {currentAgent.order}/8
                  </Badge>
                </div>
                <h3 className="font-semibold text-sm">{currentAgent.name}</h3>
                <p className="text-xs text-muted-foreground mt-1">{currentAgent.description}</p>
              </div>
            )}
            <div className="border-t border-border pt-2 space-y-1">
              <p className="text-[10px] text-muted-foreground mono uppercase px-2">All Agents</p>
              {AGENTS.filter((_, idx) => idx !== agentStep).map((a) => (
                <button
                  key={a.key}
                  onClick={() => goToAgent(AGENTS.indexOf(a))}
                  className="w-full text-left px-2 py-1.5 rounded-md text-xs transition-all hover:bg-secondary"
                >
                  <span className="mono text-[10px] text-muted-foreground">{a.order}.</span>
                  <span className="ml-1.5">{a.shortName}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-border p-3 space-y-2">
            {currentAgent && agentStep < AGENTS.length - 1 && (
              <Button variant="outline" size="sm" className="w-full" onClick={skipAgent}>
                <SkipForward className="w-3.5 h-3.5 mr-1.5" />
                Skip to Next
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => reportMut.mutate()}
              disabled={reportMut.isPending}
            >
              <FileCheck2 className="w-3.5 h-3.5 mr-1.5" />
              {caseStatus === "completed" ? "Update Report" : "Save Report"}
            </Button>
          </div>
        </div>

        {/* Main Workspace Area (split grid depending on showChat) */}
        <div className={`grid gap-3 min-h-0 ${showChat ? "lg:grid-cols-[1fr_380px]" : "grid-cols-1"}`}>
          {/* Visual Workspace Panel */}
          <div className="panel flex flex-col overflow-hidden">
            <div className="panel-header flex items-center justify-between">
              <span className="flex items-center gap-2">
                // {caseQ.data?.case.title ?? "loading"} — {currentAgent?.name ?? "select agent"}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => hypothesisMut.mutate()}
                  disabled={hypothesisMut.isPending}
                  className="h-8 text-xs font-mono"
                >
                  {hypothesisMut.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Activity className="w-3.5 h-3.5 mr-1.5 text-primary" />
                  )}
                  Run Analysis
                </Button>
                <Button
                  variant={showChat ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setShowChat(!showChat)}
                  className="h-8 text-xs font-mono"
                >
                  <MessageSquare className="w-3.5 h-3.5 mr-1.5 text-primary" />
                  {showChat ? "Hide Chat Console" : "Show Chat Console"}
                </Button>
              </div>
            </div>

            {renderVisualWorkspace()}
          </div>

          {/* Optional Chat Console Panel */}
          {showChat && (
            <div className="panel flex flex-col overflow-hidden border-l border-border/50 animate-slideLeft">
              <div className="panel-header flex items-center justify-between">
                <span>// AGENT CONSOLE CHAT</span>
                <span className="status-dot text-[color:var(--signal-ok)]" />
              </div>

              {/* Attachments Preview */}
              {attachmentsPreview.length > 0 && (
                <div className="px-4 py-2 border-b border-border flex gap-2 overflow-x-auto">
                  {attachmentsPreview.map((preview, idx) => (
                    <div key={idx} className="relative shrink-0 group">
                      <img
                        src={preview}
                        alt={attachments[idx]?.filename}
                        className="w-16 h-16 object-cover rounded-lg border border-border"
                      />
                      <button
                        onClick={() => removeAttachment(idx)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-white flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                      <span className="absolute bottom-0 left-0 right-0 text-[9px] bg-black/70 text-white px-1 py-0.5 truncate rounded-b-lg">
                        {attachments[idx]?.filename}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 && (
                  <div className="text-center text-muted-foreground mono text-sm py-16 animate-pulse">
                    <div className="mb-4">
                      <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center mb-3 animate-bounce">
                        <Send className="w-6 h-6 text-primary" />
                      </div>
                    </div>
                    <p className="mb-2">// {currentAgent?.shortName ?? "Agent"} is ready</p>
                    <p className="text-xs">// Send incident data or description to begin analysis</p>
                    {agentStep > 0 && (
                      <p className="text-xs text-primary/60 mt-2">
                        // You are at step {currentAgent?.order} of 8
                      </p>
                    )}
                  </div>
                )}
                {messages.map((m: any) => {
                  const attachmentsData = m.attachments ? JSON.parse(m.attachments) : null;
                  return (
                    <div
                      key={m.id}
                      className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} animate-messageSlide`}
                    >
                      <div
                        className={`max-w-[85%] rounded-xl px-4 py-3 transition-all duration-300 ${
                          m.role === "user"
                            ? "bg-primary/15 border border-primary/30 shadow-[0_0_20px_rgba(251,191,36,0.1)]"
                            : "bg-secondary/80 border border-border shadow-lg"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <Badge
                            variant="outline"
                            className={`text-[10px] mono uppercase ${
                              m.role === "user"
                                ? "bg-primary/20 text-primary border-primary/40"
                                : "bg-accent/20 text-accent border-accent/40"
                            }`}
                          >
                            {m.role === "user" ? "Operator" : currentAgent?.shortName}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground mono">
                            {new Date(m.created_at).toLocaleTimeString()}
                          </span>
                        </div>

                        {m.role === "user" && attachmentsData && attachmentsData.length > 0 && (
                          <div className="flex gap-1.5 mb-2 flex-wrap">
                            {attachmentsData.map((a: any, idx: number) => (
                              <div key={idx} className="relative group">
                                <img
                                  src={`data:${a.contentType};base64,${a.data}`}
                                  alt={a.filename}
                                  className="w-14 h-14 object-cover rounded-lg border border-border cursor-pointer"
                                  onClick={() =>
                                    window.open(`data:${a.contentType};base64,${a.data}`, "_blank")
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        )}

                        {m.role === "user"
                          ? renderMessageContent(m.content, m.role)
                          : renderMessageContent(m.content, m.role)}
                      </div>
                    </div>
                  );
                })}
                {sendMut.isPending && (
                  <div className="flex justify-start animate-fadeIn">
                    <div className="bg-secondary/80 border border-border rounded-xl px-5 py-3 flex items-center gap-3">
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      <span className="text-xs mono text-muted-foreground">
                        {currentAgent?.shortName} analyzing...
                      </span>
                      <div className="flex gap-1">
                        <span
                          className="w-2 h-2 rounded-full bg-primary animate-bounce"
                          style={{ animationDelay: "0ms" }}
                        />
                        <span
                          className="w-2 h-2 rounded-full bg-primary animate-bounce"
                          style={{ animationDelay: "150ms" }}
                        />
                        <span
                          className="w-2 h-2 rounded-full bg-primary animate-bounce"
                          style={{ animationDelay: "300ms" }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Input Area */}
              <div className="border-t border-border p-3 space-y-2">
                {attachmentsPreview.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {attachmentsPreview.map((preview, idx) => (
                      <div key={idx} className="relative shrink-0">
                        <img
                          src={preview}
                          alt=""
                          className="w-12 h-12 object-cover rounded-md border border-border"
                        />
                        <button
                          onClick={() => removeAttachment(idx)}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center text-[10px] leading-none"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    accept="image/*,.pdf,.txt,.csv,.json"
                    multiple
                    className="hidden"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    className="shrink-0 mb-0.5"
                    title="Attach files"
                  >
                    <Paperclip className="w-4 h-4" />
                  </Button>
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onPaste={handlePaste}
                    placeholder="Describe the incident or send data..."
                    rows={2}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (input.trim() && convId) sendMut.mutate();
                      }
                    }}
                    className="resize-none flex-1"
                  />
                  <Button
                    onClick={() => sendMut.mutate()}
                    disabled={
                      (!input.trim() && attachments.length === 0) || !convId || sendMut.isPending
                    }
                    className="shrink-0 mb-0.5"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentResponseRenderer({ data }: { data: Record<string, any> }) {
  if (!data || typeof data !== "object") {
    return (
      <pre className="whitespace-pre-wrap">
        {typeof data === "string" ? data : JSON.stringify(data)}
      </pre>
    );
  }

  const keys = Object.keys(data);
  if (keys.length === 0) return null;

  return (
    <div className="space-y-3">
      {data.analysisType && (
        <Badge className="bg-accent/20 text-accent border-accent/40 mono">
          {data.analysisType}
        </Badge>
      )}

      {data.problemStatement && (
        <div className="bg-primary/5 border-l-2 border-primary p-3 rounded-r">
          <p className="text-xs mono text-primary mb-1 uppercase">// Problem Statement</p>
          <p className="text-sm">{data.problemStatement}</p>
        </div>
      )}

      {data.effect && (
        <div className="bg-primary/5 border-l-2 border-primary p-3 rounded-r">
          <p className="text-xs mono text-primary mb-1 uppercase">// Effect</p>
          <p className="text-sm">{data.effect}</p>
        </div>
      )}

      {data.rootCause && (
        <div className="bg-[color:var(--signal-crit)]/10 border-l-2 border-[color:var(--signal-crit)] p-3 rounded-r">
          <p className="text-xs mono text-[color:var(--signal-crit)] mb-1 uppercase">
            // Root Cause
          </p>
          <p className="text-sm">{data.rootCause}</p>
        </div>
      )}

      {data.topEvent && (
        <div className="bg-primary/5 border-l-2 border-primary p-3 rounded-r">
          <p className="text-xs mono text-primary mb-1 uppercase">// Top Event</p>
          <p className="text-sm">{data.topEvent}</p>
        </div>
      )}

      {data.confidenceScore !== undefined && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="mono">
            Confidence: {data.confidenceScore}%
          </Badge>
          <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${data.confidenceScore}%` }}
            />
          </div>
        </div>
      )}

      {data.fiveWhys && Array.isArray(data.fiveWhys) && (
        <div className="space-y-2">
          <p className="text-xs mono text-muted-foreground uppercase">// 5 Why Analysis</p>
          {data.fiveWhys.map((why: any, idx: number) => (
            <div key={idx} className="bg-secondary/50 border border-border rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="shrink-0 mono text-[10px]">
                  Why {why.level || idx + 1}
                </Badge>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{why.question}</p>
                  <p className="text-sm text-muted-foreground mt-1">{why.answer}</p>
                  {why.evidence && (
                    <p className="text-xs text-primary/80 mt-1 mono">// Evidence: {why.evidence}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data.fishbone && typeof data.fishbone === "object" && (
        <div className="space-y-2">
          <p className="text-xs mono text-muted-foreground uppercase">
            // Fishbone Categories (6M)
          </p>
          {Object.entries(data.fishbone).map(([category, causes]: [string, any]) => (
            <div key={category} className="bg-secondary/50 border border-border rounded-lg p-3">
              <p className="text-sm font-medium capitalize mb-2">{category}</p>
              {Array.isArray(causes) &&
                causes.map((cause: any, idx: number) => (
                  <div key={idx} className="text-sm ml-2 mb-1">
                    <span className="text-muted-foreground">• {cause.cause || cause}</span>
                    {cause.likelihood && (
                      <Badge
                        variant="outline"
                        className={`ml-2 text-[10px] ${
                          cause.likelihood === "High"
                            ? "bg-[color:var(--signal-crit)]/20 text-[color:var(--signal-crit)]"
                            : cause.likelihood === "Medium"
                              ? "bg-[color:var(--signal-warn)]/20 text-[color:var(--signal-warn)]"
                              : "bg-[color:var(--signal-ok)]/20 text-[color:var(--signal-ok)]"
                        }`}
                      >
                        {cause.likelihood}
                      </Badge>
                    )}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      {data.topCauses && Array.isArray(data.topCauses) && (
        <div className="space-y-2">
          <p className="text-xs mono text-muted-foreground uppercase">// Top Causes</p>
          {data.topCauses.map((tc: any, idx: number) => (
            <div key={idx} className="flex items-center gap-2 bg-secondary/50 rounded p-2">
              <Badge variant="outline" className="mono text-xs">
                #{tc.rank || idx + 1}
              </Badge>
              <span className="text-sm">{tc.cause}</span>
              {tc.confidence !== undefined && (
                <Badge variant="outline" className="mono text-[10px] ml-auto">
                  {tc.confidence}%
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {data.correctiveActions && Array.isArray(data.correctiveActions) && (
        <div className="space-y-1">
          <p className="text-xs mono text-[color:var(--signal-ok)] uppercase">
            // Corrective Actions
          </p>
          <ul className="list-disc list-inside text-sm space-y-1">
            {data.correctiveActions.map((action: string, idx: number) => (
              <li key={idx}>{action}</li>
            ))}
          </ul>
        </div>
      )}

      {data.preventiveActions && Array.isArray(data.preventiveActions) && (
        <div className="space-y-1">
          <p className="text-xs mono text-accent uppercase">// Preventive Actions</p>
          <ul className="list-disc list-inside text-sm space-y-1">
            {data.preventiveActions.map((action: string, idx: number) => (
              <li key={idx}>{action}</li>
            ))}
          </ul>
        </div>
      )}

      {data.timeline && typeof data.timeline === "object" && (
        <div className="space-y-2">
          <p className="text-xs mono text-muted-foreground uppercase">// Timeline</p>
          {data.timeline.phases &&
            data.timeline.phases.map((phase: any, idx: number) => (
              <div key={idx} className="bg-secondary/50 border border-border rounded p-2 text-xs">
                <span className="mono font-medium">{phase.phase}</span>
                <span className="text-muted-foreground ml-2">
                  ({phase.start} → {phase.end}, {phase.duration})
                </span>
              </div>
            ))}
        </div>
      )}

      {data.reliabilityMetrics && typeof data.reliabilityMetrics === "object" && (
        <div className="grid grid-cols-2 gap-2">
          <MetricCard
            label="MTBF"
            value={data.reliabilityMetrics.mtbf?.value || "—"}
            trend={data.reliabilityMetrics.mtbf?.trend}
          />
          <MetricCard
            label="MTTR"
            value={data.reliabilityMetrics.mttr?.value || "—"}
            trend={data.reliabilityMetrics.mttr?.trend}
          />
          <MetricCard
            label="Availability"
            value={data.reliabilityMetrics.availability?.value || "—"}
          />
          <MetricCard
            label="Failure Rate"
            value={data.reliabilityMetrics.failureRate?.value || "—"}
          />
        </div>
      )}

      {data.paretoAnalysis && typeof data.paretoAnalysis === "object" && (
        <div className="space-y-2">
          <p className="text-xs mono text-muted-foreground uppercase">// Pareto Analysis</p>
          {data.paretoAnalysis.byFailureMode &&
            data.paretoAnalysis.byFailureMode.map((item: any, idx: number) => (
              <div
                key={idx}
                className="flex items-center gap-2 bg-secondary/50 rounded p-2 text-xs"
              >
                <Badge variant="outline" className="mono">
                  #{item.rank}
                </Badge>
                <span className="flex-1">{item.mode}</span>
                <span className="mono">
                  {item.frequency}x ({item.percentage}%)
                </span>
              </div>
            ))}
          {data.paretoAnalysis.vitalFew && (
            <div className="bg-primary/10 border-l-2 border-primary p-2 rounded-r">
              <p className="text-xs mono text-primary">Vital Few</p>
              <p className="text-sm">{data.paretoAnalysis.vitalFew.join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {(keys.length <= 3 && !data.analysisType) ||
      (JSON.stringify(data).length > 2000 &&
        !data.fiveWhys &&
        !data.fishbone &&
        !data.topCauses &&
        !data.rootCause &&
        !data.correctiveActions &&
        !data.preventiveActions &&
        !data.reliabilityMetrics &&
        !data.paretoAnalysis &&
        !data.timeline) ? (
        <pre className="bg-secondary/50 rounded-lg p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function MetricCard({ label, value, trend }: { label: string; value: string; trend?: string }) {
  return (
    <div className="bg-secondary/50 border border-border rounded-lg p-2 text-center">
      <p className="text-[10px] mono text-muted-foreground uppercase">{label}</p>
      <p className="text-lg font-bold text-primary">{value}</p>
      {trend && <p className="text-[10px] text-muted-foreground">{trend}</p>}
    </div>
  );
}
