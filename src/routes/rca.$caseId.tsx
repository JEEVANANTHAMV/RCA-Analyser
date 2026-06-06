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
  updateAssistantMessage,
  clearConversationMessages,
  runFullAutomation,
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
  ChevronLeft,
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
  Lock,
  Unlock,
  Trash2,
  Plus,
  Download,
  TrendingUp,
  Clock,
  Zap,
  Edit,
} from "lucide-react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Legend,
} from "recharts";
import { toast } from "sonner";


export const Route = createFileRoute("/rca/$caseId")({
  component: () => (
    <AuthGate>
      <CasePage />
    </AuthGate>
  ),
});

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

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

function parseMaybeJson(str: string): any {
  if (!str) return null;
  let cleaned = str.trim();
  
  // Extract JSON block if it's inside markdown code blocks
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = cleaned.match(jsonBlockRegex);
  if (match && match[1]) {
    cleaned = match[1].trim();
  }

  // Find first { or [ and last } or ]
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  let endToken = "";
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endToken = "}";
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endToken = "]";
  }

  if (startIdx !== -1) {
    const lastIdx = cleaned.lastIndexOf(endToken);
    if (lastIdx > startIdx) {
      cleaned = cleaned.substring(startIdx, lastIdx + 1);
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  // Fallback to parsePartialJson
  try {
    return parsePartialJson(cleaned);
  } catch {}

  return null;
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
  const fiveWhyScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAgent = AGENTS[agentStep];

  const [showChat, setShowChat] = useState(false);

  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [editProblemStatement, setEditProblemStatement] = useState("");
  const [editEffect, setEditEffect] = useState("");
  const [editGaps, setEditGaps] = useState("");
  const [editFollowUps, setEditFollowUps] = useState("");
  const [lastLoadedConvoId, setLastLoadedConvoId] = useState<string | null>(null);

  // Agent-specific state declarations
  const [editLocked, setEditLocked] = useState(false);
  const [editEquipmentName, setEditEquipmentName] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editOperatingConditions, setEditOperatingConditions] = useState("");
  const [editTimestamp, setEditTimestamp] = useState("");
  const [editWitnessedSymptoms, setEditWitnessedSymptoms] = useState("");
  const [editMaintenanceHistoryChecked, setEditMaintenanceHistoryChecked] = useState(false);

  // 5 Why States
  const [fiveWhys, setFiveWhys] = useState<any[]>([]);

  // Fishbone States
  const [fishboneCategories, setFishboneCategories] = useState<Record<string, any[]>>({});
  const [customCategories, setCustomCategories] = useState<string[]>([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [viewingPastFishboneStep, setViewingPastFishboneStep] = useState<number | null>(null);
  const [fishboneStep, setFishboneStep] = useState<{
    step: number;
    type: "problem_confirm" | "initial_categories" | "drill_down" | "scoring_review" | "final";
    data: any;
  } | null>(null);
  const [fishboneHistory, setFishboneHistory] = useState<Array<{
    step: number;
    type: string;
    aiData: any;
    operatorResponse: string;
  }>>([]);
  const [selectedFishboneAnswer, setSelectedFishboneAnswer] = useState("");
  const [drillingCategory, setDrillingCategory] = useState<string | null>(null);
  const [showInteractiveGuideOverride, setShowInteractiveGuideOverride] = useState(false);

  // Fault Tree States
  const [faultTree, setFaultTree] = useState<any>(null);
  const [selectedFTAEvent, setSelectedFTAEvent] = useState<any>(null);

  // Pareto States
  const [paretoThreshold, setParetoThreshold] = useState(80);
  const [paretoMode, setParetoMode] = useState<"cluster" | "trend">("cluster");

  // Timeline States
  const [timelineEvents, setTimelineEvents] = useState<any[]>([]);
  const [showAddPhaseModal, setShowAddPhaseModal] = useState(false);
  const [newPhaseName, setNewPhaseName] = useState("");
  const [newPhaseStart, setNewPhaseStart] = useState("");
  const [newPhaseDuration, setNewPhaseDuration] = useState("");
  const [newPhaseDesc, setNewPhaseDesc] = useState("");

  const [equipmentRPN, setEquipmentRPN] = useState<Record<string, number>>({ probe: 25, valve: 75, controller: 45 });

  // Report/CAPA States
  const [reportApproved, setReportApproved] = useState(false);
  const [capaActions, setCapaActions] = useState<any[]>([
    { id: "capa-1", desc: "Check safety lock constraints and verify manual controls are overridden.", owner: "Jane Doe (Maint)", date: "2026-05-25", status: "In Progress" },
    { id: "capa-2", desc: "Establish periodic inspection intervals for sensor suites and safety valves.", owner: "John Smith (Ops)", date: "2026-06-01", status: "Pending" }
  ]);
  const [capaChecklist, setCapaChecklist] = useState<Record<string, boolean>>({
    rootCauseMapped: false,
    capaFeasible: false,
    redundancyMet: false
  });
  const [editRootCauseText, setEditRootCauseText] = useState("");
  const [streamingChatText, setStreamingChatText] = useState<string | null>(null);
  const [agentParsedData, setAgentParsedData] = useState<Record<string, any>>({});
  const [selectedCauseId, setSelectedCauseId] = useState<string>("");
  const [customCauseText, setCustomCauseText] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);

  // Automation state
  const [showAutoModal, setShowAutoModal] = useState(false);
  const [autoProgress, setAutoProgress] = useState<Array<{
    type: string; agent?: string; name?: string; step?: number; message?: string;
  }>>([]);
  const [autoRunning, setAutoRunning] = useState(false);

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
    mutationFn: async (overrideData?: { locked?: boolean }) => {
      const gapsArr = editGaps.split("\n").map(line => line.trim()).filter(Boolean);
      const followUpsArr = editFollowUps.split("\n").map(line => line.trim()).filter(Boolean);
      const lockedVal = overrideData && overrideData.locked !== undefined ? overrideData.locked : editLocked;
      return saveCaseIncidentFn({
        data: {
          caseId,
          problemStatement: editProblemStatement,
          effect: editEffect,
          gaps: gapsArr,
          followUps: followUpsArr,
          locked: lockedVal,
          equipmentName: editEquipmentName,
          location: editLocation,
          operatingConditions: editOperatingConditions,
          timestamp: editTimestamp,
          witnessedSymptoms: editWitnessedSymptoms,
          maintenanceHistoryChecked: editMaintenanceHistoryChecked,
        }
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["msgs", convIdRef.current] });
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      setIsDirty(false);
      toast.success("Incident problem details saved and validated!");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to save details");
    }
  });

  const updateAssistantMessageFn = useServerFn(updateAssistantMessage);
  const updateAgentMsgMut = useMutation({
    mutationFn: async (updatedPayload: any) => {
      const msg = messages.filter((m: any) => m.role === "assistant").slice(-1)[0];
      if (!msg) throw new Error("No agent message found to update");
      return updateAssistantMessageFn({
        data: {
          conversationId: convId!,
          messageId: msg.id,
          content: JSON.stringify(updatedPayload, null, 2),
        }
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["msgs", convId] });
      setIsDirty(false);
      toast.success("Edits saved and updated in active findings!");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to save edits");
    }
  });

  const saveInteractiveStepMut = useMutation({
    mutationFn: async (updatedPayload: any) => {
      const msg = messages.filter((m: any) => m.role === "assistant").slice(-1)[0];
      if (!msg) throw new Error("No agent message found to update");
      return updateAssistantMessageFn({
        data: {
          conversationId: convId!,
          messageId: msg.id,
          content: JSON.stringify(updatedPayload, null, 2),
        }
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["msgs", convId] });
      setIsDirty(false);
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to auto-save status");
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
    if (caseQ.data?.conversations) {
      const completed = new Set<string>();
      caseQ.data.conversations.forEach((c) => {
        if ((c as any).message_count > 0) {
          completed.add(c.agent_key);
        }
      });
      setCompletedAgents((prev) => {
        const next = new Set([...prev]);
        let changed = false;
        completed.forEach((k) => {
          if (!next.has(k)) {
            next.add(k);
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }
  }, [caseQ.data?.conversations]);

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
    mutationFn: async (customMsg?: string) => {
      const cid = convIdRef.current;
      if (!cid) throw new Error("No conversation selected");
      setStreamingChatText("");
      const res = await send({
        data: {
          conversationId: cid,
          message: customMsg !== undefined ? customMsg : inputRef.current,
          attachments: attachmentsRef.current,
        },
      });
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
        setStreamingChatText(accumulated);
      }
      return accumulated;
    },
    onSuccess: () => {
      setInput("");
      setAttachments([]);
      setAttachmentsPreview([]);
      setStreamingChatText(null);
      qc.invalidateQueries({ queryKey: ["msgs", convIdRef.current] });
    },
    onError: (err) => {
      setStreamingChatText(null);
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

  const clearChatFn = useServerFn(clearConversationMessages);
  const clearChatMut = useMutation({
    mutationFn: async () => {
      const cid = convIdRef.current;
      if (!cid) throw new Error("No conversation active");
      return clearChatFn({ data: { conversationId: cid } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["msgs", convIdRef.current] });
      toast.success("Chat history cleared!");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to clear chat history");
    }
  });

  const runAutoFn = useServerFn(runFullAutomation);
  const autoMut = useMutation({
    mutationFn: async () => {
      setAutoProgress([]);
      setAutoRunning(true);
      const res = await runAutoFn({ data: { caseId } });
      if (!(res instanceof Response)) return res;
      if (!res.ok) throw new Error(await res.text() || "Automation failed");
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            setAutoProgress((prev) => [...prev, event]);
          } catch {}
        }
      }
    },
    onSuccess: () => {
      setAutoRunning(false);
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      qc.invalidateQueries({ queryKey: ["conv", caseId] });
      qc.invalidateQueries({ queryKey: ["msgs"] });
      toast.success("Full RCA automation complete!");
    },
    onError: (err: any) => {
      setAutoRunning(false);
      toast.error(err.message || "Automation failed");
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
    if (isDirty) {
      const confirmLeave = window.confirm(
        "You have unsaved changes in this agent workspace. If you switch agents now, your unsaved progress will be lost. Are you sure you want to proceed?"
      );
      if (!confirmLeave) return;
    }
    setAgentStep(step);
    setIsDirty(false);
  }, [isDirty]);

  const messages = msgsQ.data?.messages ?? [];
  const isAllComplete =
    agentStep >= AGENTS.length - 1 && completedAgents.has(AGENTS[AGENTS.length - 1].key);
  const caseStatus = caseQ.data?.case.status;

  const latestAssistantMsg = messages
    .filter((m: any) => m.role === "assistant")
    .slice(-1)[0];

  // Persistent JSON streaming parsing state to prevent UI disappearing/flickering
  useEffect(() => {
    if (!currentAgent) return;
    let nextParsed: any = null;
    if (streamingText !== null) {
      nextParsed = parseMaybeJson(streamingText);
    } else if (latestAssistantMsg) {
      nextParsed = parseMaybeJson(latestAssistantMsg.content);
      if (!nextParsed && latestAssistantMsg.raw_response) {
        try {
          nextParsed = typeof latestAssistantMsg.raw_response === "string"
            ? parseMaybeJson(latestAssistantMsg.raw_response)
            : latestAssistantMsg.raw_response;
        } catch {}
      }
    }

    if (nextParsed && typeof nextParsed === "object") {
      setAgentParsedData((prev) => {
        const current = prev[currentAgent.key];
        if (JSON.stringify(current) === JSON.stringify(nextParsed)) {
          return prev;
        }
        return {
          ...prev,
          [currentAgent.key]: nextParsed,
        };
      });
    }
  }, [streamingText, latestAssistantMsg, currentAgent?.key]);

  // Derive current parsed data with state lookup and immediate parse fallback
  let immediateParsed: any = null;
  const isStreaming = streamingText !== null;
  if (isStreaming) {
    immediateParsed = parseMaybeJson(streamingText);
  } else if (latestAssistantMsg) {
    immediateParsed = parseMaybeJson(latestAssistantMsg.content);
    if (!immediateParsed && latestAssistantMsg.raw_response) {
      try {
        immediateParsed = typeof latestAssistantMsg.raw_response === "string"
          ? parseMaybeJson(latestAssistantMsg.raw_response)
          : latestAssistantMsg.raw_response;
      } catch {}
    }
  }

  const parsedData = currentAgent
    ? (agentParsedData[currentAgent.key] || (immediateParsed && typeof immediateParsed === "object" ? immediateParsed : null))
    : null;

  // Auto scroll 5 Why investigation workspace when new questions stream or are added
  const stepsCount = messages.filter((m: any) => m.role === "assistant").length;
  useEffect(() => {
    if (fiveWhyScrollRef.current) {
      fiveWhyScrollRef.current.scrollTo({
        top: fiveWhyScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [stepsCount, streamingText, streamingChatText, currentAgent?.key]);

  // Synchronize dynamic operational state from database and AI outputs
  // Synchronize data collector fields once when conversation changes
  useEffect(() => {
    if (convId && currentAgent?.key === "data_collector") {
      let problem = "";
      let effect = "";
      let gapsStr = "";
      let followUpsStr = "";
      let lockedVal = false;
      let equip = "";
      let loc = "";
      let opCond = "";
      let tstamp = "";
      let symptoms = "";
      let maintChecked = false;

      // First try to load from database case record incident_data
      if (caseQ.data?.case.incident_data) {
        try {
          const parsedInc = JSON.parse(caseQ.data.case.incident_data);
          if (parsedInc) {
            problem = parsedInc.problemStatement || "";
            effect = parsedInc.effect || "";
            gapsStr = Array.isArray(parsedInc.gaps) ? parsedInc.gaps.join("\n") : "";
            followUpsStr = Array.isArray(parsedInc.followUps) ? parsedInc.followUps.join("\n") : "";
            lockedVal = !!parsedInc.locked;
            equip = parsedInc.equipmentName || "";
            loc = parsedInc.location || "";
            opCond = parsedInc.operatingConditions || "";
            tstamp = parsedInc.timestamp || "";
            symptoms = parsedInc.witnessedSymptoms || "";
            maintChecked = !!parsedInc.maintenanceHistoryChecked;
          }
        } catch {}
      }

      // If fields are empty, fallback to parsedData from AI response
      if (!problem && parsedData) {
        problem = parsedData.problemStatement || "";
        effect = parsedData.effect || parsedData.effectImpact || "";
        gapsStr = Array.isArray(parsedData.gaps) ? parsedData.gaps.join("\n") : "";
        followUpsStr = Array.isArray(parsedData.followUps) ? parsedData.followUps.join("\n") : "";
        
        const context = parsedData.operationalContext || {};
        equip = parsedData.equipmentName || context.equipmentName || "";
        loc = parsedData.location || context.location || "";
        opCond = parsedData.operatingConditions || context.operatingConditions || "";
        tstamp = parsedData.timestamp || context.timestamp || "";
        symptoms = parsedData.witnessedSymptoms || context.witnessedSymptoms || "";
      }

      // If still empty (meaning no AI response and no operator entry yet), fallback to description
      if (!problem && caseQ.data?.case.incident_data) {
        try {
          const parsedInc = JSON.parse(caseQ.data.case.incident_data);
          problem = parsedInc.description || "";
        } catch {}
      }

      setEditProblemStatement(problem);
      setEditEffect(effect);
      setEditGaps(gapsStr);
      setEditFollowUps(followUpsStr);
      setEditLocked(lockedVal);
      setEditEquipmentName(equip);
      setEditLocation(loc);
      setEditOperatingConditions(opCond);
      setEditTimestamp(tstamp);
      setEditWitnessedSymptoms(symptoms);
      setEditMaintenanceHistoryChecked(maintChecked);
    }
  }, [convId, caseQ.data?.case.incident_data]);

  // Synchronize state reactively for all other agents when messages / parsedData changes
  useEffect(() => {
    if (!convId || currentAgent?.key === "data_collector") return;

    if (currentAgent?.key === "five_why") {
      const intSteps: any[] = [];
      const startIdx = findLastIndex(
        messages,
        (m: any) => m.role === "user" && m.content.includes("START FRESH 5 WHY ANALYSIS")
      );

      if (startIdx !== -1) {
        const sessionMsgs = messages.slice(startIdx);
        for (let i = 0; i < sessionMsgs.length; i++) {
          const m = sessionMsgs[i];
          if (m.role === "assistant") {
            try {
              const parsed = parseMaybeJson(m.content);
              if (parsed && (parsed.question || parsed.whyStep)) {
                let selected = "";
                const nextMsg = sessionMsgs[i + 1];
                if (nextMsg && nextMsg.role === "user") {
                  selected = nextMsg.content;
                }
                intSteps.push({
                  stepNumber: parsed.whyStep ? (parsed.whyStep - 1) : (intSteps.length + 1),
                  question: parsed.question || "",
                  possibleCauses: parsed.possibleCauses || [],
                  selectedAnswer: selected,
                });
              }
            } catch {}
          }
        }
      }

      const mappedSteps = intSteps.map((s, idx) => {
        let displayAns = s.selectedAnswer;
        if (displayAns.startsWith("I select cause-")) {
          displayAns = displayAns.substring(displayAns.indexOf(":") + 1).trim();
        } else if (displayAns.startsWith("I select the ")) {
          displayAns = displayAns.substring(13).trim();
          if (displayAns.endsWith(".")) {
            displayAns = displayAns.substring(0, displayAns.length - 1);
          }
        } else if (displayAns.startsWith("I select ")) {
          displayAns = displayAns.substring(9).trim();
        }
        
        return {
          id: `why-${s.stepNumber}`,
          parentId: s.stepNumber > 1 ? `why-${s.stepNumber - 1}` : null,
          question: s.question,
          answer: displayAns || "Awaiting operator input...",
          evidence: "",
          confidence: "High",
          isValidRootCause: idx === intSteps.length - 1 && displayAns && displayAns !== "Awaiting operator input..." && s.possibleCauses.length === 0,
        };
      });

      const currentJson = JSON.stringify(fiveWhys);
      const nextJson = JSON.stringify(mappedSteps);
      if (currentJson !== nextJson) {
        setFiveWhys(mappedSteps);
      }
    } else if (parsedData) {
      if (currentAgent?.key === "fishbone") {
        const parsedSteps: Array<{
          step: number;
          type: string;
          aiData: any;
          operatorResponse: string;
        }> = [];
        let lastAiStep: any = null;

        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (m.role === "assistant") {
            try {
              const parsed = parseMaybeJson(m.content);
              if (parsed && parsed.step) {
                let userResp = "";
                const nextMsg = messages[i + 1];
                if (nextMsg && nextMsg.role === "user") {
                  userResp = nextMsg.content;
                }
                parsedSteps.push({
                  step: parsed.step,
                  type: parsed.type || "",
                  aiData: parsed,
                  operatorResponse: userResp,
                });
                lastAiStep = {
                  step: parsed.step,
                  type: parsed.type || "",
                  data: parsed,
                };
              }
            } catch {}
          }
        }

        const currentHistJson = JSON.stringify(fishboneHistory);
        const nextHistJson = JSON.stringify(parsedSteps);
        if (currentHistJson !== nextHistJson) {
          setFishboneHistory(parsedSteps);
        }

        const currentStepJson = JSON.stringify(fishboneStep);
        const nextStepJson = JSON.stringify(lastAiStep);
        if (currentStepJson !== nextStepJson) {
          setFishboneStep(lastAiStep);
        }

        if (lastAiStep && (lastAiStep.step === 10 || lastAiStep.type === "final") && lastAiStep.data.fishbone) {
          const currentCatsJson = JSON.stringify(fishboneCategories);
          const nextCatsJson = JSON.stringify(lastAiStep.data.fishbone);
          if (currentCatsJson !== nextCatsJson) {
            setFishboneCategories(lastAiStep.data.fishbone);
          }
        }
      } else if (currentAgent?.key === "fault_tree") {
        let treeData = parsedData;
        if (parsedData.faultTreeAnalysis?.tree) {
          treeData = { ...parsedData.faultTreeAnalysis, tree: parsedData.faultTreeAnalysis.tree };
        } else if (parsedData.faultTreeAnalysis?.topEvent || parsedData.faultTreeAnalysis?.branches) {
          treeData = parsedData.faultTreeAnalysis;
        }
        if (treeData.tree) {
          setFaultTree(treeData.tree);
        } else {
          const tree = {
            id: "top-event",
            label: treeData.topEvent || "Incident Failure Event",
            type: "gate",
            gateType: treeData.gateType || "OR",
            probability: treeData.topProbability || 1.0,
            children: [],
          };
          if (Array.isArray(treeData.branches)) {
            tree.children = treeData.branches.map((b: any, bi: number) => ({
              id: `branch-${bi}`,
              label: b.label || b.description || "Sub-failure",
              type: "gate",
              gateType: b.gateType || "OR",
              probability: b.probability || 0.3,
              children: Array.isArray(b.causes)
                ? b.causes.map((c: string, ci: number) => ({
                    id: `cause-${bi}-${ci}`,
                    label: c,
                    type: "event",
                    probability: 0.1,
                  }))
                : [],
            }));
          }
          setFaultTree(tree);
        }
       } else if (currentAgent?.key === "timeline") {
        let timelineData = parsedData;
        let phases = [];

        if (parsedData.timeline?.phases && Array.isArray(parsedData.timeline.phases)) {
          phases = parsedData.timeline.phases;
        } else if (parsedData.timelineAnalysis?.timeline?.phases) {
          timelineData = { timeline: parsedData.timelineAnalysis.timeline };
          phases = parsedData.timelineAnalysis.timeline.phases;
        } else if (parsedData.timelineAnalysis?.phases) {
          timelineData = { timeline: { phases: parsedData.timelineAnalysis.phases } };
          phases = parsedData.timelineAnalysis.phases;
        } else if (parsedData.timelineAndEventCorrelation) {
          // Actual AI format: {"timelineAndEventCorrelation": {"phases": [...]}}
          const tec = parsedData.timelineAndEventCorrelation;
          if (tec.phases && Array.isArray(tec.phases)) {
            phases = tec.phases;
          } else if (tec.timeline?.phases && Array.isArray(tec.timeline.phases)) {
            phases = tec.timeline.phases;
          } else {
            // Try to extract phases from any nested structure
            for (const key of Object.keys(tec)) {
              if (Array.isArray(tec[key]) && tec[key].length > 0 && tec[key][0]?.phase) {
                phases = tec[key];
                break;
              }
            }
          }
          if (phases.length > 0) {
            timelineData = { timeline: { phases } };
          }
        }

        if (phases.length > 0) {
          setTimelineEvents(phases);
        } else if (timelineData.timeline && Array.isArray(timelineData.timeline.phases)) {
          setTimelineEvents(timelineData.timeline.phases);
        }
       } else if (currentAgent?.key === "pareto") {
        let paretoData = parsedData;
        if (parsedData.paretoAnalysis?.byFailureMode) {
          // Standard format
        } else if (parsedData.paretoAnalysisResult?.paretoAnalysis) {
          paretoData = { ...parsedData, paretoAnalysis: parsedData.paretoAnalysisResult.paretoAnalysis };
        } else if (parsedData.paretoAndTrendAnalysis) {
          // Actual AI response format: {"paretoAndTrendAnalysis": {"paretoAnalysis": {"byFailureType": {"categories": [...]}}}}
          const pta = parsedData.paretoAndTrendAnalysis;
          let byFailureMode = [];
          if (pta.paretoAnalysis?.byFailureType?.categories && Array.isArray(pta.paretoAnalysis.byFailureType.categories)) {
            byFailureMode = pta.paretoAnalysis.byFailureType.categories.map((c: any) => ({
              mode: c.name || c.label || c.category || c.mode || "Unknown",
              frequency: c.frequency || c.count || c.value || 0,
            }));
          } else if (pta.paretoAnalysis?.byFailureMode && Array.isArray(pta.paretoAnalysis.byFailureMode)) {
            byFailureMode = pta.paretoAnalysis.byFailureMode;
          }
          if (byFailureMode.length > 0) {
            paretoData = { ...parsedData, paretoAnalysis: { byFailureMode } };
          }
        }
      } else if (currentAgent?.key === "equipment") {
        let equipData = parsedData;
        if (parsedData.equipmentAnalysis?.reliabilityMetrics) {
          equipData = { reliabilityMetrics: parsedData.equipmentAnalysis.reliabilityMetrics };
        } else if (parsedData.equipmentAnalysis?.rpnScores) {
          equipData = { reliabilityMetrics: { rpnScores: parsedData.equipmentAnalysis.rpnScores } };
        }
        if (equipData.reliabilityMetrics?.rpnScores) {
          setEquipmentRPN(equipData.reliabilityMetrics.rpnScores);
        }
       } else if (currentAgent?.key === "report") {
        let reportData: any = parsedData;
        if (parsedData.rootCause || parsedData.correctiveActionsList) {
          // Standard format already
        } else if (parsedData.reportAnalysis && (parsedData.reportAnalysis.rootCause || parsedData.reportAnalysis.correctiveActionsList)) {
          reportData = parsedData.reportAnalysis;
        } else if (parsedData.rcaReport) {
          // Actual AI format: {"rcaReport": {"rootCause": ..., "correctiveActionsList": [...]}}
          reportData = parsedData.rcaReport;
          // Also handle nested CAPA key names the AI might use
          if (reportData.capaPlan) {
            reportData.correctiveActionsList = reportData.capaPlan.correctiveActions || reportData.capaPlan.actions || reportData.correctiveActionsList;
            reportData.preventiveActions = reportData.capaPlan.preventiveActions || reportData.preventiveActions;
          }
        } else if (parsedData.reportAnalysis) {
          reportData = parsedData.reportAnalysis;
        }
        if (reportData.rootCause) {
          setEditRootCauseText(reportData.rootCause);
        }
        if (Array.isArray(reportData.correctiveActionsList)) {
          setCapaActions(reportData.correctiveActionsList);
        } else {
          const combined: any[] = [];
          if (Array.isArray(reportData.correctiveActions)) {
            reportData.correctiveActions.forEach((a: string, i: number) => {
              combined.push({ id: `ca-${i}`, desc: a, owner: "Operator", date: "2026-06-01", status: "Pending" });
            });
          }
          if (Array.isArray(reportData.preventiveActions)) {
            reportData.preventiveActions.forEach((a: string, i: number) => {
              combined.push({ id: `pa-${i}`, desc: a, owner: "Plant Manager", date: "2026-06-15", status: "Pending" });
            });
          }
          if (combined.length > 0) {
            setCapaActions(combined);
          }
        }
        if (reportData.checklist) {
          setCapaChecklist(reportData.checklist);
        }
      }
    }
  }, [parsedData, messages, currentAgent?.key, convId]);

  const renderMessageContent = (content: string, role: string) => {
    if (role === "assistant") {
      const parsed = parseMaybeJson(content);
      if (parsed && typeof parsed === "object") {
        return <AgentResponseRenderer data={parsed} />;
      }
      
      // If it looks like JSON but hasn't parsed successfully yet (e.g. streaming), show a premium loading indicator
      const trimmed = content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return (
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono italic p-1 animate-pulse">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
            Synthesizing workspace UI components...
          </div>
        );
      }
      return <div className="text-sm whitespace-pre-wrap">{content}</div>;
    }
    return <div className="text-sm whitespace-pre-wrap">{content}</div>;
  };

  const calculateCompleteness = () => {
    let score = 0;
    if (editProblemStatement.trim()) score += 20;
    if (editEffect.trim()) score += 20;
    if (editGaps.trim()) score += 10;
    if (editFollowUps.trim()) score += 10;
    
    if (editEquipmentName.trim()) score += 8;
    if (editLocation.trim()) score += 8;
    if (editOperatingConditions.trim()) score += 8;
    if (editTimestamp.trim()) score += 8;
    if (editWitnessedSymptoms.trim()) score += 8;

    return Math.min(100, score);
  };

  // Shared iterative Q&A panel for all downstream agents
  const renderIterativePanel = (placeholder: string) => {
    const isStreamingReply = streamingChatText !== null || sendMut.isPending;
    return (
      <div className="bg-secondary/15 border border-border/50 border-t-0 rounded-b-xl p-4 space-y-3">
        <div className="flex items-center gap-2 pb-2 border-b border-border/30">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-ping shrink-0" />
          <span className="text-[10px] text-primary font-bold mono uppercase tracking-wider">// ASK THE AGENT — Iterative Refinement</span>
        </div>
        {isStreamingReply && (
          <div className="bg-background/60 border border-border/40 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              <span className="text-[10px] text-primary font-mono font-bold">{currentAgent?.shortName} responding...</span>
            </div>
            {streamingChatText && (
              <div className="mt-2 border-t border-border/20 pt-2">
                {renderMessageContent(streamingChatText, "assistant")}
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            rows={2}
            disabled={isStreamingReply}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && convId) sendMut.mutate(input.trim());
              }
            }}
            className="resize-none flex-1 text-xs font-mono bg-background/60 border-border/50 focus:border-primary/50"
          />
          <Button
            onClick={() => { if (input.trim() && convId) sendMut.mutate(input.trim()); }}
            disabled={!input.trim() || !convId || isStreamingReply}
            className="shrink-0 mb-0.5 px-3"
            size="sm"
          >
            {isStreamingReply ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>
    );
  };

  const renderVisualWorkspace = () => {
    if (!currentAgent) return null;

    // Fishbone is always interactive — it handles its own initial state
    const isFishboneAgent = currentAgent.key === "fishbone";

    if ((isStreaming || hypothesisMut.isPending) && currentAgent.key !== "five_why" && !isFishboneAgent) {
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

    if (!parsedData && !isFishboneAgent) {
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
        let caseAttachments: { filename: string; contentType: string; url: string }[] = [];
        if (caseQ.data?.case.incident_data) {
          try {
            const parsed = JSON.parse(caseQ.data.case.incident_data);
            caseAttachments = parsed.attachments || [];
          } catch {}
        }

        const completeness = calculateCompleteness();

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${editLocked ? "bg-red-500" : "bg-emerald-500 animate-ping"}`} />
                <h3 className="font-bold text-lg mono uppercase">// Data Collector & Validator</h3>
              </div>
              <Badge className={editLocked ? "bg-red-500/20 text-red-400 border-red-500/40" : "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"}>
                {editLocked ? "STATUS: APPROVED & LOCKED" : "STATUS: DRAFT (EDITABLE)"}
              </Badge>
            </div>

            {/* Completeness Score Bar */}
            <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-2">
              <div className="flex justify-between items-center text-xs mono">
                <span>DATA COMPLETENESS INDEX</span>
                <span className="font-bold text-primary">{completeness}%</span>
              </div>
              <div className="h-2.5 bg-background border border-border/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all duration-500"
                  style={{ width: `${completeness}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Ensure all required fields, including structured telemetry checklist details, are filled before locking the case input.
              </p>
            </div>

            {/* Actions Bar */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-secondary/25 p-4 border border-border/50 rounded-lg gap-3">
              <div>
                <p className="text-sm font-semibold">Verify AI Problem Statement & Telemetry</p>
                <p className="text-xs text-muted-foreground">Adjust findings below to lock in the canonical facts for downstream steps.</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant={editLocked ? "destructive" : "default"}
                  onClick={() => {
                    const nextLock = !editLocked;
                    setEditLocked(nextLock);
                    saveCollectorMut.mutate({ locked: nextLock });
                  }}
                  disabled={saveCollectorMut.isPending}
                >
                  {editLocked ? (
                    <>
                      <Unlock className="w-3.5 h-3.5 mr-1.5" />
                      Unlock Findings
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5 mr-1.5" />
                      Approve & Lock
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveCollectorMut.mutate({})}
                  disabled={editLocked || saveCollectorMut.isPending}
                >
                  {saveCollectorMut.isPending ? "Saving..." : "Save Draft"}
                </Button>
              </div>
            </div>

            {/* Structured Telemetry Checklist */}
            <div className="bg-secondary/15 border border-border/40 rounded-xl p-5 space-y-4">
              <span className="text-xs text-primary font-bold mono tracking-wider block">// STRUCTURED OPERATIONAL CHECKLIST</span>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-mono">EQUIPMENT TAG / NAME</label>
                  <input
                    type="text"
                    disabled={editLocked}
                    value={editEquipmentName}
                    onChange={(e) => { setEditEquipmentName(e.target.value); setIsDirty(true); }}
                    placeholder="e.g. V-102 Safety Valve"
                    className="w-full text-xs font-mono p-2 bg-background border border-border rounded"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-mono">LOCATION / PROCESS UNIT</label>
                  <input
                    type="text"
                    disabled={editLocked}
                    value={editLocation}
                    onChange={(e) => { setEditLocation(e.target.value); setIsDirty(true); }}
                    placeholder="e.g. Unit 3 Crude Distillation"
                    className="w-full text-xs font-mono p-2 bg-background border border-border rounded"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-mono">OPERATING CONDITIONS AT FAILURE</label>
                  <input
                    type="text"
                    disabled={editLocked}
                    value={editOperatingConditions}
                    onChange={(e) => { setEditOperatingConditions(e.target.value); setIsDirty(true); }}
                    placeholder="e.g. 150°C, 12 bar pressure"
                    className="w-full text-xs font-mono p-2 bg-background border border-border rounded"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-mono">FAILURE TIMESTAMPS</label>
                  <input
                    type="text"
                    disabled={editLocked}
                    value={editTimestamp}
                    onChange={(e) => { setEditTimestamp(e.target.value); setIsDirty(true); }}
                    placeholder="e.g. 2026-05-21 21:59:00 UTC"
                    className="w-full text-xs font-mono p-2 bg-background border border-border rounded"
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-[10px] text-muted-foreground font-mono">WITNESSED SYMPTOMS / TELEX LOGS</label>
                  <input
                    type="text"
                    disabled={editLocked}
                    value={editWitnessedSymptoms}
                    onChange={(e) => { setEditWitnessedSymptoms(e.target.value); setIsDirty(true); }}
                    placeholder="e.g. Rapid pressure spikes followed by acoustic vibration and relief valve trip"
                    className="w-full text-xs font-mono p-2 bg-background border border-border rounded"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-border/30">
                <input
                  type="checkbox"
                  id="maint-chk"
                  disabled={editLocked}
                  checked={editMaintenanceHistoryChecked}
                  onChange={(e) => { setEditMaintenanceHistoryChecked(e.target.checked); setIsDirty(true); }}
                  className="rounded border-border bg-background text-primary focus:ring-primary"
                />
                <label htmlFor="maint-chk" className="text-xs text-muted-foreground font-mono cursor-pointer select-none">
                  Verify that maintenance logs and design sheets have been reviewed for anomalies
                </label>
              </div>
            </div>

            {/* Problem Statement & Impact */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-muted-foreground mono">// PROBLEM STATEMENT</p>
                <Textarea
                  disabled={editLocked}
                  value={editProblemStatement}
                  onChange={(e) => { setEditProblemStatement(e.target.value); setIsDirty(true); }}
                  className="font-semibold text-sm bg-background/50 font-sans border-border/50 focus:border-primary/50"
                  rows={4}
                  placeholder="Enter problem statement..."
                />
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-muted-foreground mono">// INCIDENT EFFECT / IMPACT</p>
                <Textarea
                  disabled={editLocked}
                  value={editEffect}
                  onChange={(e) => { setEditEffect(e.target.value); setIsDirty(true); }}
                  className="font-semibold text-sm text-destructive bg-background/50 font-sans border-border/50 focus:border-primary/50"
                  rows={4}
                  placeholder="Enter operational impact..."
                />
              </div>
            </div>

            {/* Gaps and Follow Ups */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-3">
                <p className="text-xs text-primary font-bold mono">// GAPS & UNRESOLVED QUESTIONS (CLICK A GAP TO INVESTIGATE)</p>
                <div className="space-y-2">
                  <Textarea
                    disabled={editLocked}
                    value={editGaps}
                    onChange={(e) => { setEditGaps(e.target.value); setIsDirty(true); }}
                    className="text-xs text-muted-foreground bg-background/50 font-mono border-border/50 focus:border-primary/50"
                    rows={4}
                    placeholder="Enter gaps (one per line)..."
                  />
                  {editGaps.split("\n").filter(Boolean).map((gap, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded bg-background/40 border border-border/30 text-xs">
                      <span className="truncate flex-1 pr-2">{gap}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] text-primary hover:text-primary font-mono gap-1"
                        onClick={() => {
                          setShowChat(true);
                          setInput(`Regarding the identified gap: "${gap}". Can you help analyze this gap and suggest how we should resolve it?`);
                          toast.info("Prompt generated in Chat Console!");
                        }}
                      >
                        <MessageSquare className="w-3.5 h-3.5 mr-1" /> Ask Agent
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-secondary/30 border border-border/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-accent font-bold mono">// SUGGESTED FOLLOW-UPS (ONE PER LINE)</p>
                <Textarea
                  disabled={editLocked}
                  value={editFollowUps}
                  onChange={(e) => { setEditFollowUps(e.target.value); setIsDirty(true); }}
                  className="text-xs text-muted-foreground bg-background/50 font-mono border-border/50 focus:border-primary/50"
                  rows={4}
                  placeholder="Enter follow-ups (one per line)..."
                />
              </div>
            </div>

            {/* Attachments List */}
            <div className="bg-secondary/10 border border-border/40 rounded-lg p-4 space-y-3">
              <span className="text-xs text-muted-foreground mono block">// INCIDENT ATTACHMENTS & METADATA</span>
              {caseAttachments.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
                  {caseAttachments.map((a, i) => (
                    <div
                      key={i}
                      className="group relative border border-border rounded overflow-hidden aspect-video bg-background/50 hover:border-primary/50 transition-colors flex flex-col justify-end"
                    >
                      <img src={a.url} className="w-full h-full object-cover group-hover:scale-105 transition-transform absolute inset-0" alt={a.filename} />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60 group-hover:opacity-85 transition-opacity" />
                      <div className="relative p-1 text-[9px] text-white font-mono truncate text-center z-10 w-full flex flex-col gap-0.5">
                        <span className="truncate font-semibold">{a.filename}</span>
                        <a
                          href={a.url}
                          download
                          className="bg-primary/20 border border-primary/40 hover:bg-primary/40 text-white rounded py-0.5 mt-0.5 transition-colors block"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic font-mono">// No attachments found.</p>
              )}
            </div>
            
            {editLocked && (
              <div className="flex justify-end pt-4">
                <Button
                  variant="default"
                  size="lg"
                  className="bg-primary hover:bg-primary/95 text-primary-foreground font-semibold px-6 shadow-lg shadow-primary/20 flex items-center gap-2"
                  onClick={() => goToAgent(agentStep + 1)}
                >
                  Proceed to 5 Why Analysis
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </div>
            )}

            {/* Iterative Q&A */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE INCIDENT DATA</p>
                <span className="text-[10px] text-muted-foreground font-mono">Ask the agent to find gaps, verify details, or suggest missing data</span>
              </div>
              {renderIterativePanel("e.g. \"What additional data would help validate this incident?\" or \"Are the equipment details complete?\"...")}
            </div>
          </div>
        );
      }

      case "five_why": {
        const interactiveSteps: any[] = [];
        const startIndex = findLastIndex(
          messages,
          (m: any) => m.role === "user" && m.content.includes("START FRESH 5 WHY ANALYSIS")
        );

        if (startIndex !== -1) {
          const sessionMsgs = messages.slice(startIndex);
          for (let i = 0; i < sessionMsgs.length; i++) {
            const m = sessionMsgs[i];
            if (m.role === "assistant") {
              try {
                const parsed = parseMaybeJson(m.content);
                if (parsed && (parsed.question || parsed.whyStep)) {
                  let selected = "";
                  const nextMsg = sessionMsgs[i + 1];
                  if (nextMsg && nextMsg.role === "user") {
                    selected = nextMsg.content;
                  }
                  interactiveSteps.push({
                    stepNumber: parsed.whyStep ? (parsed.whyStep - 1) : (interactiveSteps.length + 1),
                    question: parsed.question || "",
                    possibleCauses: parsed.possibleCauses || [],
                    operatorInstruction: parsed.operatorInstruction || "",
                    selectedAnswer: selected,
                  });
                }
              } catch {}
            }
          }
        }

        const activeStreamText = streamingChatText || streamingText;
        const isStreamingActive = activeStreamText !== null;
        let streamingParsed: any = null;

        if (isStreamingActive && activeStreamText) {
          streamingParsed = parseMaybeJson(activeStreamText);
          if (streamingParsed && (streamingParsed.question || streamingParsed.whyStep)) {
            const stepNum = streamingParsed.whyStep ? (streamingParsed.whyStep - 1) : (interactiveSteps.length + 1);
            const existingIdx = interactiveSteps.findIndex(s => s.stepNumber === stepNum);
            const streamingStep = {
              stepNumber: stepNum,
              question: streamingParsed.question || "Generating next question...",
              possibleCauses: streamingParsed.possibleCauses || [],
              operatorInstruction: streamingParsed.operatorInstruction || "",
              selectedAnswer: "",
              isStreaming: true,
            };
            if (existingIdx !== -1) {
              interactiveSteps[existingIdx] = streamingStep;
            } else {
              interactiveSteps.push(streamingStep);
            }
          }
        }

        const currentStep = interactiveSteps.find(s => !s.selectedAnswer);

        const submitResponse = () => {
          if (!currentStep) return;
          let answerText = "";
          if (selectedCauseId === "custom") {
            if (!customCauseText.trim()) {
              toast.error("Please enter a custom explanation.");
              return;
            }
            answerText = `I select the ${customCauseText.trim()}.`;
          } else if (selectedCauseId) {
            const cause = currentStep.possibleCauses.find((c: any) => c.id === selectedCauseId);
            if (cause) {
              answerText = `I select ${cause.id}: ${cause.description}`;
            }
          }

          if (!answerText) {
            toast.error("Please select a suggested cause or choose Custom and write an answer.");
            return;
          }

          sendMut.mutate(answerText, {
            onSuccess: () => {
              setSelectedCauseId("");
              setCustomCauseText("");
              qc.invalidateQueries({ queryKey: ["msgs", convId] });
            }
          });
        };

        const renderLikelihoodBadge = (lh: string) => {
          let color = "bg-blue-500/10 text-blue-400 border-blue-500/20";
          if (lh.toLowerCase() === "high") {
            color = "bg-red-500/15 text-red-400 border-red-500/30";
          } else if (lh.toLowerCase() === "medium") {
            color = "bg-amber-500/15 text-amber-400 border-amber-500/30";
          }
          return (
            <Badge variant="outline" className={`text-[10px] uppercase font-mono tracking-wider ${color}`}>
              {lh}
            </Badge>
          );
        };

        return (
          <div ref={fiveWhyScrollRef} className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <div>
                <h3 className="font-bold text-lg mono uppercase">// 5 Why Root Cause Investigation</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Guided recursive cause-and-effect questioning to locate physical root cause.</p>
              </div>
              {interactiveSteps.length > 0 && (
                <Badge variant="outline" className="text-xs font-mono bg-primary/10 text-primary border-primary/20">
                  Step {interactiveSteps.length} in Chain
                </Badge>
              )}
            </div>

            {interactiveSteps.length > 0 && (
              <div className="space-y-4 relative pl-6 border-l-2 border-border/40 ml-3">
                {interactiveSteps.map((step, idx) => {
                  const isCurrent = !step.selectedAnswer;
                  
                  let displayAns = step.selectedAnswer;
                  if (displayAns.startsWith("I select cause-")) {
                    displayAns = displayAns.substring(displayAns.indexOf(":") + 1).trim();
                  } else if (displayAns.startsWith("I select the ")) {
                    displayAns = displayAns.substring(13).trim();
                    if (displayAns.endsWith(".")) {
                      displayAns = displayAns.substring(0, displayAns.length - 1);
                    }
                  } else if (displayAns.startsWith("I select ")) {
                    displayAns = displayAns.substring(9).trim();
                  }

                  return (
                    <div key={idx} className="relative group">
                      <div className={`absolute -left-[31px] top-1.5 w-4 h-4 rounded-full border-2 bg-background flex items-center justify-center transition-all ${
                        isCurrent 
                          ? "border-primary scale-110 shadow-[0_0_8px_rgba(251,191,36,0.5)]" 
                          : "border-emerald-500 bg-emerald-500/10"
                      }`}>
                        {isCurrent ? (
                          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        ) : (
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        )}
                      </div>

                      <div className={`p-4 rounded-lg border transition-all duration-300 ${
                        isCurrent
                          ? "bg-secondary/40 border-primary/40 shadow-sm"
                          : "bg-secondary/20 border-border/40"
                      }`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                            isCurrent ? "bg-primary/20 text-primary" : "bg-emerald-500/10 text-emerald-400"
                          }`}>
                            WHY STEP {step.stepNumber}
                          </span>
                          {step.isStreaming && (
                            <span className="flex items-center gap-1 text-[10px] text-primary font-mono animate-pulse">
                              <Loader2 className="w-3 h-3 animate-spin" /> streaming tokens...
                            </span>
                          )}
                        </div>

                        <h4 className="text-sm font-semibold text-foreground mb-3">{step.question}</h4>

                        {step.selectedAnswer ? (
                          <div className="flex items-start gap-2 bg-emerald-500/5 border border-emerald-500/20 rounded-md p-3">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                            <div className="flex-1 space-y-2">
                              <div>
                                <span className="text-emerald-400 font-semibold font-mono uppercase tracking-wider block text-[10px] mb-0.5">DEDUCTION / EXPLANATION</span>
                                <span className="text-sm text-muted-foreground font-medium">{displayAns}</span>
                              </div>
                              <div className="flex gap-2 pt-1 border-t border-emerald-500/10">
                                <button
                                  onClick={() => {
                                    const updatedSteps = interactiveSteps.map((s, si) =>
                                      si === idx ? { ...s, selectedAnswer: "" } : s
                                    );
                                    setFiveWhys(updatedSteps.map(s => ({ question: s.question, answer: s.selectedAnswer || "", evidence: s.evidence, isValidRootCause: s.isValidRootCause })));
                                    toast.info("Answer reset — you can re-answer");
                                  }}
                                  className="text-xs px-3 py-1.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-all font-mono"
                                >
                                  ↻ Re-answer
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : step.isStreaming && step.possibleCauses.length === 0 ? (
                          <div className="flex items-center gap-2 py-4 justify-center text-xs text-muted-foreground italic font-mono">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" /> Generating suggested causes...
                          </div>
                        ) : (
                          <div className="space-y-4 pt-2">
                            {step.possibleCauses && step.possibleCauses.length > 0 ? (
                              <div className="space-y-4">
                                <div className="space-y-2">
                                  <label className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider block">SELECT A CAUSE OR CHOOSE CUSTOM</label>
                                  <div className="grid gap-2">
                                    {step.possibleCauses.map((cause: any) => {
                                      const isSelected = selectedCauseId === cause.id;
                                      return (
                                        <button
                                          key={cause.id}
                                          type="button"
                                          disabled={sendMut.isPending}
                                          onClick={() => {
                                            setSelectedCauseId(cause.id);
                                            setCustomCauseText("");
                                          }}
                                          className={`w-full text-left p-3 rounded-lg border transition-all flex items-start gap-3 ${
                                            isSelected
                                              ? "border-primary bg-primary/5 text-foreground shadow-sm shadow-primary/5"
                                              : "border-border/60 hover:border-border hover:bg-secondary/40 text-muted-foreground"
                                          }`}
                                        >
                                          <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                                            isSelected ? "border-primary" : "border-muted-foreground/30"
                                          }`}>
                                            {isSelected && <div className="w-2 h-2 rounded-full bg-primary" />}
                                          </div>
                                          <div className="flex-1 space-y-1">
                                            <div className="flex items-center gap-2">
                                              <span className="text-[9px] font-mono font-bold bg-muted px-1.5 py-0.5 rounded text-muted-foreground uppercase">{cause.category}</span>
                                              {renderLikelihoodBadge(cause.likelihood)}
                                            </div>
                                            <p className="text-xs font-semibold text-foreground">{cause.description}</p>
                                          </div>
                                        </button>
                                      );
                                    })}

                                    {/* Custom Option */}
                                    <button
                                      type="button"
                                      disabled={sendMut.isPending}
                                      onClick={() => {
                                        setSelectedCauseId("custom");
                                      }}
                                      className={`w-full text-left p-3 rounded-lg border transition-all flex items-start gap-3 ${
                                        selectedCauseId === "custom"
                                          ? "border-primary bg-primary/5 text-foreground shadow-sm shadow-primary/5"
                                          : "border-border/60 hover:border-border hover:bg-secondary/40 text-muted-foreground"
                                      }`}
                                    >
                                      <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                                        selectedCauseId === "custom" ? "border-primary" : "border-muted-foreground/30"
                                      }`}>
                                        {selectedCauseId === "custom" && <div className="w-2 h-2 rounded-full bg-primary" />}
                                      </div>
                                      <div className="flex-1 space-y-1">
                                        <span className="text-[9px] font-mono font-bold bg-muted px-1.5 py-0.5 rounded text-muted-foreground uppercase">Custom</span>
                                        <p className="text-xs font-semibold text-foreground">Write a custom explanation/cause for this step</p>
                                      </div>
                                    </button>
                                  </div>
                                </div>

                                {selectedCauseId === "custom" && (
                                  <div className="space-y-2 animate-fadeIn">
                                    <label className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider block">WRITE CUSTOM EXPLANATION</label>
                                    <Textarea
                                      disabled={sendMut.isPending}
                                      value={customCauseText}
                                      onChange={(e) => {
                                        setCustomCauseText(e.target.value);
                                      }}
                                      placeholder="Type your own operational findings for this step..."
                                      rows={2}
                                      className="text-xs font-mono bg-background/50 border-border/50 focus:border-primary/50"
                                    />
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-5 space-y-4">
                                <div className="flex items-center gap-2 text-emerald-400">
                                  <Zap className="w-5 h-5 text-emerald-400 animate-pulse" />
                                  <h4 className="font-bold text-sm uppercase mono tracking-wide">Analysis Chain Complete</h4>
                                </div>
                                <p className="text-xs text-muted-foreground">The 5-Why analysis has successfully isolated the fundamental root cause of this operational trip.</p>
                                <div className="flex justify-end pt-2">
                                  <Button
                                    variant="default"
                                    size="sm"
                                    className="bg-primary hover:bg-primary/95 text-primary-foreground font-semibold flex items-center gap-2"
                                    onClick={() => goToAgent(agentStep + 1)}
                                  >
                                    Proceed to Fishbone Diagram
                                    <ArrowRight className="w-4 h-4" />
                                  </Button>
                                </div>
                              </div>
                            )}

                             {step.possibleCauses && step.possibleCauses.length > 0 && (
                               <div className="flex justify-end pt-2">
                                 <Button
                                   variant="default"
                                   disabled={sendMut.isPending || step.isStreaming || (!selectedCauseId && !customCauseText.trim())}
                                   onClick={submitResponse}
                                   className="bg-primary hover:bg-primary/95 text-primary-foreground font-semibold flex items-center gap-2"
                                 >
                                  {sendMut.isPending ? (
                                    <>
                                      <Loader2 className="w-4 h-4 animate-spin" /> Submitting...
                                    </>
                                  ) : (
                                    <>
                                      Submit Response & Continue
                                      <ArrowRight className="w-4 h-4" />
                                    </>
                                  )}
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Save Findings & Iterative Q&A */}
            {interactiveSteps.length > 0 && (
              <div className="space-y-4">
                <div className="flex gap-3 items-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const findings = interactiveSteps.map(s => ({
                        question: s.question,
                        answer: s.selectedAnswer || "",
                        isValidRootCause: s.selectedAnswer !== "",
                      }));
                      const updatedPayload = { ...parsedData, fiveWhys: findings };
                      updateAgentMsgMut.mutate(updatedPayload);
                      toast.success("5-Why findings saved!");
                    }}
                    disabled={updateAgentMsgMut.isPending}
                    className="text-sm font-mono"
                  >
                    {updateAgentMsgMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileCheck2 className="w-4 h-4 mr-2" />}
                    Save Findings
                  </Button>
                </div>
                <div className="border border-border/50 rounded-xl overflow-hidden">
                  <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                    <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE 5-WHY ANALYSIS</p>
                    <span className="text-[10px] text-muted-foreground font-mono">Ask to rephrase questions, add evidence links, or challenge findings</span>
                  </div>
                  {renderIterativePanel("e.g. \"Re-examine Why step 2 with this new evidence...\" or \"Can you provide alternative causes for step 3?\"...")}
                </div>
              </div>
            )}

            {interactiveSteps.length === 0 && (
              <div className="max-w-2xl mx-auto py-12">
                <div className="bg-gradient-to-br from-secondary/30 via-background to-secondary/15 border border-border/60 rounded-xl p-8 text-center space-y-6 shadow-lg shadow-black/10">
                  <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                    <Activity className="w-6 h-6" />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-base font-bold uppercase mono tracking-wide">Start Guided 5-Why Investigation</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed max-w-md mx-auto">
                      Drill down to the physical root cause of the failure using automated, logic-driven recursive questioning. Ingests locked findings from the Data Collector step to begin.
                    </p>
                  </div>
                  <div className="pt-2">
                    <Button
                      size="lg"
                      disabled={hypothesisMut.isPending}
                      onClick={() => hypothesisMut.mutate()}
                      className="bg-primary hover:bg-primary/95 text-primary-foreground font-semibold px-8 flex items-center gap-2 mx-auto"
                    >
                      {hypothesisMut.isPending ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" /> Initiating Step 1...
                        </>
                      ) : (
                        <>
                          Initiate 5-Why Analysis
                          <ArrowRight className="w-5 h-5" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      }

      case "fishbone": {
        const standardCats = ["manpower", "machine", "methods", "materials", "measurements", "environment"];
        const allCategories = Array.from(new Set([...standardCats, ...Object.keys(fishboneCategories), ...customCategories]));

        const updateCause = (cat: string, index: number, key: string, value: any) => {
          const updatedCat = [...(fishboneCategories[cat] || [])];
          if (typeof updatedCat[index] === "string") {
            updatedCat[index] = { cause: updatedCat[index], likelihood: "Medium", weight: 50 };
          }
          updatedCat[index] = { ...updatedCat[index], [key]: value };
          setFishboneCategories({ ...fishboneCategories, [cat]: updatedCat });
          setIsDirty(true);
        };

        const addCause = (cat: string) => {
          const updatedCat = [...(fishboneCategories[cat] || []), { cause: "New cause details", likelihood: "Medium", weight: 50 }];
          setFishboneCategories({ ...fishboneCategories, [cat]: updatedCat });
          setIsDirty(true);
        };

        const deleteCause = (cat: string, index: number) => {
          const updatedCat = (fishboneCategories[cat] || []).filter((_, i) => i !== index);
          setFishboneCategories({ ...fishboneCategories, [cat]: updatedCat });
          setIsDirty(true);
        };

        const moveCause = (fromCat: string, toCat: string, index: number) => {
          const causeToMove = fishboneCategories[fromCat][index];
          const updatedFrom = fishboneCategories[fromCat].filter((_, i) => i !== index);
          const updatedTo = [...(fishboneCategories[toCat] || []), causeToMove];
          setFishboneCategories({
            ...fishboneCategories,
            [fromCat]: updatedFrom,
            [toCat]: updatedTo
          });
          setIsDirty(true);
          toast.info(`Moved cause to ${toCat}`);
        };

        const addCustomCat = () => {
          if (newCategoryName.trim()) {
            const catLower = newCategoryName.trim().toLowerCase();
            if (!customCategories.includes(catLower)) {
              setCustomCategories([...customCategories, catLower]);
              setFishboneCategories({ ...fishboneCategories, [catLower]: [] });
              setNewCategoryName("");
              setIsDirty(true);
              toast.success(`Category "${newCategoryName}" added!`);
            }
          }
        };

        const saveFishbone = () => {
          const updatedPayload = {
            ...parsedData,
            fishbone: fishboneCategories
          };
          updateAgentMsgMut.mutate(updatedPayload);
        };

        const isComplete = fishboneStep && (fishboneStep.step === 10 || fishboneStep.type === "final");
        const showFinalDiagram = isComplete && !showInteractiveGuideOverride;

        const submitFishboneResponse = (customText?: string) => {
          const text = customText || selectedFishboneAnswer;
          if (!text.trim()) {
            toast.error("Please enter a response.");
            return;
          }
          sendMut.mutate(text, {
            onSuccess: () => {
              setSelectedFishboneAnswer("");
              qc.invalidateQueries({ queryKey: ["msgs", convId] });
            }
          });
        };

        const finalizeFishboneNow = () => {
          sendMut.mutate("skip remaining steps and finalize now", {
            onSuccess: () => {
              setSelectedFishboneAnswer("");
              qc.invalidateQueries({ queryKey: ["msgs", convId] });
            }
          });
        };

        // Empty state: no history yet — show start button
        // Also scan messages directly to avoid race condition between
        // onSuccess clearing isPending/isStreaming and useEffect syncing fishboneStep state
        const fishboneHasMessageHistory = messages.some((m: any) => {
          if (m.role !== "assistant") return false;
          try {
            const p = parseMaybeJson(m.content);
            return p && p.step;
          } catch { return false; }
        });
        const fishboneHasHistory = fishboneHistory.length > 0 || fishboneStep !== null || fishboneHasMessageHistory;

        // Also treat "loading messages after hypothesis" as a loading state
        const fishboneIsLoading = hypothesisMut.isPending || isStreaming ||
          (msgsQ.isFetching && !fishboneHasHistory) ||
          (hypothesisMut.isSuccess && !fishboneHasHistory);

        if (!fishboneHasHistory && !fishboneIsLoading) {
          return (
            <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-6 text-center max-w-3xl mx-auto">
              <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center shadow-[0_0_20px_rgba(251,191,36,0.1)]">
                <Layers className="w-10 h-10 text-primary animate-pulse" />
              </div>
              <div className="space-y-3">
                <h3 className="text-xl font-bold mono uppercase text-primary">Start Fishbone (Ishikawa) Analysis</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
                  The AI will guide you step-by-step through building a 6M Cause-and-Effect diagram.
                  You will confirm the problem statement, review initial causes by category, drill down
                  into each category interactively, and finalize with weighted scores.
                </p>
                <div className="flex flex-wrap gap-2 justify-center pt-1">
                  {["Manpower","Machine","Methods","Materials","Measurements","Environment"].map(cat => (
                    <span key={cat} className="text-[10px] font-mono px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{cat}</span>
                  ))}
                </div>
              </div>
              <Button
                size="lg"
                className="px-8 shadow-lg hover:shadow-primary/20 hover:scale-102 transition-all bg-primary hover:bg-primary/95"
                onClick={() => hypothesisMut.mutate()}
                disabled={hypothesisMut.isPending}
              >
                <Activity className="w-4 h-4 mr-2" />
                Initiate Fishbone Investigation
              </Button>
            </div>
          );
        }

        // Fishbone streaming/loading state (API in-flight OR messages being fetched post-completion)
        if (fishboneIsLoading && !fishboneHasHistory) {
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
                <h3 className="text-lg font-bold mono">// FISHBONE AGENT INITIATING</h3>
                <p className="text-sm text-muted-foreground">
                  Fishbone agent is loading context from previous steps and preparing Step 1: Problem Confirmation...
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

        if (!showFinalDiagram) {
          // fishboneStep may not be synced yet by useEffect (race condition).
          // Derive step data directly from messages as a reliable fallback.
          // Also check streaming text during active SSE to render live.
          let derivedData: any = fishboneStep?.data || null;
          if (streamingText) {
            try {
              const sp = parseMaybeJson(streamingText);
              if (sp && sp.step) { derivedData = sp; }
            } catch {}
          }
          if (!derivedData) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = (messages as any[])[i];
              if (m.role === "assistant") {
                try {
                  const p = parseMaybeJson(m.content);
                  if (p && p.step) { derivedData = p; break; }
                } catch {}
              }
            }
          }
          const currentStepData = derivedData || {};
          const currentStepNum: number = (fishboneStep?.step ?? derivedData?.step) || 1;
          const currentStepType: string = (fishboneStep?.type ?? derivedData?.type) || "problem_confirm";

          return (
            <div ref={fiveWhyScrollRef} className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-border/60 pb-3">
                <div>
                  <h3 className="font-bold text-lg mono uppercase">// Fishbone Guided Investigation</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Iteratively construct a 6M Cause-and-Effect diagram with AI guidance.</p>
                </div>
                <div className="flex gap-2">
                  <Badge variant="outline" className="text-xs font-mono bg-primary/10 text-primary border-primary/20">
                    Step {currentStepNum} / 10
                  </Badge>
                  {isComplete && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowInteractiveGuideOverride(false)}
                      className="text-[10px] h-6 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                    >
                      View Final Diagram
                    </Button>
                  )}
                  {!isComplete && (
                    <Button size="sm" variant="outline" className="text-[10px] h-6" onClick={finalizeFishboneNow} disabled={sendMut.isPending}>
                      Finalize Now
                    </Button>
                  )}
                </div>
              </div>

              {/* History Trail */}
              <div className="space-y-4">
                {fishboneHistory.map((h, idx) => {
                  if (h.step >= currentStepNum && !h.operatorResponse) return null;
                  return (
                    <div key={idx} className="space-y-3">
                      {/* AI Side */}
                      <div className="bg-secondary/15 border border-border/40 rounded-xl p-5 space-y-3">
                        <span className="text-[10px] text-primary font-bold mono block">// STEP {h.step} ANALYSIS: {h.type.toUpperCase().replace("_", " ")}</span>
                        
                        {h.type === "problem_confirm" && (
                          <div className="text-xs space-y-1">
                            <span className="text-muted-foreground block font-mono">PROPOSED PROBLEM STATEMENT</span>
                            <p className="font-semibold text-foreground bg-background/50 p-2.5 rounded border border-border/30">{h.aiData.proposedProblemStatement}</p>
                          </div>
                        )}

                        {h.type === "initial_categories" && h.aiData.categories && (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-[11px]">
                            {Object.entries(h.aiData.categories).map(([cat, causes]: any) => (
                              <div key={cat} className="p-2 border border-border/40 bg-background/30 rounded">
                                <span className="font-bold uppercase text-primary text-[9px] block mb-1">{cat}</span>
                                <ul className="list-disc pl-3.5 space-y-0.5 text-muted-foreground">
                                  {Array.isArray(causes) && causes.map((c: string, cidx: number) => <li key={cidx}>{c}</li>)}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}

                        {h.type === "drill_down" && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Badge className="bg-primary/20 text-primary border-primary/30 uppercase text-[9px] font-mono">Drilling: {h.aiData.activeCategory}</Badge>
                              {h.aiData.completedCategories?.length > 0 && (
                                <span className="text-[10px] text-muted-foreground">Completed: {h.aiData.completedCategories.join(", ")}</span>
                              )}
                            </div>
                            {h.aiData.refinedCauses && (
                              <div className="space-y-1 text-xs">
                                <span className="text-muted-foreground block font-mono">REFINED CAUSES</span>
                                <div className="divide-y divide-border/20 border border-border/30 bg-background/20 rounded">
                                  {h.aiData.refinedCauses.map((rc: any, rcIdx: number) => (
                                    <div key={rcIdx} className="p-2 flex justify-between items-center gap-2">
                                      <div>
                                        <p className="font-semibold text-foreground">{rc.cause}</p>
                                        {rc.subCauses?.length > 0 && <p className="text-[10px] text-muted-foreground">Sub-causes: {rc.subCauses.join(", ")}</p>}
                                      </div>
                                      <Badge variant="outline" className={`text-[9px] font-mono uppercase ${
                                        rc.status === "confirmed" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                                        rc.status === "refuted" ? "bg-red-500/10 text-red-400 border-red-500/20" :
                                        "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                      }`}>{rc.status}</Badge>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {h.type === "scoring_review" && (
                          <div className="space-y-2 text-xs">
                            <span className="text-muted-foreground block font-mono">FULL CAUSES SUMMARY</span>
                            <div className="grid grid-cols-2 gap-3">
                              {h.aiData.fullCauseSummary && Object.entries(h.aiData.fullCauseSummary).map(([cat, causes]: any) => (
                                <div key={cat} className="p-2 border border-border/40 bg-background/30 rounded">
                                  <span className="font-bold uppercase text-primary text-[9px] block mb-1">{cat}</span>
                                  <ul className="list-disc pl-3.5 space-y-0.5 text-muted-foreground">
                                    {Array.isArray(causes) && causes.map((c: string, cidx: number) => <li key={cidx}>{c}</li>)}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <p className="text-xs text-foreground font-medium border-t border-border/20 pt-2.5 mt-2">{h.aiData.question}</p>
                      </div>

                      {/* Operator Response */}
                      {h.operatorResponse && (
                        <div className="flex justify-end pl-8">
                          <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 max-w-2xl text-right">
                            <span className="text-[10px] text-muted-foreground font-bold mono block mb-1">// OPERATOR RESPONSE</span>
                            <p className="text-xs font-semibold text-foreground">{h.operatorResponse}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Active Step Panel */}
              <div className="bg-secondary/20 border border-primary/30 rounded-xl p-5 space-y-4 shadow-lg shadow-primary/5">
                <span className="text-xs text-primary font-bold mono block animate-pulse">● ACTIVE STEP {currentStepNum}: {currentStepType.toUpperCase().replace("_", " ")}</span>
                
                {currentStepType === "problem_confirm" && (
                  <div className="text-xs space-y-2">
                    <span className="text-muted-foreground font-mono">PROPOSED PROBLEM STATEMENT:</span>
                    <p className="font-semibold text-sm text-foreground bg-background/70 p-3 rounded-lg border border-border/50">{currentStepData.proposedProblemStatement}</p>
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" onClick={() => submitFishboneResponse("Yes, that statement is accurate.")} disabled={sendMut.isPending}>
                        Confirm Statement
                      </Button>
                    </div>
                  </div>
                )}

                {currentStepType === "initial_categories" && currentStepData.categories && (() => {
                  // Editable Step 2: build local mutable copy from currentStepData
                  // We use fishboneCategories state which is already populated from parsedData on step 10,
                  // but for step 2 we read from currentStepData.categories directly as the source of truth.
                  // We keep a separate local edit state via a key-prefixed approach using fishboneCategories.
                  const catSource: Record<string, string[]> = {};
                  Object.entries(currentStepData.categories).forEach(([cat, causes]: any) => {
                    catSource[cat] = Array.isArray(causes) ? [...causes] : [];
                  });

                  // Merge with any user edits already in fishboneCategories
                  const mergedCats: Record<string, string[]> = Object.keys(fishboneCategories).length > 0
                    ? fishboneCategories
                    : catSource;

                  const updateCauseText = (cat: string, idx: number, val: string) => {
                    const updated = { ...mergedCats, [cat]: mergedCats[cat].map((c, i) => i === idx ? val : c) };
                    setFishboneCategories(updated);
                  };

                  const removeCause = (cat: string, idx: number) => {
                    const updated = { ...mergedCats, [cat]: mergedCats[cat].filter((_, i) => i !== idx) };
                    setFishboneCategories(updated);
                  };

                  const addCauseToCategory = (cat: string) => {
                    const updated = { ...mergedCats, [cat]: [...(mergedCats[cat] || []), ""] };
                    setFishboneCategories(updated);
                  };

                  const removeCategory = (cat: string) => {
                    const updated = { ...mergedCats };
                    delete updated[cat];
                    setFishboneCategories(updated);
                  };

                  const addNewCategory = () => {
                    const name = newCategoryName.trim().toLowerCase();
                    if (!name) return;
                    if (mergedCats[name] !== undefined) { toast.error("Category already exists"); return; }
                    setFishboneCategories({ ...mergedCats, [name]: [""] });
                    setNewCategoryName("");
                    toast.success(`Category "${name}" added`);
                  };

                  const buildApprovalMessage = () => {
                    const lines = ["Approved with edits:"];
                    Object.entries(mergedCats).forEach(([cat, causes]) => {
                      lines.push(`${cat.charAt(0).toUpperCase() + cat.slice(1)}: ${(causes as string[]).filter(c => c.trim()).join("; ")}`);
                    });
                    return lines.join("\n");
                  };

                  const catColors: Record<string, string> = {
                    manpower: "border-blue-500/40 bg-blue-500/5",
                    machine: "border-rose-500/40 bg-rose-500/5",
                    methods: "border-amber-500/40 bg-amber-500/5",
                    materials: "border-emerald-500/40 bg-emerald-500/5",
                    measurements: "border-purple-500/40 bg-purple-500/5",
                    environment: "border-cyan-500/40 bg-cyan-500/5",
                  };
                  const catLabelColors: Record<string, string> = {
                    manpower: "text-blue-400",
                    machine: "text-rose-400",
                    methods: "text-amber-400",
                    materials: "text-emerald-400",
                    measurements: "text-purple-400",
                    environment: "text-cyan-400",
                  };

                  return (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground font-mono">PROPOSED INITIAL CAUSES BY CATEGORY:</span>
                        <span className="text-[10px] text-primary font-mono bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                          ✎ Click any cause to edit · Use + to add · × to remove
                        </span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {Object.entries(mergedCats).map(([cat, causes]) => (
                          <div key={cat} className={`p-3 border rounded-xl space-y-2 ${catColors[cat] || "border-border/50 bg-secondary/10"}`}>
                            <div className="flex items-center justify-between">
                              <span className={`font-bold uppercase text-[10px] tracking-wider ${catLabelColors[cat] || "text-primary"}`}>{cat}</span>
                              <button
                                onClick={() => removeCategory(cat)}
                                className="text-[9px] text-muted-foreground hover:text-red-400 transition-colors font-mono"
                                title="Remove category"
                              >
                                × remove cat
                              </button>
                            </div>

                            <div className="space-y-1.5">
                              {(causes as string[]).map((cause, cidx) => (
                                <div key={cidx} className="flex gap-1.5 items-start">
                                  <span className="text-primary/60 font-bold text-[10px] mt-2 shrink-0">•</span>
                                  <input
                                    type="text"
                                    value={cause}
                                    onChange={(e) => updateCauseText(cat, cidx, e.target.value)}
                                    className="flex-1 text-[11px] bg-background/70 border border-border/50 rounded px-2 py-1 text-foreground font-mono focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 transition-all"
                                    placeholder="Describe cause..."
                                  />
                                  <button
                                    onClick={() => removeCause(cat, cidx)}
                                    className="text-muted-foreground hover:text-red-400 transition-colors mt-1.5 shrink-0"
                                  >
                                    <XCircle className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>

                            <button
                              onClick={() => addCauseToCategory(cat)}
                              className="text-[10px] text-primary/70 hover:text-primary font-mono flex items-center gap-1 transition-colors pt-1 border-t border-border/20 w-full"
                            >
                              <Plus className="w-3 h-3" /> Add cause
                            </button>
                          </div>
                        ))}

                        {/* Add new category card */}
                        <div className="p-3 border border-dashed border-border/40 rounded-xl flex flex-col gap-2 justify-center items-center bg-secondary/5">
                          <span className="text-[10px] text-muted-foreground font-mono uppercase">Add Category</span>
                          <input
                            type="text"
                            value={newCategoryName}
                            onChange={(e) => setNewCategoryName(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && addNewCategory()}
                            placeholder="e.g. software, process..."
                            className="w-full text-[11px] bg-background border border-border/50 rounded px-2 py-1 text-foreground font-mono focus:border-primary/50 focus:outline-none text-center"
                          />
                          <button
                            onClick={addNewCategory}
                            disabled={!newCategoryName.trim()}
                            className="text-[10px] font-mono text-primary disabled:opacity-40 flex items-center gap-1 hover:text-primary/80"
                          >
                            <Plus className="w-3 h-3" /> Add
                          </button>
                        </div>
                      </div>

                      <div className="flex gap-2 pt-1 flex-wrap">
                        <Button
                          size="sm"
                          onClick={() => {
                            // Initialize fishboneCategories so final diagram also uses these
                            setFishboneCategories(mergedCats);
                            submitFishboneResponse(buildApprovalMessage());
                          }}
                          disabled={sendMut.isPending}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                          Approve & Proceed to Drill-Down
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            // Reset to original AI proposal
                            setFishboneCategories(catSource);
                            toast.info("Categories reset to AI proposal");
                          }}
                        >
                          Reset to AI Proposal
                        </Button>
                      </div>
                    </div>
                  );
                })()}


                {currentStepType === "drill_down" && (() => {
                  // Collect all completed drill-down entries from history for navigation
                  const completedDrills = fishboneHistory
                    .filter((h) => h.type === "drill_down" && h.operatorResponse)
                    .map((h) => h);

                  return (
                  <div className="space-y-4">
                    {/* Category Progress Bar */}
                    <div className="bg-secondary/30 border border-border/50 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-primary/20 text-primary border-primary/30 uppercase text-xs font-mono px-3 py-1">
                            Verifying: {currentStepData.activeCategory}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <ChevronLeft
                            className="w-4 h-4 cursor-pointer hover:text-primary transition-colors"
                            onClick={() => {
                              // Go to previous completed drill-down
                              if (completedDrills.length > 0) {
                                setViewingPastFishboneStep(viewingPastFishboneStep === completedDrills.length - 1 
                                  ? (completedDrills.length > 1 ? completedDrills.length - 2 : null)
                                  : (viewingPastFishboneStep !== null ? viewingPastFishboneStep + 1 : 0)
                                );
                              }
                            }}
                          />
                          <span className="text-xs text-muted-foreground font-mono">
                            {completedDrills.length} prior step{completedDrills.length !== 1 ? 's' : ''} reviewed
                          </span>
                          <ChevronRight
                            className="w-4 h-4 cursor-pointer hover:text-primary transition-colors"
                            onClick={() => {
                              if (completedDrills.length > 0) {
                                setViewingPastFishboneStep(viewingPastFishboneStep !== null 
                                  ? (viewingPastFishboneStep < completedDrills.length - 1 ? viewingPastFishboneStep + 1 : 0)
                                  : 0
                                );
                              }
                            }}
                          />
                        </div>
                      </div>
                      
                      {/* Completed/Pending Categories Pills */}
                      <div className="flex flex-wrap gap-2">
                        {currentStepData.completedCategories?.map((cat: string, i: number) => (
                          <Badge
                            key={cat}
                            className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs px-3 py-1 font-mono"
                          >
                            ✓ {cat}
                          </Badge>
                        ))}
                        <Badge className="bg-primary/20 text-primary border-primary/40 text-xs px-3 py-1 font-mono animate-pulse">
                          ● {currentStepData.activeCategory}
                        </Badge>
                        {currentStepData.pendingCategories?.map((cat: string) => (
                          <Badge
                            key={cat}
                            variant="outline"
                            className="text-muted-foreground/60 text-xs px-3 py-1 font-mono"
                          >
                            ○ {cat}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {/* Past Step Review Panel */}
                    {viewingPastFishboneStep !== null && completedDrills[viewingPastFishboneStep] && (() => {
                      const past = completedDrills[viewingPastFishboneStep].aiData;
                      return (
                        <div className="bg-background/80 border-2 border-border/50 rounded-xl p-5 space-y-4">
                          <div className="flex items-center justify-between border-b border-border/40 pb-3">
                            <div className="flex items-center gap-2">
                              <Badge className="bg-muted text-muted-foreground border-border text-xs font-mono px-3 py-1">
                                STEP {completedDrills[viewingPastFishboneStep].step} — REVIEW ONLY
                              </Badge>
                              <span className="text-sm font-bold text-primary uppercase">{past.activeCategory}</span>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => setViewingPastFishboneStep(null)}
                            >
                              ✕ Close Review
                            </Button>
                          </div>
                          <div className="space-y-3">
                            {past.refinedCauses?.map((rc: any, rcIdx: number) => (
                              <div key={rcIdx} className="p-4 border border-border/40 rounded-lg bg-secondary/10">
                                <div className="flex items-start justify-between gap-3 mb-2">
                                  <p className="font-semibold text-sm text-foreground">{rc.cause}</p>
                                  <Badge className={`text-xs font-mono px-2.5 py-0.5 ${
                                    rc.status === "confirmed" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" :
                                    rc.status === "refuted" ? "bg-red-500/20 text-red-400 border-red-500/40" :
                                    "bg-amber-500/20 text-amber-400 border-amber-500/40"
                                  }`}>
                                    {rc.status}
                                  </Badge>
                                </div>
                                {rc.subCauses?.length > 0 && (
                                  <ul className="space-y-2 ml-1">
                                    {rc.subCauses.map((sc: string, si: number) => (
                                      <li key={si} className="flex items-start gap-2 text-sm text-muted-foreground">
                                        <span className="text-primary/60 mt-1.5 shrink-0">•</span>
                                        <span className="leading-relaxed">{sc}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))}
                          </div>
                          {past.operatorInstruction && (
                            <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-4 text-sm text-blue-400 font-mono">
                              <span className="font-bold text-xs uppercase tracking-wider block mb-1.5">● Instruction Given:</span>
                              {past.operatorInstruction}
                            </div>
                          )}
                          {past.question && (
                            <div className="bg-secondary/20 border border-border/40 rounded-lg p-4 text-sm text-foreground">
                              <span className="font-bold text-xs uppercase tracking-wider text-muted-foreground block mb-1.5">● Agent Question:</span>
                              {past.question}
                            </div>
                          )}
                          <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm">
                            <span className="font-bold text-xs uppercase tracking-wider text-primary block mb-1">● Your Response:</span>
                            <p className="text-muted-foreground leading-relaxed">{completedDrills[viewingPastFishboneStep].operatorResponse}</p>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Current Category Title */}
                    {viewingPastFishboneStep === null && (
                      <div className="flex items-center gap-3">
                        <h4 className="text-base font-bold text-foreground uppercase tracking-wide">
                          Causes for: {currentStepData.activeCategory}
                        </h4>
                      </div>
                    )}

                    {/* Current Causes — Editable */}
                    {viewingPastFishboneStep === null && currentStepData.refinedCauses && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Cause List</span>
                          <span className="text-xs text-primary font-mono bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
                            Edit causes inline · Set status to approve
                          </span>
                        </div>
                        <div className="space-y-3">
                          {currentStepData.refinedCauses.map((rc: any, rcIdx: number) => (
                            <div key={rcIdx} className="p-5 border-2 border-border/50 rounded-xl bg-background/70 space-y-4 hover:border-primary/30 transition-all">
                              {/* Cause Name + Status Row */}
                              <div className="flex items-start gap-3">
                                <input
                                  type="text"
                                  value={rc.cause}
                                  onChange={(e) => {
                                    const updated = currentStepData.refinedCauses.map((c: any, i: number) =>
                                      i === rcIdx ? { ...c, cause: e.target.value } : c
                                    );
                                    const next = { ...currentStepData, refinedCauses: updated };
                                    setFishboneStep({ ...fishboneStep!, data: next });
                                    setIsDirty(true);
                                  }}
                                  onBlur={() => {
                                    saveInteractiveStepMut.mutate(currentStepData);
                                  }}
                                  className="flex-1 bg-transparent border border-border/30 rounded-lg p-3 text-sm font-semibold text-foreground focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none transition-all"
                                  placeholder="Cause description..."
                                />
                                <div className="flex flex-col items-center gap-1 shrink-0">
                                  <select
                                    value={rc.status}
                                    onChange={(e) => {
                                      const updated = currentStepData.refinedCauses.map((c: any, i: number) =>
                                        i === rcIdx ? { ...c, status: e.target.value } : c
                                      );
                                      const next = { ...currentStepData, refinedCauses: updated };
                                      setFishboneStep({ ...fishboneStep!, data: next });
                                      setIsDirty(true);
                                      saveInteractiveStepMut.mutate(next);
                                      toast.success(`Cause ${e.target.value}`);
                                    }}
                                    className={`text-xs font-mono uppercase p-2 rounded-lg border w-[140px] cursor-pointer ${
                                      rc.status === "confirmed" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" :
                                      rc.status === "refuted" ? "bg-red-500/20 text-red-400 border-red-500/40" :
                                      "bg-amber-500/20 text-amber-400 border-amber-500/20"
                                    }`}
                                  >
                                    <option value="pending">⏳ Pending</option>
                                    <option value="confirmed">✓ Confirmed</option>
                                    <option value="refuted">✕ Refuted</option>
                                    <option value="pending_verification">⏳ Pending Verify</option>
                                  </select>
                                </div>
                              </div>

                              {/* Sub-causes as bullet list */}
                              {rc.subCauses?.length > 0 && (
                                <div className="ml-2 bg-secondary/20 border border-border/30 rounded-lg p-4">
                                  <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider block mb-2">
                                    Sub-Causes ({rc.subCauses.length})
                                  </span>
                                  <ul className="space-y-2.5">
                                    {rc.subCauses.map((sc: string, si: number) => (
                                      <li key={si} className="flex items-start gap-3 text-sm leading-relaxed">
                                        <span className="text-primary/60 mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-primary/60" />
                                        <span className="text-muted-foreground flex-1">{sc}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Action Buttons */}
                              <div className="flex gap-2 pt-1 border-t border-border/20">
                                <button
                                  onClick={() => {
                                    const updated = currentStepData.refinedCauses.map((c: any, i: number) =>
                                      i === rcIdx ? { ...c, status: "confirmed" } : c
                                    );
                                    const next = { ...currentStepData, refinedCauses: updated };
                                    setFishboneStep({ ...fishboneStep!, data: next });
                                    setIsDirty(true);
                                    saveInteractiveStepMut.mutate(next);
                                    toast.success("Cause confirmed ✓");
                                  }}
                                  className={`text-sm px-4 py-2 rounded-lg transition-all font-mono border ${
                                    rc.status === "confirmed"
                                      ? "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
                                      : rc.status === "refuted"
                                        ? "bg-transparent text-muted-foreground/40 border-border/40 opacity-40 cursor-not-allowed"
                                        : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
                                  }`}
                                  disabled={rc.status === "refuted"}
                                >
                                  {rc.status === "confirmed" ? "✓ Confirmed" : "✓ Confirm"}
                                </button>
                                <button
                                  onClick={() => {
                                    const updated = currentStepData.refinedCauses.map((c: any, i: number) =>
                                      i === rcIdx ? { ...c, status: "refuted" } : c
                                    );
                                    const next = { ...currentStepData, refinedCauses: updated };
                                    setFishboneStep({ ...fishboneStep!, data: next });
                                    setIsDirty(true);
                                    saveInteractiveStepMut.mutate(next);
                                    toast.info("Cause refuted");
                                  }}
                                  className={`text-sm px-4 py-2 rounded-lg transition-all font-mono border ${
                                    rc.status === "refuted"
                                      ? "bg-rose-600 text-white border-rose-600 hover:bg-rose-700"
                                      : rc.status === "confirmed"
                                        ? "bg-transparent text-muted-foreground/40 border-border/40 opacity-40 cursor-not-allowed"
                                        : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25"
                                  }`}
                                  disabled={rc.status === "confirmed"}
                                >
                                  {rc.status === "refuted" ? "✕ Refuted" : "✕ Refute"}
                                </button>
                                <button
                                  onClick={() => {
                                    const updated = currentStepData.refinedCauses.filter((_: any, i: number) => i !== rcIdx);
                                    const next = { ...currentStepData, refinedCauses: updated };
                                    setFishboneStep({ ...fishboneStep!, data: next });
                                    setIsDirty(true);
                                    saveInteractiveStepMut.mutate(next);
                                    toast.info("Cause removed");
                                  }}
                                  className="text-sm px-4 py-2 rounded-lg bg-muted/80 text-muted-foreground border border-border hover:bg-secondary transition-all font-mono"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          ))}

                          {/* Add new cause button */}
                          <button
                            onClick={() => {
                              const newCause = { cause: "New cause", subCauses: [], status: "pending" };
                              const updated = [...(currentStepData.refinedCauses || []), newCause];
                              const next = { ...currentStepData, refinedCauses: updated };
                              setFishboneStep({ ...fishboneStep!, data: next });
                              setIsDirty(true);
                              saveInteractiveStepMut.mutate(next);
                            }}
                            className="w-full text-sm text-primary/80 hover:text-primary py-4 font-mono flex items-center justify-center gap-2 transition-all border-2 border-dashed border-border/40 rounded-xl hover:border-primary/30"
                          >
                            <Plus className="w-4 h-4" /> Add Cause to Category
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Agent Question */}
                    {viewingPastFishboneStep === null && currentStepData.question && (
                      <div className="bg-primary/5 border-2 border-primary/20 rounded-xl p-5">
                        <span className="font-bold text-xs uppercase tracking-wider text-primary block mb-2">● Agent Verification Question</span>
                        <p className="text-sm text-foreground leading-relaxed">{currentStepData.question}</p>
                      </div>
                    )}

                    {/* Operator Instruction */}
                    {viewingPastFishboneStep === null && currentStepData.operatorInstruction && (
                      <div className="bg-blue-500/5 border-2 border-blue-500/20 rounded-xl p-5 text-sm text-blue-400 font-mono">
                        <span className="font-bold text-xs uppercase tracking-wider block mb-2">● Required Action</span>
                        {currentStepData.operatorInstruction}
                      </div>
                    )}
                    {/* Approve button for current step  */}
                    {viewingPastFishboneStep === null && (
                      <div className="flex gap-3 pt-3 border-t-2 border-border/40">
                        <Button
                          onClick={() => {
                            const lines = [`Drill-down review for ${currentStepData.activeCategory} complete. Status updates:`];
                            if (currentStepData.refinedCauses) {
                              currentStepData.refinedCauses.forEach((rc: any) => {
                                lines.push(`- ${rc.cause}: ${rc.status}`);
                              });
                            }
                            lines.push("Proceed to next drill-down or scoring review.");
                            const msg = selectedFishboneAnswer.trim() 
                              ? `${lines.join("\n")}\n\nAdditional notes: ${selectedFishboneAnswer}` 
                              : lines.join("\n");
                            submitFishboneResponse(msg);
                          }}
                          disabled={sendMut.isPending}
                          className="text-sm px-6 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          Approve Causes & Proceed
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => submitFishboneResponse(`Skip ${currentStepData.activeCategory} and proceed.`)}
                          disabled={sendMut.isPending}
                          className="text-sm px-4 py-3"
                        >
                          Skip This Category
                        </Button>
                      </div>
                    )}
                  </div>
                  );
                })()}

                {currentStepType === "scoring_review" && (
                  <div className="space-y-3">
                    <span className="text-xs text-muted-foreground font-mono">CONFIRMED CAUSES SUMMARY FOR REVIEW:</span>
                    <div className="grid grid-cols-2 gap-3 text-[11px]">
                      {currentStepData.fullCauseSummary && Object.entries(currentStepData.fullCauseSummary).map(([cat, causes]: any) => (
                        <div key={cat} className="p-2.5 border border-border bg-background/50 rounded-lg">
                          <span className="font-bold uppercase text-primary text-[9px] block mb-1">{cat}</span>
                          <ul className="list-disc pl-3.5 space-y-0.5 text-muted-foreground">
                            {Array.isArray(causes) && causes.map((c: string, cidx: number) => <li key={cidx}>{c}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button size="sm" onClick={() => submitFishboneResponse("Proceed with scoring.")} disabled={sendMut.isPending}>
                        Confirm & Score Causes
                      </Button>
                    </div>
                  </div>
                )}

                {currentStepType === "final" && (() => {
                  const [activeEditCat, setActiveEditCat] = useState("manpower");
                  const causes = fishboneCategories[activeEditCat] || [];

                  return (
                    <div className="space-y-4">
                      <div className="bg-secondary/30 border border-border/50 rounded-xl p-4">
                        <div className="text-xs text-muted-foreground font-mono mb-2">// SELECT CATEGORY TO EDIT:</div>
                        <div className="flex flex-wrap gap-2">
                          {["manpower", "machine", "methods", "materials", "measurements", "environment"].map((cat) => {
                            const isSelected = activeEditCat === cat;
                            return (
                              <button
                                key={cat}
                                onClick={() => setActiveEditCat(cat)}
                                type="button"
                                className={`text-xs px-3 py-1 font-mono rounded-lg border transition-all ${
                                  isSelected
                                    ? "bg-primary/20 text-primary border-primary/40 font-bold"
                                    : "bg-transparent text-muted-foreground border-border hover:bg-secondary"
                                }`}
                              >
                                {cat.toUpperCase()}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Cause List for {activeEditCat.toUpperCase()}</span>
                          <span className="text-xs text-primary font-mono bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
                            Edit causes inline · Set status to approve
                          </span>
                        </div>

                        <div className="space-y-3">
                          {causes.map((c: any, cIdx: number) => {
                            const name = typeof c === "string" ? c : c.cause || "";
                            const status = typeof c === "object" ? c.status || "confirmed" : "confirmed";
                            const weight = typeof c === "object" ? (c.weight !== undefined ? c.weight : 50) : 50;
                            const likelihood = typeof c === "object" ? c.likelihood : "Medium";
                            const subCauses = typeof c === "object" ? c.subCauses || [] : [];

                            const updateCauseValue = (key: string, val: any) => {
                              const updated = causes.map((item: any, idx: number) => {
                                if (idx === cIdx) {
                                  const base = typeof item === "string" ? { cause: item, status: "confirmed", weight: 50, likelihood: "Medium" } : item;
                                  return { ...base, [key]: val };
                                }
                                return item;
                              });
                              const updatedCats = { ...fishboneCategories, [activeEditCat]: updated };
                              setFishboneCategories(updatedCats);
                              setIsDirty(true);
                              
                              const updatedStepData = { ...currentStepData, fishbone: updatedCats };
                              setFishboneStep({ ...fishboneStep!, data: updatedStepData });
                              saveInteractiveStepMut.mutate(updatedStepData);
                            };

                            const removeCauseValue = () => {
                              const updated = causes.filter((_, idx) => idx !== cIdx);
                              const updatedCats = { ...fishboneCategories, [activeEditCat]: updated };
                              setFishboneCategories(updatedCats);
                              setIsDirty(true);
                              
                              const updatedStepData = { ...currentStepData, fishbone: updatedCats };
                              setFishboneStep({ ...fishboneStep!, data: updatedStepData });
                              saveInteractiveStepMut.mutate(updatedStepData);
                            };

                            return (
                              <div key={cIdx} className="p-5 border-2 border-border/50 rounded-xl bg-background/70 space-y-4 hover:border-primary/30 transition-all">
                                <div className="flex items-start gap-3">
                                  <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => updateCauseValue("cause", e.target.value)}
                                    className="flex-1 bg-transparent border border-border/30 rounded-lg p-3 text-sm font-semibold text-foreground focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none transition-all"
                                    placeholder="Cause description..."
                                  />
                                  <div className="flex flex-col items-center gap-1 shrink-0">
                                    <select
                                      value={status}
                                      onChange={(e) => updateCauseValue("status", e.target.value)}
                                      className={`text-xs font-mono uppercase p-2 rounded-lg border w-[140px] cursor-pointer ${
                                        status === "confirmed" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" :
                                        status === "refuted" ? "bg-red-500/20 text-red-400 border-red-500/40" :
                                        "bg-amber-500/20 text-amber-400 border-amber-500/20"
                                      }`}
                                    >
                                      <option value="pending">⏳ Pending</option>
                                      <option value="confirmed">✓ Confirmed</option>
                                      <option value="refuted">✕ Refuted</option>
                                      <option value="pending_verification">⏳ Pending Verify</option>
                                    </select>
                                  </div>
                                </div>

                                <div className="flex gap-2 pt-1 border-t border-border/20">
                                  <button
                                    onClick={() => updateCauseValue("status", "confirmed")}
                                    type="button"
                                    className={`text-sm px-4 py-2 rounded-lg transition-all font-mono border ${
                                      status === "confirmed"
                                        ? "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
                                        : status === "refuted"
                                          ? "bg-transparent text-muted-foreground/40 border-border/40 opacity-40 cursor-not-allowed"
                                          : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
                                    }`}
                                    disabled={status === "refuted"}
                                  >
                                    {status === "confirmed" ? "✓ Confirmed" : "✓ Confirm"}
                                  </button>
                                  <button
                                    onClick={() => updateCauseValue("status", "refuted")}
                                    type="button"
                                    className={`text-sm px-4 py-2 rounded-lg transition-all font-mono border ${
                                      status === "refuted"
                                        ? "bg-rose-600 text-white border-rose-600 hover:bg-rose-700"
                                        : status === "confirmed"
                                          ? "bg-transparent text-muted-foreground/40 border-border/40 opacity-40 cursor-not-allowed"
                                          : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25"
                                    }`}
                                    disabled={status === "confirmed"}
                                  >
                                    {status === "refuted" ? "✕ Refuted" : "✕ Refute"}
                                  </button>
                                  <button
                                    onClick={removeCauseValue}
                                    type="button"
                                    className="text-sm px-4 py-2 rounded-lg bg-muted/80 text-muted-foreground border border-border hover:bg-secondary transition-all font-mono"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            );
                          })}

                          <button
                            onClick={() => {
                              const newCause = { cause: "New cause", subCauses: [], status: "pending", weight: 50, likelihood: "Medium" };
                              const updatedCats = { ...fishboneCategories, [activeEditCat]: [...causes, newCause] };
                              setFishboneCategories(updatedCats);
                              setIsDirty(true);
                              
                              const updatedStepData = { ...currentStepData, fishbone: updatedCats };
                              setFishboneStep({ ...fishboneStep!, data: updatedStepData });
                              saveInteractiveStepMut.mutate(updatedStepData);
                            }}
                            type="button"
                            className="w-full text-sm text-primary/80 hover:text-primary py-4 font-mono flex items-center justify-center gap-2 transition-all border-2 border-dashed border-border/40 rounded-xl hover:border-primary/30"
                          >
                            <Plus className="w-4 h-4" /> Add Cause to {activeEditCat.toUpperCase()}
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2 pt-2.5 border-t border-border/40">
                        <Button
                          size="sm"
                          onClick={() => {
                            saveFishbone();
                            toast.success("Findings saved successfully!");
                          }}
                          disabled={updateAgentMsgMut.isPending}
                        >
                          {updateAgentMsgMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileCheck2 className="w-4 h-4 mr-2" />}
                          Save Changes to Database
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setShowInteractiveGuideOverride(false)}
                        >
                          Back to Diagram
                        </Button>
                      </div>
                    </div>
                  );
                })()}

                {currentStepType !== "final" && (
                  <div className="space-y-2 pt-2.5 border-t border-border/40">
                    {(sendMut.isPending || streamingChatText !== null) ? (
                      <div className="flex flex-col items-center justify-center p-6 bg-background/50 border border-dashed border-border rounded-lg space-y-3">
                        <Loader2 className="w-6 h-6 animate-spin text-primary" />
                        <p className="text-xs text-muted-foreground font-mono italic">
                          Fishbone agent is analyzing evidence and drafting the next step...
                        </p>
                      </div>
                    ) : (
                      <>
                        <p className="text-xs text-foreground font-bold leading-relaxed">{currentStepData.question || "Proposing next analysis step..."}</p>
                        
                        <div className="flex gap-2 items-end">
                          <div className="flex-1">
                            <Textarea
                              value={selectedFishboneAnswer}
                              onChange={(e) => setSelectedFishboneAnswer(e.target.value)}
                              placeholder="Provide details, override proposal, or answer the question..."
                              className="w-full text-xs font-mono p-3 min-h-[70px] bg-background border border-border rounded-lg"
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  submitFishboneResponse();
                                }
                              }}
                            />
                          </div>
                          <Button
                            size="sm"
                            className="px-4 py-2.5 h-[40px] shrink-0"
                            onClick={() => submitFishboneResponse()}
                            disabled={!selectedFishboneAnswer.trim()}
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        }

        const topCats = allCategories.slice(0, Math.ceil(allCategories.length / 2));
        const bottomCats = allCategories.slice(Math.ceil(allCategories.length / 2));

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Ishikawa Fishbone Diagram</h3>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Custom Category..."
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  className="text-xs p-1 h-8 font-mono bg-background border border-border rounded text-foreground"
                />
                <Button size="sm" variant="outline" onClick={addCustomCat}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Category
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowInteractiveGuideOverride(true)}
                  className="border-primary/40 text-primary hover:bg-primary/5 font-semibold"
                >
                  <Edit className="w-3.5 h-3.5 mr-1.5" />
                  Edit Findings
                </Button>
                <Button size="sm" onClick={saveFishbone} disabled={updateAgentMsgMut.isPending}>
                  {updateAgentMsgMut.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Findings"
                  )}
                </Button>
              </div>
            </div>

            <div className="bg-secondary/20 border border-border/50 rounded-xl p-4 overflow-x-auto relative">
              <div className="min-w-[800px] h-[360px] relative">
                <svg className="w-full h-full" viewBox="0 0 800 360">
                  <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
                    </marker>
                  </defs>

                  <line x1="50" y1="180" x2="720" y2="180" stroke="currentColor" strokeWidth="4" className="text-primary" markerEnd="url(#arrow)" />
                  <rect x="720" y="140" width="70" height="80" rx="10" fill="currentColor" className="text-primary/10 stroke-primary" strokeWidth="2" />
                  <text x="755" y="185" textAnchor="middle" className="text-[10px] font-bold font-mono fill-primary uppercase">// EFFECT</text>

                  {topCats.map((cat, idx) => {
                    const xStart = 150 + idx * 180;
                    const xEnd = xStart + 80;
                    return (
                      <g key={cat}>
                        <line x1={xStart} y1="40" x2={xEnd} y2="180" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/60" />
                        <rect x={xStart - 40} y="15" width="100" height="22" rx="4" fill="var(--color-card)" stroke="currentColor" className="text-border" strokeWidth="1" />
                        <text x={xStart + 10} y="30" textAnchor="middle" className="text-[9px] font-bold uppercase fill-primary">{cat}</text>
                      </g>
                    );
                  })}

                  {bottomCats.map((cat, idx) => {
                    const xStart = 150 + idx * 180;
                    const xEnd = xStart + 80;
                    return (
                      <g key={cat}>
                        <line x1={xStart} y1="320" x2={xEnd} y2="180" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/60" />
                        <rect x={xStart - 40} y="325" width="100" height="22" rx="4" fill="var(--color-card)" stroke="currentColor" className="text-border" strokeWidth="1" />
                        <text x={xStart + 10} y="340" textAnchor="middle" className="text-[9px] font-bold uppercase fill-primary">{cat}</text>
                      </g>
                    );
                  })}
                </svg>

                <div className="absolute right-20 top-[110px] w-64 bg-background/90 border border-destructive/40 p-2.5 rounded-lg shadow-lg text-[11px]">
                  <span className="text-destructive font-mono uppercase font-bold tracking-wide">// Incident Spine Head</span>
                  <p className="font-semibold text-foreground truncate mt-1">{editProblemStatement || parsedData.problemStatement || "System anomaly event"}</p>
                </div>
              </div>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {allCategories.map((cat) => {
                const causes = fishboneCategories[cat] || [];
                return (
                  <div key={cat} className="bg-background/80 border border-border/60 rounded-xl p-4 flex flex-col hover:border-primary/50 transition-all">
                    <div className="flex items-center justify-between border-b border-border/40 pb-2 mb-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">{cat}</span>
                      <Button size="sm" variant="ghost" className="h-6 font-mono text-[9px]" onClick={() => addCause(cat)}>
                        <Plus className="w-2.5 h-2.5 mr-1" /> Add Cause
                      </Button>
                    </div>

                    <div className="space-y-3 flex-1">
                      {causes.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic font-mono">// No causes logged under this bone</p>
                      ) : (
                        causes.map((c: any, i: number) => {
                          const name = typeof c === "string" ? c : c.cause || "";
                          const likelihood = typeof c === "object" ? c.likelihood : "Medium";
                          const weight = typeof c === "object" ? (c.weight !== undefined ? c.weight : 50) : 50;
                          
                          let heatColor = "border-emerald-500/40 bg-emerald-500/5 text-emerald-400";
                          if (weight > 30 && weight <= 70) heatColor = "border-amber-500/40 bg-amber-500/5 text-amber-400";
                          if (weight > 70) heatColor = "border-rose-500/40 bg-rose-500/5 text-rose-400";

                          const mapsToRoot = fiveWhys.some(w => w.isValidRootCause && (w.answer?.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(w.answer?.toLowerCase())));

                          return (
                            <div key={i} className={`p-2.5 border rounded-lg space-y-1.5 transition-all text-xs ${heatColor} ${mapsToRoot ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
                              <div className="flex justify-between items-start gap-1">
                                <input
                                  type="text"
                                  value={name}
                                  onChange={(e) => updateCause(cat, i, "cause", e.target.value)}
                                  className="w-full bg-transparent border-0 p-0 text-xs font-medium focus:ring-0 focus:outline-none text-foreground"
                                />
                                <button onClick={() => deleteCause(cat, i)} className="text-muted-foreground hover:text-red-500 p-0.5">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>

                              <div className="flex items-center justify-between gap-1 pt-1.5 border-t border-border/20 text-[9px] mono">
                                <div className="flex items-center gap-1">
                                  <span>Wt:</span>
                                  <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={weight}
                                    onChange={(e) => updateCause(cat, i, "weight", parseInt(e.target.value))}
                                    className="w-14 accent-primary h-1 p-0"
                                  />
                                  <span>{weight}%</span>
                                </div>
                                <select
                                  value={likelihood}
                                  onChange={(e) => updateCause(cat, i, "likelihood", e.target.value)}
                                  className="p-0 text-[8px] bg-background border border-border rounded text-foreground"
                                >
                                  <option value="Low">Low</option>
                                  <option value="Medium">Medium</option>
                                  <option value="High">High</option>
                                </select>
                                <select
                                  onChange={(e) => moveCause(cat, e.target.value, i)}
                                  className="p-0 text-[8px] bg-background border border-border rounded text-foreground"
                                  defaultValue=""
                                >
                                  <option value="" disabled>Move...</option>
                                  {allCategories.filter(x => x !== cat).map(x => (
                                    <option key={x} value={x}>{x}</option>
                                  ))}
                                </select>
                              </div>

                              {mapsToRoot && (
                                <Badge className="bg-primary/20 text-primary border-primary/40 font-mono text-[8px] mt-1">
                                  MAPS TO Root Cause
                                </Badge>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Fishbone Iterative Q&A */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE FISHBONE DIAGRAM</p>
                <span className="text-[10px] text-muted-foreground font-mono">Ask to add causes, adjust weights, move categories, or explain findings</span>
              </div>
              {renderIterativePanel("e.g. \"Add a cause under Machine for bearing failure\", or \"Why is this cause weighted higher than others?\"...")}
            </div>
          </div>
        );
      }

      case "fault_tree": {
        if (!faultTree) return null;

        if (!faultTree) {
          return (
            <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-6 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary animate-pulse">
                <Layers className="w-8 h-8" />
              </div>
              <div className="space-y-2 max-w-sm">
                <h4 className="text-sm font-bold mono uppercase">// FAULT TREE PENDING</h4>
                <p className="text-xs text-muted-foreground">The Fault Tree agent hasn't generated a tree yet. Click "Run Analysis" above to generate the initial fault tree diagram, or use the Chat Console to ask the FTA agent to begin.</p>
              </div>
            </div>
          );
        }

        const updateFTNode = (nodeId: string, key: string, value: any) => {
          const deepUpdate = (currNode: any): any => {
            if (currNode.id === nodeId) {
              return { ...currNode, [key]: value };
            }
            if (currNode.children) {
              return { ...currNode, children: currNode.children.map((c: any) => deepUpdate(c)) };
            }
            return currNode;
          };
          setFaultTree(deepUpdate(faultTree));
          setIsDirty(true);
        };

        const addFTNode = (parentId: string, type: "gate" | "event") => {
          const newId = `ft-${Date.now()}`;
          const newNode = {
            id: newId,
            label: type === "gate" ? "AND Gate" : "New Basic Event",
            type,
            gateType: "OR",
            probability: type === "event" ? 0.05 : 0.0,
            children: []
          };

          const deepAdd = (currNode: any): any => {
            if (currNode.id === parentId) {
              return { ...currNode, children: [...(currNode.children || []), newNode] };
            }
            if (currNode.children) {
              return { ...currNode, children: currNode.children.map((c: any) => deepAdd(c)) };
            }
            return currNode;
          };
          setFaultTree(deepAdd(faultTree));
          setIsDirty(true);
          toast.success("Child node added!");
        };

        const deleteFTNode = (nodeId: string) => {
          if (nodeId === "top-event") {
            toast.error("Cannot delete top event");
            return;
          }
          const deepRemove = (currNode: any): any => {
            if (currNode.children) {
              const filtered = currNode.children.filter((c: any) => c.id !== nodeId);
              return {
                ...currNode,
                children: filtered.map((c: any) => deepRemove(c))
              };
            }
            return currNode;
          };
          setFaultTree(deepRemove(faultTree));
          setIsDirty(true);
          toast.info("Node deleted.");
        };

        const saveFaultTree = () => {
          const updatedPayload = {
            ...parsedData,
            tree: faultTree,
            topEvent: faultTree.label,
            gateType: faultTree.gateType
          };
          updateAgentMsgMut.mutate(updatedPayload);
        };

        const calculateProbabilities = (node: any): any => {
          if (!node) return null;
          if (node.type === "event") {
            return node;
          }

          const calculatedChildren = (node.children || []).map((c: any) => calculateProbabilities(c));
          
          let prob = 0.0;
          if (calculatedChildren.length > 0) {
            const childProbs = calculatedChildren.map((c: any) => c.probability || 0.0);
            if (node.gateType === "AND") {
              prob = childProbs.reduce((acc: number, p: number) => acc * p, 1.0);
            } else if (node.gateType === "OR") {
              prob = 1.0 - childProbs.reduce((acc: number, p: number) => acc * (1.0 - p), 1.0);
            } else if (node.gateType === "NOT") {
              prob = 1.0 - (childProbs[0] || 0.0);
            }
          }

          return {
            ...node,
            probability: parseFloat(prob.toFixed(4)),
            children: calculatedChildren
          };
        };

        const computedTree = calculateProbabilities(faultTree);

        const computeSensitivity = (node: any, topProb: number, list: any[] = []) => {
          if (!node) return;
          if (node.type === "event") {
            const fv = topProb > 0 ? (node.probability / topProb) : 0.0;
            list.push({ label: node.label, probability: node.probability, fv: parseFloat((fv * 100).toFixed(1)) });
          }
          if (node.children) {
            node.children.forEach((c: any) => computeSensitivity(c, topProb, list));
          }
          return list;
        };

        const topProb = computedTree?.probability || 0.01;
        const sensitivityList = computeSensitivity(computedTree, topProb)?.sort((a, b) => b.fv - a.fv) || [];

        const computeCutSets = (node: any): string[][] => {
          if (!node) return [];
          if (node.type === "event") return [[node.label]];
          
          const childCutSets = (node.children || []).map((c: any) => computeCutSets(c));
          if (childCutSets.length === 0) return [];

          if (node.gateType === "OR") {
            return childCutSets.flat(1);
          } else if (node.gateType === "AND") {
            const combined: string[] = [];
            childCutSets.forEach((sets: string[][]) => {
              sets.forEach((s: string[]) => combined.push(...s));
            });
            return [Array.from(new Set(combined))];
          }
          return [];
        };

        const cutSets = computeCutSets(computedTree);

        const renderTreeSvg = (node: any, x: number, y: number, spread: number): React.ReactNode => {
          const children = node.children || [];
          const childCount = children.length;
          
          let borderCol = "stroke-emerald-500 fill-emerald-500/10";
          if (node.probability > 0.05 && node.probability <= 0.2) borderCol = "stroke-amber-500 fill-amber-500/10";
          if (node.probability > 0.2) borderCol = "stroke-red-500 fill-red-500/10";

          return (
            <g key={node.id}>
              {childCount > 0 && children.map((child: any, i: number) => {
                const childSpread = spread / Math.max(1, childCount * 0.7);
                const cx = x + (i - (childCount - 1) / 2) * spread;
                const cy = y + 100;
                return (
                  <g key={child.id}>
                    <line x1={x} y1={y + 30} x2={cx} y2={cy - 30} stroke="currentColor" strokeWidth="2" className="text-border" />
                    {renderTreeSvg(child, cx, cy, childSpread)}
                  </g>
                );
              })}

              <g transform={`translate(${x - 75}, ${y - 30})`} className="cursor-pointer" onClick={() => setSelectedFTAEvent(node)}>
                <rect width="150" height="60" rx="6" className={`${borderCol}`} strokeWidth="2.5" />
                
                {node.type === "gate" && (
                  <g transform="translate(10, 32)">
                    <circle cx="8" cy="8" r="7" className="fill-secondary stroke-primary" strokeWidth="1.5" />
                    <text x="8" y="11" textAnchor="middle" className="text-[8px] font-bold font-mono fill-primary">
                      {node.gateType === "AND" ? "└" : node.gateType === "OR" ? "⌣" : "⊘"}
                    </text>
                  </g>
                )}

                <text x="75" y="16" textAnchor="middle" className="text-[9px] fill-muted-foreground font-mono font-bold uppercase truncate w-[130px]">
                  {node.type === "gate" ? `${node.gateType} GATE` : "EVENT"}
                </text>
                
                <text x="75" y="32" textAnchor="middle" className="text-[10px] font-bold fill-foreground truncate w-[130px]">
                  {node.label}
                </text>
                
                <text x="75" y="48" textAnchor="middle" className="text-[9px] font-mono fill-primary font-semibold">
                  P: {(node.probability * 100).toFixed(2)}%
                </text>
              </g>
            </g>
          );
        };

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Logical Fault Tree Analysis (FTA)</h3>
              <Button size="sm" onClick={saveFaultTree} disabled={updateAgentMsgMut.isPending}>
                {updateAgentMsgMut.isPending ? "Saving..." : "Save Findings"}
              </Button>
            </div>

            <div className="bg-secondary/20 border border-border/50 rounded-xl p-4 overflow-auto flex justify-center">
              <div className="min-w-[800px] h-[340px] relative">
                <svg className="w-full h-full" viewBox="0 0 800 340">
                  {computedTree && renderTreeSvg(computedTree, 400, 45, 260)}
                </svg>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-4">
                <span className="text-xs text-primary font-bold mono">// ACTIVE EVENT EDITOR</span>
                {selectedFTAEvent ? (
                  <div className="space-y-3 text-xs">
                    <div>
                      <span className="text-[10px] text-muted-foreground font-mono block">NODE ID: {selectedFTAEvent.id}</span>
                      <label className="text-[10px] text-muted-foreground font-mono block mt-2">EVENT TITLE</label>
                      <input
                        type="text"
                        value={selectedFTAEvent.label}
                        onChange={(e) => updateFTNode(selectedFTAEvent.id, "label", e.target.value)}
                        className="w-full text-xs font-semibold p-1.5 bg-background border border-border rounded text-foreground"
                      />
                    </div>

                    {selectedFTAEvent.type === "gate" ? (
                      <div>
                        <label className="text-[10px] text-muted-foreground font-mono block">GATE LOGIC TYPE</label>
                        <select
                          value={selectedFTAEvent.gateType}
                          onChange={(e) => updateFTNode(selectedFTAEvent.id, "gateType", e.target.value)}
                          className="w-full p-1.5 text-xs font-mono bg-background border border-border rounded text-foreground"
                        >
                          <option value="OR">OR Gate (Any input causes event)</option>
                          <option value="AND">AND Gate (All inputs required)</option>
                          <option value="NOT">NOT Gate (Inversion gate)</option>
                        </select>
                      </div>
                    ) : (
                      <div>
                        <label className="text-[10px] text-muted-foreground font-mono block">FAILURE PROBABILITY (0 - 1)</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={selectedFTAEvent.probability}
                            onChange={(e) => updateFTNode(selectedFTAEvent.id, "probability", parseFloat(e.target.value))}
                            className="flex-1 accent-primary"
                          />
                          <span className="font-mono text-primary font-bold">{selectedFTAEvent.probability}</span>
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2 pt-3 border-t border-border/20">
                      {selectedFTAEvent.type === "gate" && (
                        <>
                          <Button size="sm" onClick={() => addFTNode(selectedFTAEvent.id, "event")}>
                            <Plus className="w-3.5 h-3.5 mr-1" /> Event
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => addFTNode(selectedFTAEvent.id, "gate")}>
                            <Plus className="w-3.5 h-3.5 mr-1" /> Gate
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="destructive" onClick={() => deleteFTNode(selectedFTAEvent.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic font-mono">// Click on any node in the SVG diagram above to configure logic parameters.</p>
                )}
              </div>

              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-3">
                <span className="text-xs text-primary font-bold mono">// MINIMAL CUT SETS ANALYSIS</span>
                <p className="text-[10px] text-muted-foreground">Sets of basic failures that independently trigger the Top Event:</p>
                <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                  {cutSets.map((set, i) => (
                    <div key={i} className="p-2 rounded bg-background/50 border border-border/40 text-xs font-mono">
                      <span className="text-primary font-bold">Cutset {i+1}: </span>
                      <span>{set.join(" AND ")}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-3">
                <span className="text-xs text-primary font-bold mono">// SENSITIVITY (FUSSELL-VESELY)</span>
                <p className="text-[10px] text-muted-foreground">Importance measure representing contribution to overall risk:</p>
                <div className="space-y-2 max-h-[160px] overflow-y-auto">
                  {sensitivityList.map((item, i) => (
                    <div key={i} className="flex justify-between items-center text-xs font-mono">
                      <span className="truncate flex-1 text-muted-foreground pr-2">• {item.label}</span>
                      <span className="font-bold text-primary">{item.fv}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Iterative Q&A Panel */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// RECENT AGENT RESPONSES</p>
              </div>
              {messages.filter((m: any) => m.role === "assistant").slice(-3).map((m: any, i: number) => {
                const parsed = parseMaybeJson(m.content);
                return (
                  <div key={i} className="p-3 border-b border-border/20 text-xs">
                    {parsed?.tree ? (
                      <p className="text-muted-foreground font-mono">// Fault tree diagram updated ✓</p>
                    ) : (
                      <p className="text-muted-foreground whitespace-pre-wrap">{m.content.slice(0, 300)}{m.content.length > 300 ? '...' : ''}</p>
                    )}
                  </div>
                );
              })}
              {renderIterativePanel("Ask the Fault Tree agent to add events, modify probabilities, or explain the logic tree structure...")}
            </div>
          </div>
        );
      }

       case "pareto": {
        let pareto = {};
        let byFailureMode = [];

        // Normalize: try multiple possible AI response formats
        if (parsedData.paretoAnalysis?.byFailureMode) {
          pareto = parsedData.paretoAnalysis;
          byFailureMode = parsedData.paretoAnalysis.byFailureMode;
        } else if (parsedData.paretoAndTrendAnalysis?.paretoAnalysis?.byFailureType?.categories) {
          byFailureMode = parsedData.paretoAndTrendAnalysis.paretoAnalysis.byFailureType.categories.map((c: any) => ({
            mode: c.name || c.label || c.category || c.mode || "Unknown",
            frequency: c.frequency || c.count || c.value || 0,
          }));
        } else if (parsedData.paretoAndTrendAnalysis?.paretoAnalysis?.byFailureMode) {
          byFailureMode = parsedData.paretoAndTrendAnalysis.paretoAnalysis.byFailureMode;
        }

        pareto = { byFailureMode, ...pareto };

        const sortedModes = [...byFailureMode].sort((a, b) => b.frequency - a.frequency);
        
        let cumulativeSum = 0;
        const totalFreq = sortedModes.reduce((sum, item) => sum + (item.frequency || 0), 0);
        
        const chartData = sortedModes.map((item, idx) => {
          cumulativeSum += item.frequency;
          const cumPercent = totalFreq > 0 ? parseFloat(((cumulativeSum / totalFreq) * 100).toFixed(1)) : 0;
          return {
            mode: item.mode,
            frequency: item.frequency,
            percentage: totalFreq > 0 ? parseFloat(((item.frequency / totalFreq) * 100).toFixed(1)) : 0,
            cumulative: cumPercent
          };
        });

        const vitalFew = chartData.filter(d => d.cumulative - d.percentage < paretoThreshold).map(d => d.mode);

        const weeks = ["Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Week 6"];
        const trendChartData = weeks.map((w, index) => {
          const row: Record<string, any> = { name: w };
          chartData.forEach(d => {
            const base = d.frequency / 6;
            const trend = (index - 2.5) * (base * 0.12);
            const variance = Math.sin(index + d.mode.length) * (base * 0.15);
            row[d.mode] = Math.max(0, Math.round(base + trend + variance));
          });
          return row;
        });

        const downloadCSV = () => {
          let csv = "Rank,Failure Mode,Frequency,Percentage,Cumulative Percentage\n";
          chartData.forEach((row, i) => {
            csv += `${i + 1},"${row.mode}",${row.frequency},${row.percentage}%,${row.cumulative}%\n`;
          });
          const blob = new Blob([csv], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `pareto_analysis_case_${caseId}.csv`;
          link.click();
          toast.success("CSV export downloaded successfully!");
        };

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Pareto Analytics Dashboard</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={downloadCSV}>
                  <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
                </Button>
                <Button size="sm" onClick={() => {
                  const updatedPayload = {
                    ...parsedData,
                    paretoAnalysis: {
                      ...pareto,
                      vitalFew: vitalFew
                    }
                  };
                  updateAgentMsgMut.mutate(updatedPayload);
                }} disabled={updateAgentMsgMut.isPending}>
                  {updateAgentMsgMut.isPending ? "Saving..." : "Save Vital Few"}
                </Button>
              </div>
            </div>

            {/* Config & Vital Few Panel */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex gap-4 items-center">
                <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-500 shrink-0">
                  <Percent className="w-6 h-6 animate-pulse" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-amber-400 uppercase tracking-wide">// Calculated Vital Few ({paretoThreshold}% Cutoff)</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Addressing these key issues will eliminate {paretoThreshold}% of the recurring failures:
                  </p>
                  <p className="text-sm font-bold text-foreground mt-1.5">{vitalFew.join(", ") || "No modes met the threshold."}</p>
                </div>
              </div>

              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 space-y-3">
                <span className="text-xs text-primary font-bold mono block">// PARETO THRESHOLD ADJUSTER</span>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="70"
                    max="95"
                    step="1"
                    value={paretoThreshold}
                    onChange={(e) => setParetoThreshold(parseInt(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <span className="font-mono text-primary font-bold text-sm w-12">{paretoThreshold}%</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-[10px] text-muted-foreground">Select trend perspective:</span>
                  <button
                    onClick={() => setParetoMode("cluster")}
                    className={`text-[9px] px-2 py-0.5 rounded font-mono ${paretoMode === "cluster" ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}
                  >
                    Failure Clustering
                  </button>
                  <button
                    onClick={() => setParetoMode("trend")}
                    className={`text-[9px] px-2 py-0.5 rounded font-mono ${paretoMode === "trend" ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}
                  >
                    Time-Series Trend
                  </button>
                </div>
              </div>
            </div>

            {/* Recharts Chart representation */}
            <div className="bg-secondary/20 border border-border/50 rounded-xl p-4">
              <span className="text-xs text-muted-foreground mono block mb-4">// COMPOSED FREQUENCY AND CUMULATIVE PERCENTAGE OVERLAY</span>
              
              {paretoMode === "cluster" ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                      <XAxis dataKey="mode" className="text-[10px] fill-muted-foreground" />
                      <YAxis yAxisId="left" className="text-[10px] fill-muted-foreground" label={{ value: 'Frequency', angle: -90, position: 'insideLeft', style: { fill: 'var(--color-primary)' } }} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, 100]} className="text-[10px] fill-muted-foreground" label={{ value: 'Cumulative %', angle: 90, position: 'insideRight', style: { fill: 'var(--color-accent)' } }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-card)', borderColor: 'var(--color-border)' }} />
                      <Bar yAxisId="left" dataKey="frequency" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} barSize={35} />
                      <Line yAxisId="right" type="monotone" dataKey="cumulative" stroke="hsl(var(--accent))" strokeWidth={3} dot={{ r: 4 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trendChartData} margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                      <XAxis dataKey="name" className="text-[10px] fill-muted-foreground" />
                      <YAxis className="text-[10px] fill-muted-foreground" label={{ value: 'Occurrences', angle: -90, position: 'insideLeft', style: { fill: 'var(--color-primary)' } }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-card)', borderColor: 'var(--color-border)' }} />
                      <Legend wrapperStyle={{ fontSize: '9px', fontFamily: 'monospace' }} />
                      {chartData.map((d, i) => {
                        const hues = [25, 140, 200, 280, 340];
                        const hue = hues[i % hues.length];
                        return (
                          <Line
                            key={d.mode}
                            type="monotone"
                            dataKey={d.mode}
                            stroke={`hsl(${hue}, 80%, 55%)`}
                            strokeWidth={2.5}
                            activeDot={{ r: 5 }}
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Rank Ordered Table Grid */}
            <div className="bg-secondary/15 border border-border/40 rounded-xl overflow-hidden">
              <div className="p-3 border-b border-border/40 bg-secondary/25 text-xs font-mono font-bold text-muted-foreground uppercase flex justify-between">
                <span>RANKED FAILURE MODE DATA GRID</span>
                <span>TOTAL FREQUENCY: {totalFreq}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border/40 bg-secondary/5 text-muted-foreground font-mono">
                      <th className="p-3">Rank</th>
                      <th className="p-3">Failure Mode / Symptom</th>
                      <th className="p-3 text-right">Frequency (Qty)</th>
                      <th className="p-3 text-right">Percentage (%)</th>
                      <th className="p-3 text-right">Cumulative (%)</th>
                      <th className="p-3 text-center">Vital Classification</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    {chartData.map((row, i) => {
                      const isVital = vitalFew.includes(row.mode);
                      return (
                        <tr key={i} className="hover:bg-secondary/10 transition-colors">
                          <td className="p-3 font-mono font-bold text-muted-foreground">#{i + 1}</td>
                          <td className="p-3 font-semibold text-foreground">{row.mode}</td>
                          <td className="p-3 text-right font-mono font-semibold">{row.frequency}</td>
                          <td className="p-3 text-right font-mono text-muted-foreground">{row.percentage}%</td>
                          <td className="p-3 text-right font-mono text-primary font-bold">{row.cumulative}%</td>
                          <td className="p-3 text-center">
                            <Badge className={isVital ? "bg-amber-500/20 text-amber-400 border-amber-500/40" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"}>
                              {isVital ? "VITAL FEW" : "TRIVIAL MANY"}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pareto Iterative Q&A */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE PARETO ANALYSIS</p>
                <span className="text-[10px] text-muted-foreground font-mono">Ask the agent to add failure modes, adjust frequencies, or explain root patterns</span>
              </div>
              {renderIterativePanel("e.g. \"Add a failure mode: Lubrication failure with frequency 8\", or \"Which mode should be prioritised based on the 5-Why findings?\"...")}
            </div>
          </div>
        );
      }

       case "timeline": {
        let timeline: any = {};
        let phases: any[] = [];

        // Normalize: try multiple possible AI response formats
        if (parsedData.timeline?.phases) {
          timeline = parsedData.timeline;
          phases = parsedData.timeline.phases;
        } else if (parsedData.timelineAndEventCorrelation?.phases) {
          phases = parsedData.timelineAndEventCorrelation.phases;
          timeline = { phases };
        } else if (parsedData.timelineAndEventCorrelation?.timeline?.phases) {
          timeline = parsedData.timelineAndEventCorrelation.timeline;
          phases = timeline.phases;
        } else {
          timeline = parsedData.timeline || {};
        }

        phases = Array.isArray(phases) ? phases : [];

        const addPhase = () => {
          setNewPhaseName("New Phase");
          setNewPhaseStart("T-0");
          setNewPhaseDuration("5m");
          setNewPhaseDesc("Operational status details");
          setShowAddPhaseModal(true);
        };

        const submitAddPhase = () => {
          if (!newPhaseName.trim()) {
            toast.error("Phase name is required");
            return;
          }
          const newPhase = {
            phase: newPhaseName,
            start: newPhaseStart || "T-0",
            duration: newPhaseDuration || "5m",
            description: newPhaseDesc || "",
            events: []
          };
          const updatedPhases = [...phases, newPhase];
          const updatedPayload = {
            ...parsedData,
            timeline: {
              ...timeline,
              phases: updatedPhases
            }
          };
          updateAgentMsgMut.mutate(updatedPayload);
          setShowAddPhaseModal(false);
          toast.success("Timeline phase added!");
        };

        const editPhase = (index: number, key: string, value: string) => {
          const updated = phases.map((p: any, i: number) =>
            i === index ? { ...p, [key]: value } : p
          );
          updateAgentMsgMut.mutate({
            ...parsedData,
            timeline: { ...timeline, phases: updated }
          });
        };

        const deletePhase = (index: number) => {
          if (!confirm("Are you sure you want to delete this phase?")) return;
          const updatedPhases = phases.filter((_: any, i: number) => i !== index);
          const updatedPayload = {
            ...parsedData,
            timeline: {
              ...timeline,
              phases: updatedPhases
            }
          };
          updateAgentMsgMut.mutate(updatedPayload);
          toast.info("Timeline phase removed.");
        };

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Chronological sequence of events</h3>
              <div className="flex gap-2">
                <Button size="sm" onClick={addPhase}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Insert Phase
                </Button>
                <Button size="sm" variant="outline" onClick={() => updateAgentMsgMut.mutate(parsedData)} disabled={updateAgentMsgMut.isPending}>
                  {updateAgentMsgMut.isPending ? "Saving..." : "Save Sequence"}
                </Button>
              </div>
            </div>

            {/* Gantt-style Horizontal Lanes representation */}
            <div className="bg-secondary/20 border border-border/50 rounded-xl p-6 overflow-x-auto relative">
              <span className="text-xs text-muted-foreground mono block mb-4">// HORIZONTAL GANTT SEQUENCE VIEW</span>
              
              <div className="min-w-[700px] flex items-center gap-2 py-4">
                {phases.map((phase: any, idx: number) => {
                  let colorClass = "from-emerald-600/30 to-emerald-500/20 border-emerald-500/40 text-emerald-400";
                  if (phase.phase.toLowerCase().includes("trigger") || phase.phase.toLowerCase().includes("onset") || phase.phase.toLowerCase().includes("failure")) {
                    colorClass = "from-rose-600/30 to-rose-500/20 border-rose-500/40 text-rose-400";
                  } else if (phase.phase.toLowerCase().includes("recovery") || phase.phase.toLowerCase().includes("response")) {
                    colorClass = "from-blue-600/30 to-blue-500/20 border-blue-500/40 text-blue-400";
                  } else if (phase.phase.toLowerCase().includes("pre")) {
                    colorClass = "from-amber-600/30 to-amber-500/20 border-amber-500/40 text-amber-400";
                  }

                  return (
                    <div key={idx} className="flex-1 flex items-center relative">
                      <div className={`w-full p-4 rounded-xl border bg-gradient-to-br ${colorClass} hover:scale-[1.02] transition-transform`}>
                        <div className="flex justify-between items-start gap-1 mb-1">
                          <span className="text-xs font-bold uppercase tracking-wider">{phase.phase}</span>
                          <button onClick={() => deletePhase(idx)} className="opacity-60 hover:opacity-100 hover:text-red-400 transition-opacity">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex gap-2 text-[10px] mono opacity-80 mb-2">
                          <span>Start: {phase.start || phase.time}</span>
                          <span>|</span>
                          <span>Dur: {phase.duration}</span>
                        </div>
                        <p className="text-[11px] font-medium leading-relaxed truncate">{phase.description}</p>
                      </div>
                      {idx < phases.length - 1 && (
                        <div className="px-2 shrink-0">
                          <ArrowRight className="w-4 h-4 text-muted-foreground/60" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* List Chronological Timeline detail view */}
            <div className="relative border-l border-border/60 ml-4 pl-6 space-y-6 py-2">
              {phases.map((phase: any, idx: number) => {
                let dotColor = "bg-primary";
                if (phase.phase.toLowerCase().includes("pre")) dotColor = "bg-amber-500";
                if (phase.phase.toLowerCase().includes("trigger") || phase.phase.toLowerCase().includes("onset") || phase.phase.toLowerCase().includes("failure")) dotColor = "bg-rose-500";
                if (phase.phase.toLowerCase().includes("recovery") || phase.phase.toLowerCase().includes("response")) dotColor = "bg-blue-500";

                return (
                  <div key={idx} className="relative hover:bg-secondary/20 transition-all rounded-lg p-4 border border-transparent hover:border-border/30 bg-background/50">
                    <span className={`absolute -left-[31px] top-6 w-3.5 h-3.5 rounded-full border-2 border-background ${dotColor}`} />
                    <div className="flex justify-between items-start gap-2 mb-2">
                      <div className="flex-1">
                        <input
                          type="text"
                          value={phase.phase}
                          onChange={(e) => editPhase(idx, "phase", e.target.value)}
                          className="w-full bg-transparent border-0 p-0 text-sm font-bold uppercase tracking-wider text-primary focus:ring-0 focus:outline-none"
                        />
                      </div>
                      <button onClick={() => deletePhase(idx)} className="text-muted-foreground hover:text-red-500 transition-colors shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-2">
                      <div>
                        <label className="text-[10px] text-muted-foreground font-mono block mb-0.5">START TIME</label>
                        <input
                          type="text"
                          value={phase.start || phase.time || ""}
                          onChange={(e) => editPhase(idx, "start", e.target.value)}
                          className="w-full text-xs p-1.5 bg-background border border-border rounded text-foreground font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground font-mono block mb-0.5">DURATION</label>
                        <input
                          type="text"
                          value={phase.duration || ""}
                          onChange={(e) => editPhase(idx, "duration", e.target.value)}
                          className="w-full text-xs p-1.5 bg-background border border-border rounded text-foreground font-mono"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground font-mono block mb-0.5">DESCRIPTION</label>
                      <textarea
                        value={phase.description || ""}
                        onChange={(e) => editPhase(idx, "description", e.target.value)}
                        rows={2}
                        className="w-full text-xs p-1.5 bg-background border border-border rounded text-foreground resize-none"
                      />
                    </div>
                    {Array.isArray(phase.events) && phase.events.length > 0 && (
                      <div className="mt-3 space-y-1.5 pl-3 border-l border-primary/20">
                        <span className="text-[10px] text-muted-foreground font-mono block mb-1">SUB-EVENTS</span>
                        {phase.events.map((e: any, i: number) => (
                          <div key={i} className="text-xs flex items-start gap-1">
                            <span className="text-primary font-bold shrink-0">•</span>
                            <span className="text-muted-foreground">{typeof e === "string" ? e : e.desc || JSON.stringify(e)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {showAddPhaseModal && (
              <div className="fixed inset-0 bg-background/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-card border border-border rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl animate-in fade-in zoom-in duration-200">
                  <h3 className="font-bold text-base mono text-primary tracking-wide">// ADD TIMELINE PHASE</h3>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground font-mono">PHASE NAME</label>
                      <input
                        type="text"
                        value={newPhaseName}
                        onChange={(e) => setNewPhaseName(e.target.value)}
                        className="w-full text-xs font-mono p-2 bg-background border border-border rounded text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground font-mono">STARTING TIME / OFFSET</label>
                      <input
                        type="text"
                        value={newPhaseStart}
                        onChange={(e) => setNewPhaseStart(e.target.value)}
                        className="w-full text-xs font-mono p-2 bg-background border border-border rounded text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground font-mono">DURATION LABEL</label>
                      <input
                        type="text"
                        value={newPhaseDuration}
                        onChange={(e) => setNewPhaseDuration(e.target.value)}
                        className="w-full text-xs font-mono p-2 bg-background border border-border rounded text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground font-mono">DESCRIPTION</label>
                      <textarea
                        value={newPhaseDesc}
                        onChange={(e) => setNewPhaseDesc(e.target.value)}
                        className="w-full text-xs font-mono p-2 bg-background border border-border rounded text-foreground"
                        rows={3}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" size="sm" onClick={() => setShowAddPhaseModal(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={submitAddPhase}>
                      Add Phase
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Timeline Iterative Q&A */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE TIMELINE SEQUENCE</p>
                <span className="text-[10px] text-muted-foreground font-mono">Ask to add events, fix timestamps, or correlate with 5-Why findings</span>
              </div>
              {renderIterativePanel("e.g. \"Add a post-incident recovery event at T+30m\", or \"How does this timeline correlate with the root cause from 5-Why?\"...")}
            </div>
          </div>
        );
      }

      case "equipment": {
        const metrics = parsedData.reliabilityMetrics || {};
        const mtbf = metrics.mtbf?.value ?? (typeof metrics.mtbf === "string" ? metrics.mtbf : "--");
        const mttr = metrics.mttr?.value ?? (typeof metrics.mttr === "string" ? metrics.mttr : "--");
        const availability = metrics.availability?.value ?? (typeof metrics.availability === "string" ? metrics.availability : "--");
        const failureRate = metrics.failureRate?.value ?? (typeof metrics.failureRate === "string" ? metrics.failureRate : "--");

        const updateRPN = (component: string, score: number) => {
          const nextRPN = { ...equipmentRPN, [component]: score };
          setEquipmentRPN(nextRPN);
        };

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Equipment Reliability & Asset Diagnostics</h3>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => {
                  const updatedPayload = {
                    ...parsedData,
                    reliabilityMetrics: {
                      ...metrics,
                      rpnScores: equipmentRPN
                    }
                  };
                  updateAgentMsgMut.mutate(updatedPayload);
                  toast.success("Equipment RPN profiles updated!");
                }} disabled={updateAgentMsgMut.isPending}>
                  {updateAgentMsgMut.isPending ? "Saving..." : "Save Asset Profile"}
                </Button>
              </div>
            </div>

            {/* Dashboards and Reliability KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">MTBF (Mean Time Between Failures)</span>
                <p className="text-2xl font-black text-primary mt-1">{mtbf}</p>
                <span className="text-[9px] text-emerald-400 font-mono">{metrics.mtbf?.trend || "Calculated"}</span>
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">MTTR (Mean Time To Repair)</span>
                <p className="text-2xl font-black text-primary mt-1">{mttr}</p>
                <span className="text-[9px] text-amber-400 font-mono">{metrics.mttr?.trend || "Calculated"}</span>
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">Availability Rate</span>
                <p className="text-2xl font-black text-primary mt-1">{availability}</p>
                <span className="text-[9px] text-emerald-400 font-mono">{metrics.availability?.trend || "Calculated"}</span>
              </div>
              <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 text-center hover:border-primary/40 transition-colors">
                <span className="text-[10px] mono text-muted-foreground uppercase">RPN Cumulative Index</span>
                <p className="text-2xl font-black text-rose-500 mt-1">
                  {(Object.values(equipmentRPN) as number[]).reduce((a: number, b: number) => a + b, 0)}
                </p>
                <span className="text-[9px] text-muted-foreground font-mono">Aggregated Risk Factor</span>
              </div>
            </div>

            {/* Parent-Child Asset Tree / Hierarchy & Maintenance Timeline Overlay */}
            <div className="grid md:grid-cols-3 gap-6">
              <div className="bg-secondary/20 border border-border/50 rounded-xl p-4 space-y-4">
                <span className="text-xs text-primary font-bold mono block">// ASSET HIERARCHY TREE</span>
                <div className="space-y-3 text-xs font-mono">
                  <div className="p-2 border border-border bg-background/50 rounded-md">
                    <span className="font-bold text-foreground">Unit 3: Crude Distillation (Root)</span>
                    <div className="pl-4 mt-2 border-l-2 border-border/60 space-y-2">
                      <div className="p-1.5 border border-border bg-background/30 rounded">
                        <span className="font-semibold text-primary">V-102 Safety Valve (Safety)</span>
                        <div className="pl-4 mt-1 border-l-2 border-border/40 text-[10px] space-y-1">
                          <div>• Temperature Sensor Probe (Sub)</div>
                          <div>• Relief Spring Coil (Sub)</div>
                        </div>
                      </div>
                      <div className="p-1.5 border border-border bg-background/30 rounded text-muted-foreground">
                        <span>P-104 Feed Pump (Standby)</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Degradation Bathtub Curve Lifecycle & Trend Line */}
              <div className="bg-secondary/20 border border-border/50 rounded-xl p-4 space-y-3">
                <span className="text-xs text-primary font-bold mono block">// LIFECYCLE DEGRADATION (BATHTUB CURVE)</span>
                <div className="h-44 border border-border/40 rounded bg-background/30 relative flex items-end p-2 overflow-hidden">
                  <svg className="w-full h-full" viewBox="0 0 200 100">
                    {/* Bathtub curve line path */}
                    <path
                      d="M 10 10 Q 50 80 100 80 T 190 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="text-primary/70"
                    />
                    {/* Current operating position */}
                    <circle cx="120" cy="80" r="5" className="fill-rose-500 animate-ping" />
                    <circle cx="120" cy="80" r="4.5" className="fill-rose-500" />
                    <text x="125" y="75" className="text-[7px] font-mono fill-rose-400 font-bold">WEAR-OUT PHASE (ACTUAL)</text>
                  </svg>
                  <div className="absolute bottom-2 left-2 text-[8px] text-muted-foreground font-mono">
                    Infant Mortality → Useful Life → Wear-out
                  </div>
                </div>
              </div>

              {/* Spare Parts Inventory & Logistics Status */}
              <div className="bg-secondary/20 border border-border/50 rounded-xl p-4 space-y-3">
                <span className="text-xs text-primary font-bold mono block">// MAINTENANCE TIMELINE & PARTS STATUS</span>
                <div className="space-y-2 text-xs">
                  <div className="p-2 bg-background/50 border border-border/40 rounded flex justify-between items-center">
                    <div>
                      <p className="font-semibold">V-102 Replacement Spring</p>
                      <p className="text-[10px] text-muted-foreground">Storage: Warehouse A, Row 4</p>
                    </div>
                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[9px] font-mono">IN STOCK</Badge>
                  </div>
                  <div className="p-2 bg-background/50 border border-border/40 rounded flex justify-between items-center">
                    <div>
                      <p className="font-semibold">PTFE Seal Gasket</p>
                      <p className="text-[10px] text-muted-foreground">PO#98371, ETA 2 Days</p>
                    </div>
                    <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[9px] font-mono animate-pulse">ON ORDER</Badge>
                  </div>
                  <div className="p-2 bg-background/50 border-destructive/30 rounded flex justify-between items-center">
                    <div>
                      <p className="font-semibold text-destructive">Last Maintenance Date</p>
                      <p className="text-[10px] text-muted-foreground">272 Days Ago (Standard Cycle 180 Days)</p>
                    </div>
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[9px] font-mono">OVERDUE</Badge>
                  </div>
                </div>
              </div>
            </div>

            {/* Diagnostics Component RPN List & Risk Sliders */}
            <div className="bg-secondary/25 border border-border/60 rounded-xl p-5 space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider font-mono text-muted-foreground">// Subcomponent Diagnostics & RPN (Risk Priority Number) profiles</h4>
              <div className="grid md:grid-cols-3 gap-6">
                {[
                  { key: "probe", name: "Temperature Transducer Probe", health: "NOMINAL", desc: "Sensors checking nozzle temp." },
                  { key: "valve", name: "Safety Control Valve (V-102)", health: "FAULT DETECTED", desc: "Main mechanical valve stem actuator." },
                  { key: "controller", name: "Flow Controller Logic Loop", health: "WARNING (JITTER)", desc: "Software regulator checking stream velocities." }
                ].map((item) => {
                  const score = equipmentRPN[item.key] || 25;
                  
                  let scoreColor = "text-emerald-400";
                  if (score > 35 && score <= 70) scoreColor = "text-amber-400";
                  if (score > 70) scoreColor = "text-rose-500 font-bold";

                  return (
                    <div key={item.key} className="bg-background border border-border rounded-xl p-4 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="font-semibold text-xs text-foreground truncate w-[160px]">{item.name}</span>
                        <Badge className={`text-[8px] font-mono ${
                          item.health === "NOMINAL" 
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" 
                            : item.health.includes("FAULT") 
                              ? "bg-rose-500/10 text-rose-400 border-rose-500/30" 
                              : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                        }`}>
                          {item.health}
                        </Badge>
                      </div>
                      <p className="text-[10px] text-muted-foreground">{item.desc}</p>
                      
                      <div className="pt-2 border-t border-border/20 space-y-2">
                        <div className="flex justify-between text-[10px] font-mono">
                          <span>RPN Risk Score:</span>
                          <span className={scoreColor}>{score} / 100</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="100"
                          value={score}
                          onChange={(e) => updateRPN(item.key, parseInt(e.target.value))}
                          className="w-full accent-primary h-1 bg-secondary rounded"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Equipment Iterative Q&A */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE EQUIPMENT ANALYSIS</p>
                <span className="text-[10px] text-muted-foreground font-mono">Ask about maintenance history, degradation patterns, or RPN reasoning</span>
              </div>
              {renderIterativePanel("e.g. \"What maintenance schedule is recommended for V-102?\", or \"Why is the controller RPN higher than the probe?\"...")}
            </div>
          </div>
        );
      }

       case "report": {
        const defaultActions = [
          { id: "capa-1", desc: "Check safety lock constraints and verify manual controls are overridden.", owner: "Jane Doe (Maint)", date: "2026-05-25", status: "In Progress" },
          { id: "capa-2", desc: "Establish periodic inspection intervals for sensor suites and safety valves.", owner: "John Smith (Ops)", date: "2026-06-01", status: "Pending" }
        ];

        // Normalize: handle both standard and rcaReport wrapper formats
        let reportPayload: any = parsedData;
        if (parsedData.rcaReport) {
          reportPayload = { ...parsedData, ...parsedData.rcaReport };
        } else if (parsedData.reportAnalysis) {
          reportPayload = { ...parsedData, ...parsedData.reportAnalysis };
        }

        const initialActions = (reportPayload.correctiveActionsList && reportPayload.correctiveActionsList.length > 0)
          ? reportPayload.correctiveActionsList
          : defaultActions;

        const updateCapa = (id: string, key: string, val: any) => {
          const next = capaActions.map(act => act.id === id ? { ...act, [key]: val } : act);
          setCapaActions(next);
        };

        const addCapa = () => {
          const nextId = `capa-${Date.now()}`;
          const next = [...capaActions, { id: nextId, desc: "New CAPA details...", owner: "Operator", date: "2026-06-15", status: "Pending" }];
          setCapaActions(next);
        };

        const deleteCapa = (id: string) => {
          const next = capaActions.filter(act => act.id !== id);
          setCapaActions(next);
        };

        const saveReport = () => {
          const updatedPayload = {
            ...reportPayload,
            problemStatement: editProblemStatement,
            rootCause: editRootCauseText,
            correctiveActionsList: capaActions,
            checklist: capaChecklist,
            approved: reportApproved
          };
          updateAgentMsgMut.mutate(updatedPayload);
        };

        return (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h3 className="font-bold text-lg mono uppercase">// Root Cause Analysis (RCA) Executive Report</h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => window.print()}>
                  <FileText className="w-3.5 h-3.5 mr-1.5" /> Print/Export Report
                </Button>
                <Button size="sm" onClick={saveReport} disabled={updateAgentMsgMut.isPending}>
                  {updateAgentMsgMut.isPending ? "Saving..." : "Save Report Details"}
                </Button>
              </div>
            </div>

            {/* Workflow approval State */}
            <div className="bg-secondary/25 border border-border/50 rounded-xl p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <p className="text-xs font-semibold mono">// WORKFLOW APPROVAL STATE</p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className={reportApproved ? "bg-emerald-500/25 text-emerald-400 border-emerald-500/40" : "bg-amber-500/20 text-amber-400 border-amber-500/40"}>
                    {reportApproved ? "APPROVED & SIGNED" : "DRAFT STATE"}
                  </Badge>
                  {reportApproved && <span className="text-[10px] text-muted-foreground font-mono">Approved by Operator on 2026-05-21</span>}
                </div>
              </div>
              <Button
                size="sm"
                variant={reportApproved ? "outline" : "default"}
                onClick={() => {
                  const nextApproved = !reportApproved;
                  setReportApproved(nextApproved);
                  toast.success(nextApproved ? "Report Approved & Digitally Signed!" : "Report returned to draft state.");
                }}
              >
                {reportApproved ? "Revoke Approval" : "Sign & Approve Report"}
              </Button>
            </div>

            <div className="bg-secondary/20 border border-border/50 rounded-xl p-5 space-y-4">
              <div>
                <label className="text-[10px] text-muted-foreground font-mono block">EXECUTIVE PROBLEM SUMMARY</label>
                <input
                  type="text"
                  value={editProblemStatement}
                  onChange={(e) => setEditProblemStatement(e.target.value)}
                  className="w-full text-sm font-semibold p-2 mt-1 bg-background border border-border rounded text-foreground"
                />
              </div>

              <div>
                <label className="text-[10px] text-muted-foreground font-mono block">CONFIRMED ROOT CAUSE</label>
                <Textarea
                  value={editRootCauseText}
                  onChange={(e) => setEditRootCauseText(e.target.value)}
                  className="w-full text-xs font-mono p-2 mt-1 bg-background border border-border rounded text-foreground"
                  rows={2}
                />
              </div>
            </div>

            {/* CAPA Action Plan Tracker */}
            <div className="bg-secondary/15 border border-border/40 rounded-xl p-4 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold uppercase tracking-wide text-primary mono">// CAPA ACTION ITEM TRACKER</span>
                <Button size="sm" onClick={addCapa}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Action Item
                </Button>
              </div>

              <div className="space-y-2">
                {capaActions.map((act) => (
                  <div key={act.id} className="p-3 border border-border/50 rounded-lg bg-background/50 text-xs space-y-2.5">
                    <div className="flex justify-between gap-2">
                      <input
                        type="text"
                        value={act.desc}
                        onChange={(e) => updateCapa(act.id, "desc", e.target.value)}
                        className="w-full bg-transparent border-0 p-0 text-xs font-semibold focus:ring-0 focus:outline-none text-foreground"
                      />
                      <button onClick={() => deleteCapa(act.id)} className="text-muted-foreground hover:text-red-500">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/20 text-[9px] mono">
                      <div>
                        <span>Owner:</span>
                        <input
                          type="text"
                          value={act.owner}
                          onChange={(e) => updateCapa(act.id, "owner", e.target.value)}
                          className="w-full p-0.5 mt-0.5 bg-background border border-border rounded text-foreground"
                        />
                      </div>
                      <div>
                        <span>Due Date:</span>
                        <input
                          type="text"
                          value={act.date}
                          onChange={(e) => updateCapa(act.id, "date", e.target.value)}
                          className="w-full p-0.5 mt-0.5 bg-background border border-border rounded text-foreground"
                        />
                      </div>
                      <div>
                        <span>Status:</span>
                        <select
                          value={act.status}
                          onChange={(e) => updateCapa(act.id, "status", e.target.value)}
                          className="w-full p-0.5 mt-0.5 bg-background border border-border rounded text-foreground text-[9px]"
                        >
                          <option value="Pending">Pending</option>
                          <option value="In Progress">In Progress</option>
                          <option value="Completed">Completed</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Validation Checklist */}
            <div className="bg-secondary/15 border border-border/40 rounded-xl p-5 space-y-3">
              <span className="text-xs text-primary font-bold mono block">// CAPA VALIDATION & QUALITY AUDIT CHECKLIST</span>
              <div className="space-y-2 text-xs">
                {[
                  { key: "rootCauseMapped", label: "Root cause verified and mapped to physical evidence logs" },
                  { key: "capaFeasible", label: "CAPA actions are immediately feasible and budget-allocated" },
                  { key: "redundancyMet", label: "Preventive actions build redundancy to prevent multi-point failure recurrence" }
                ].map((chk) => (
                  <div key={chk.key} className="flex items-start gap-2.5 p-2 rounded bg-background/30 hover:bg-background/50 transition-colors">
                    <input
                      type="checkbox"
                      id={`chk-${chk.key}`}
                      checked={!!capaChecklist[chk.key]}
                      onChange={(e) => {
                        setCapaChecklist({ ...capaChecklist, [chk.key]: e.target.checked });
                      }}
                      className="rounded border-border bg-background text-primary mt-0.5"
                    />
                    <label htmlFor={`chk-${chk.key}`} className="cursor-pointer select-none leading-relaxed text-muted-foreground">
                      {chk.label}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Report Iterative Q&A */}
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <div className="bg-secondary/25 border-b border-border/40 p-3 flex items-center justify-between">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">// REFINE REPORT & CAPA</p>
                <span className="text-[10px] text-muted-foreground font-mono">Ask to add CAPA items, update root cause, or generate executive summary text</span>
              </div>
              {renderIterativePanel("e.g. \"Generate an executive summary of the root cause\", or \"Add a CAPA for replacing the temperature probe on a 90-day cycle\"...")}
            </div>
          </div>
        );
      }

      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-4 text-center">
            <div className="w-16 h-16 rounded-full bg-muted/50 border border-border/40 flex items-center justify-center">
              <FileText className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-muted-foreground mono">// Agent Output Ready</p>
              <p className="text-xs text-muted-foreground">This agent has completed its analysis. Use the Chat Console to refine or ask follow-up questions.</p>
            </div>
          </div>
        );
    }
  };

  // ── Automation progress modal ────────────────────────────────────────────
  const renderAutoModal = () => {
    if (!showAutoModal) return null;
    const isDone = autoProgress.some((e) => e.type === "done");
    const hasError = autoProgress.some((e) => e.type === "error");
    const agentStatusMap: Record<string, string> = {};
    for (const e of autoProgress) {
      if (e.type === "agent_start" && e.agent) agentStatusMap[e.agent] = "running";
      if (e.type === "agent_skip" && e.agent) agentStatusMap[e.agent] = "skipped";
      if (e.type === "agent_complete" && e.agent) agentStatusMap[e.agent] = "complete";
      if (e.type === "error") Object.keys(agentStatusMap).forEach((k) => { if (agentStatusMap[k] === "running") agentStatusMap[k] = "error"; });
    }
    const lastProgress = [...autoProgress].reverse().find((e) => e.type === "agent_progress");

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="w-full max-w-lg mx-4 bg-background border border-violet-500/30 rounded-xl shadow-2xl shadow-violet-500/10 overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between bg-violet-500/5">
            <div className="flex items-center gap-2">
              {autoRunning ? (
                <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
              ) : isDone ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : (
                <Zap className="w-4 h-4 text-violet-400" />
              )}
              <span className="font-bold text-sm mono">// FULL RCA AUTOMATION</span>
            </div>
            {!autoRunning && (
              <button
                onClick={() => setShowAutoModal(false)}
                className="text-muted-foreground hover:text-foreground p-1 rounded"
              >
                <XCircle className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
            {autoProgress.length === 0 && !autoRunning && (
              <div className="text-center py-6 space-y-3">
                <div className="w-14 h-14 rounded-full bg-violet-500/10 border border-violet-500/30 flex items-center justify-center mx-auto">
                  <Zap className="w-7 h-7 text-violet-400" />
                </div>
                <div className="space-y-1">
                  <p className="font-semibold text-sm">Automated Full RCA Pipeline</p>
                  <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                    AI will automatically run all 8 analysis agents — generating questions, answering them, and producing a complete RCA report with zero manual input.
                  </p>
                </div>
                <div className="text-xs text-muted-foreground/70 bg-secondary/30 rounded-lg p-3 text-left space-y-1">
                  <p className="font-mono font-semibold text-violet-400/80">// What happens:</p>
                  <p>• Data Collector validates the incident</p>
                  <p>• 5-Why drills down to root cause (auto-answered)</p>
                  <p>• Fishbone builds the Ishikawa diagram (10-step auto-flow)</p>
                  <p>• FTA, Pareto, Timeline, Equipment analyse in parallel</p>
                  <p>• Report Generator produces the final CAPA</p>
                </div>
              </div>
            )}

            {AGENTS.map((agent) => {
              const status = agentStatusMap[agent.key];
              if (!status && autoProgress.length === 0) return null;
              const progressEvents = autoProgress.filter(
                (e) => e.agent === agent.key && e.type === "agent_progress"
              );
              const lastStep = progressEvents[progressEvents.length - 1];
              return (
                <div
                  key={agent.key}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs transition-all ${
                    status === "complete"
                      ? "bg-emerald-500/5 border-emerald-500/20"
                      : status === "running"
                        ? "bg-violet-500/5 border-violet-500/30"
                        : status === "skipped"
                          ? "bg-muted/20 border-border/30 opacity-60"
                          : status === "error"
                            ? "bg-red-500/5 border-red-500/30"
                            : "bg-transparent border-transparent opacity-30"
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    {status === "complete" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : status === "running" ? (
                      <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />
                    ) : status === "skipped" ? (
                      <XCircle className="w-3.5 h-3.5 text-muted-foreground/50" />
                    ) : status === "error" ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                    ) : (
                      <Circle className="w-3.5 h-3.5 text-muted-foreground/30" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold mono">{agent.shortName}</span>
                      {status === "skipped" && (
                        <span className="text-[10px] text-muted-foreground/60">(already done)</span>
                      )}
                    </div>
                    {lastStep?.message && status === "running" && (
                      <p className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">{lastStep.message}</p>
                    )}
                  </div>
                  {status === "running" && lastStep && (
                    <span className="text-[10px] text-violet-400/70 mono shrink-0">step {lastStep.step}</span>
                  )}
                </div>
              );
            })}

            {lastProgress && autoRunning && (
              <div className="text-[10px] text-muted-foreground/60 mono px-1 truncate">
                {lastProgress.message}
              </div>
            )}

            {isDone && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-center">
                <p className="text-sm font-semibold text-emerald-400">Analysis Complete!</p>
                <p className="text-xs text-muted-foreground mt-1">All agents have completed their analysis. Review each step's findings.</p>
              </div>
            )}

            {hasError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-xs text-red-400 font-mono">
                  {autoProgress.find((e) => e.type === "error")?.message}
                </p>
              </div>
            )}
          </div>

          <div className="p-4 border-t border-border flex gap-2 justify-end">
            {!autoRunning && autoProgress.length === 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAutoModal(false)}
                className="text-xs"
              >
                Cancel
              </Button>
            )}
            {!autoRunning && (
              <Button
                size="sm"
                disabled={autoMut.isPending}
                onClick={() => {
                  if (isDone) {
                    setShowAutoModal(false);
                  } else {
                    setAutoProgress([]);
                    autoMut.mutate();
                  }
                }}
                className="bg-violet-500 hover:bg-violet-600 text-white text-xs font-semibold"
              >
                {isDone ? (
                  "Close & Review"
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5 mr-1.5" />
                    Start Automation
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3 animate-fadeIn">
      {renderAutoModal()}
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
        <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
          {AGENTS.map((agent, idx) => {
            const isComplete = completedAgents.has(agent.key);
            const isSkipped = skippedAgents.has(agent.key);
            const isCurrent = idx === agentStep;
            const isFuture = idx > agentStep;
            const isClickable =
              idx <= agentStep ||
              isComplete ||
              isSkipped ||
              (idx === agentStep + 1 &&
                (completedAgents.has(currentAgent?.key || "") ||
                  (currentAgent?.key === "data_collector" && editLocked)));

            return (
              <div key={agent.key} className="flex items-center shrink-0">
                <button
                  onClick={() => isClickable && goToAgent(idx)}
                  disabled={!isClickable}
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
                    className={`w-3 h-3 mx-2 shrink-0 transition-colors ${
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
              <p className="text-[10px] text-muted-foreground mono uppercase px-2 font-semibold tracking-wider">// AGENTS PROGRESS</p>
              {AGENTS.map((a, idx) => {
                const isSelected = idx === agentStep;
                const isCompleted = completedAgents.has(a.key);
                const isSkipped = skippedAgents.has(a.key);
                const isClickable =
                  idx <= agentStep ||
                  isCompleted ||
                  isSkipped ||
                  (idx === agentStep + 1 &&
                    (completedAgents.has(currentAgent?.key || "") ||
                      (currentAgent?.key === "data_collector" && editLocked)));

                return (
                  <button
                    key={a.key}
                    disabled={!isClickable}
                    onClick={() => isClickable && goToAgent(idx)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all flex items-center justify-between border ${
                      isSelected
                        ? "bg-primary/10 border-primary/40 text-primary font-bold shadow-[0_0_10px_rgba(251,191,36,0.15)]"
                        : isCompleted
                          ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10"
                          : isSkipped
                            ? "bg-muted/30 border-transparent text-muted-foreground/50 line-through hover:bg-secondary/40"
                            : isClickable
                              ? "bg-transparent border-transparent text-foreground hover:bg-secondary"
                              : "bg-transparent border-transparent text-muted-foreground/40 cursor-not-allowed"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`mono text-[10px] ${
                        isSelected 
                          ? "text-primary/70" 
                          : isCompleted 
                            ? "text-emerald-400/70" 
                            : "text-muted-foreground/40"
                      }`}>{a.order}.</span>
                      <span className="font-mono">{a.shortName}</span>
                    </div>
                    {isCompleted ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : isSkipped ? (
                      <XCircle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                    ) : isSelected ? (
                      <Circle className="w-3.5 h-3.5 text-primary animate-pulse shrink-0" />
                    ) : (
                      <Circle className="w-3.5 h-3.5 text-muted-foreground/20 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="border-t border-border p-3 space-y-2">
            {currentAgent && agentStep < AGENTS.length - 1 && (
              completedAgents.has(currentAgent.key) || (currentAgent.key === "data_collector" && editLocked) ? (
                <Button
                  variant="default"
                  size="sm"
                  className="w-full bg-primary hover:bg-primary/95 text-primary-foreground font-semibold"
                  onClick={() => goToAgent(agentStep + 1)}
                >
                  Next Step: {AGENTS[agentStep + 1].shortName}
                  <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              ) : (
                <Button variant="outline" size="sm" className="w-full" onClick={skipAgent}>
                  <SkipForward className="w-3.5 h-3.5 mr-1.5" />
                  Skip to Next
                </Button>
              )
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
            <div className="pt-1 border-t border-border/40">
              <Button
                variant="outline"
                size="sm"
                className="w-full border-violet-500/40 text-violet-400 hover:bg-violet-500/10 hover:border-violet-500/60 font-semibold"
                onClick={() => { setShowAutoModal(true); }}
                disabled={autoMut.isPending}
              >
                {autoMut.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5 mr-1.5" />
                )}
                Run Full Analysis
              </Button>
            </div>
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
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[10px] h-6 py-0 px-2 font-mono text-muted-foreground hover:text-red-400 hover:bg-red-500/10 flex items-center gap-1 transition-all"
                    onClick={() => {
                      if (confirm("Are you sure you want to clear this agent's chat history?")) {
                        clearChatMut.mutate();
                      }
                    }}
                    disabled={clearChatMut.isPending}
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear Chat
                  </Button>
                  <span className="status-dot text-[color:var(--signal-ok)]" />
                </div>
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
                {streamingChatText !== null && (
                  <div className="flex justify-start animate-fadeIn">
                    <div className="max-w-[85%] rounded-xl px-4 py-3 bg-secondary/80 border border-border shadow-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] mono uppercase bg-accent/20 text-accent border-accent/40"
                        >
                          {currentAgent?.shortName}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground mono">
                          Streaming...
                        </span>
                      </div>
                      {renderMessageContent(streamingChatText || "Analyzing...", "assistant")}
                    </div>
                  </div>
                )}
                {sendMut.isPending && streamingChatText === null && (
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
                        if (input.trim() && convId) sendMut.mutate(input.trim());
                      }
                    }}
                    className="resize-none flex-1"
                  />
                  <Button
                    onClick={() => sendMut.mutate(input.trim())}
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
      <div className="text-sm whitespace-pre-wrap font-mono">
        {typeof data === "string" ? data : ""}
      </div>
    );
  }

  if (data.whyStep !== undefined || data.possibleCauses !== undefined || data.operatorInstruction !== undefined) {
    const stepNum = data.whyStep ? (data.whyStep - 1) : 1;
    return (
      <div className="space-y-3">
        <div className="bg-primary/5 border-l-2 border-primary p-3 rounded-r">
          <p className="text-[10px] font-mono text-primary mb-1 uppercase tracking-wider">// WHY STEP {stepNum}</p>
          <p className="text-sm font-semibold text-foreground">{data.question || "Awaiting question..."}</p>
        </div>
        {data.possibleCauses && Array.isArray(data.possibleCauses) && data.possibleCauses.length > 0 && (
          <div className="space-y-2">
            <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">// Suggested Causes</p>
            <div className="space-y-1.5 pl-2">
              {data.possibleCauses.map((cause: any) => (
                <div key={cause.id} className="text-xs bg-secondary/35 border border-border/40 rounded p-2 flex items-start gap-2">
                  <span className="font-mono font-bold text-[8px] px-1 bg-muted rounded text-muted-foreground uppercase mt-0.5 shrink-0">{cause.category}</span>
                  <span className="font-medium text-foreground">{cause.description}</span>
                  {cause.likelihood && (
                    <Badge variant="outline" className={`text-[8px] px-1 ml-auto shrink-0 font-mono ${
                      cause.likelihood.toLowerCase() === "high"
                        ? "bg-red-500/10 text-red-400 border-red-500/20"
                        : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    }`}>
                      {cause.likelihood}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {data.operatorInstruction && (
          <p className="text-[10px] text-muted-foreground italic font-mono pt-1">
            // {data.operatorInstruction}
          </p>
        )}
      </div>
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
        <div className="bg-secondary/35 border border-border/40 rounded p-3 text-xs mono text-muted-foreground">
          <div className="flex items-center gap-1.5 text-primary mb-1 font-semibold">
            <Zap className="w-3.5 h-3.5" />
            <span>ANALYSIS COMPILED</span>
          </div>
          Workspace updated with {keys.length} parameters. Focus on the main visual console.
        </div>
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
