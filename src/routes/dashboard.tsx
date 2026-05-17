import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AuthGate } from "@/components/app-shell";
import { listMyCases, createRcaCase, deleteCase } from "@/lib/rca.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, FileText, CheckCircle2, Clock } from "lucide-react";

export const Route = createFileRoute("/dashboard")({ component: () => <AuthGate><DashboardPage /></AuthGate> });

function DashboardPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [assetId, setAssetId] = useState("");

  const listCasesFn = useServerFn(listMyCases);
  const { data, isLoading } = useQuery({
    queryKey: ["cases"],
    queryFn: () => listCasesFn(),
  });

  const createFn = useServerFn(createRcaCase);
  const createMut = useMutation({
    mutationFn: async () => createFn({ data: { title, assetId: assetId || null } }),
    onSuccess: (result: any) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
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
        <Button onClick={() => setShowNew((v) => !v)}><Plus className="w-4 h-4 mr-2" />New RCA</Button>
      </div>

      {showNew && (
        <div className="panel">
          <div className="panel-header"><span>// NEW INCIDENT</span></div>
          <div className="p-4 space-y-3">
            <Input placeholder="Incident title (e.g. Furnace-01 trip due to Zone 3 overheating)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Input placeholder="Asset ID (optional, e.g. FURN-01)" value={assetId} onChange={(e) => setAssetId(e.target.value)} />
            <div className="flex gap-2">
              <Button onClick={() => createMut.mutate()} disabled={!title || createMut.isPending}>
                {createMut.isPending ? "Creating…" : "Open workspace"}
              </Button>
              <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground mono text-sm">// loading cases…</p>
      ) : cases.length === 0 ? (
        <div className="panel p-10 text-center">
          <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">No RCA cases yet. Click <strong>New RCA</strong> to begin.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cases.map((c: any) => (
            <div key={c.id} className="panel hover:border-primary/50 transition-colors group">
              <div className="panel-header">
                <span>// {c.asset_id ?? "no asset"}</span>
                <span className="flex items-center gap-1">
                  {c.status === "completed" ? <CheckCircle2 className="w-3 h-3 text-[color:var(--signal-ok)]" /> : <Clock className="w-3 h-3 text-[color:var(--signal-warn)]" />}
                  {c.status}
                </span>
              </div>
              <Link to="/rca/$caseId" params={{ caseId: c.id }} className="block p-4">
                <h3 className="font-semibold line-clamp-2">{c.title}</h3>
                <p className="text-xs text-muted-foreground mono mt-2">{new Date(c.updated_at).toLocaleString()}</p>
              </Link>
              <div className="px-4 pb-3 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => { if (confirm("Delete this case?")) delMut.mutate(c.id); }}>
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
