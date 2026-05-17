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
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/rca/$caseId")({
  component: () => <AuthGate><CasePage /></AuthGate>,
});

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
  const [attachments, setAttachments] = useState<Array<{ filename: string; contentType: string; data: string }>>([]);
  const [attachmentsPreview, setAttachmentsPreview] = useState<string[]>([]);
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [skippedAgents, setSkippedAgents] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAgent = AGENTS[agentStep];

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
        setCompletedAgents(prev => new Set([...prev, currentAgent?.key ?? ""]));
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
      return send({ data: { conversationId: cid, message: inputRef.current, attachments: attachmentsRef.current } });
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
      const last = msgsQDataRef.current?.messages?.filter((m: any) => m.role === "assistant").slice(-1)[0];
      const reportData = last?.raw_response
        ? (typeof last.raw_response === "string" ? (JSON.parse(last.raw_response) || {}) : last.raw_response)
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
    Array.from(files).forEach(file => {
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} exceeds 10MB limit`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = ev.target?.result as string;
        const base64 = result.split(",")[1] || result;
        setAttachments(prev => [...prev, { filename: file.name, contentType: file.type, data: base64 }]);
        setAttachmentsPreview(prev => [...prev, result]);
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
    setAttachmentsPreview(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const skipAgent = useCallback(() => {
    if (!currentAgent) return;
    setSkippedAgents(prev => new Set([...prev, currentAgent.key]));
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
  const isAllComplete = agentStep >= AGENTS.length - 1 && completedAgents.has(AGENTS[AGENTS.length - 1].key);
  const caseStatus = caseQ.data?.case.status;

  const renderMessageContent = (content: string, role: string) => {
    if (role === "assistant") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(content);
      } catch {}
      if (!parsed) {
        try {
          parsed = JSON.parse(content.replace(/\\/g, '').replace(/"text"/, '"text"'));
        } catch {}
      }
      if (parsed && typeof parsed === "object") {
        return (
          <AgentResponseRenderer data={parsed} />
        );
      }
      return <div className="text-sm whitespace-pre-wrap">{content}</div>;
    }
    return <div className="text-sm whitespace-pre-wrap">{content}</div>;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3 animate-fadeIn">
      {/* Agent Progress Bar */}
      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground mono uppercase">// RCA Analysis Pipeline</span>
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
                  <ArrowRight className={`w-3 h-3 mx-0.5 shrink-0 transition-colors ${
                    isComplete || idx < agentStep
                      ? "text-[color:var(--signal-ok)]/50"
                      : "text-muted-foreground/30"
                  }`} />
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
          <div className="panel-header"><span>// ACTIVE AGENT</span></div>
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
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={skipAgent}
              >
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

        {/* Chat Area */}
        <div className="panel flex flex-col overflow-hidden">
          <div className="panel-header">
            <span>// {caseQ.data?.case.title ?? "loading"} — {currentAgent?.name ?? "select agent"}</span>
            <span className="status-dot text-[color:var(--signal-ok)]" />
          </div>

          {/* Attachments Preview */}
          {attachmentsPreview.length > 0 && (
            <div className="px-4 py-2 border-b border-border flex gap-2 overflow-x-auto">
              {attachmentsPreview.map((preview, idx) => (
                <div key={idx} className="relative shrink-0 group">
                  <img src={preview} alt={attachments[idx]?.filename} className="w-16 h-16 object-cover rounded-lg border border-border" />
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
                  <p className="text-xs text-primary/60 mt-2">// You are at step {currentAgent?.order} of 8</p>
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
                  <div className={`max-w-[85%] rounded-xl px-4 py-3 transition-all duration-300 ${
                    m.role === "user"
                      ? "bg-primary/15 border border-primary/30 shadow-[0_0_20px_rgba(251,191,36,0.1)]"
                      : "bg-secondary/80 border border-border shadow-lg"
                  }`}>
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
                              onClick={() => window.open(`data:${a.contentType};base64,${a.data}`, "_blank")}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {m.role === "user"
                      ? renderMessageContent(m.content, m.role)
                      : renderMessageContent(m.content, m.role)
                    }
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
                    <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
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
                    <img src={preview} alt="" className="w-12 h-12 object-cover rounded-md border border-border" />
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
                disabled={!input.trim() && attachments.length === 0 || !convId || sendMut.isPending}
                className="shrink-0 mb-0.5"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentResponseRenderer({ data }: { data: Record<string, any> }) {
  if (!data || typeof data !== "object") {
    return <pre className="whitespace-pre-wrap">{typeof data === "string" ? data : JSON.stringify(data)}</pre>;
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
          <p className="text-xs mono text-[color:var(--signal-crit)] mb-1 uppercase">// Root Cause</p>
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
                <Badge variant="outline" className="shrink-0 mono text-[10px]">Why {why.level || idx + 1}</Badge>
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
          <p className="text-xs mono text-muted-foreground uppercase">// Fishbone Categories (6M)</p>
          {Object.entries(data.fishbone).map(([category, causes]: [string, any]) => (
            <div key={category} className="bg-secondary/50 border border-border rounded-lg p-3">
              <p className="text-sm font-medium capitalize mb-2">{category}</p>
              {Array.isArray(causes) && causes.map((cause: any, idx: number) => (
                <div key={idx} className="text-sm ml-2 mb-1">
                  <span className="text-muted-foreground">• {cause.cause || cause}</span>
                  {cause.likelihood && (
                    <Badge variant="outline" className={`ml-2 text-[10px] ${
                      cause.likelihood === "High" ? "bg-[color:var(--signal-crit)]/20 text-[color:var(--signal-crit)]" :
                      cause.likelihood === "Medium" ? "bg-[color:var(--signal-warn)]/20 text-[color:var(--signal-warn)]" :
                      "bg-[color:var(--signal-ok)]/20 text-[color:var(--signal-ok)]"
                    }`}>
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
              <Badge variant="outline" className="mono text-xs">#{tc.rank || idx + 1}</Badge>
              <span className="text-sm">{tc.cause}</span>
              {tc.confidence !== undefined && (
                <Badge variant="outline" className="mono text-[10px] ml-auto">{tc.confidence}%</Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {data.correctiveActions && Array.isArray(data.correctiveActions) && (
        <div className="space-y-1">
          <p className="text-xs mono text-[color:var(--signal-ok)] uppercase">// Corrective Actions</p>
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
          {data.timeline.phases && data.timeline.phases.map((phase: any, idx: number) => (
            <div key={idx} className="bg-secondary/50 border border-border rounded p-2 text-xs">
              <span className="mono font-medium">{phase.phase}</span>
              <span className="text-muted-foreground ml-2">({phase.start} → {phase.end}, {phase.duration})</span>
            </div>
          ))}
        </div>
      )}

      {data.reliabilityMetrics && typeof data.reliabilityMetrics === "object" && (
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="MTBF" value={data.reliabilityMetrics.mtbf?.value || "—"} trend={data.reliabilityMetrics.mtbf?.trend} />
          <MetricCard label="MTTR" value={data.reliabilityMetrics.mttr?.value || "—"} trend={data.reliabilityMetrics.mttr?.trend} />
          <MetricCard label="Availability" value={data.reliabilityMetrics.availability?.value || "—"} />
          <MetricCard label="Failure Rate" value={data.reliabilityMetrics.failureRate?.value || "—"} />
        </div>
      )}

      {data.paretoAnalysis && typeof data.paretoAnalysis === "object" && (
        <div className="space-y-2">
          <p className="text-xs mono text-muted-foreground uppercase">// Pareto Analysis</p>
          {data.paretoAnalysis.byFailureMode && data.paretoAnalysis.byFailureMode.map((item: any, idx: number) => (
            <div key={idx} className="flex items-center gap-2 bg-secondary/50 rounded p-2 text-xs">
              <Badge variant="outline" className="mono">#{item.rank}</Badge>
              <span className="flex-1">{item.mode}</span>
              <span className="mono">{item.frequency}x ({item.percentage}%)</span>
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

      {(keys.length <= 3 && !data.analysisType) || (
        JSON.stringify(data).length > 2000 &&
        !data.fiveWhys && !data.fishbone && !data.topCauses && !data.rootCause &&
        !data.correctiveActions && !data.preventiveActions && !data.reliabilityMetrics && !data.paretoAnalysis && !data.timeline
      ) ? (
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
