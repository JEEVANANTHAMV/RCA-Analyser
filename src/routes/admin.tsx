import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AuthGate } from "@/components/app-shell";
import {
  adminListUsers,
  adminListAllCases,
  adminAnalytics,
  adminDeleteCase,
  adminToggleRole,
  adminDeleteUser,
} from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Trash2, ShieldCheck, ShieldOff, UserX } from "lucide-react";

export const Route = createFileRoute("/admin")({
  component: () => <AuthGate adminOnly><AdminPage /></AuthGate>,
});

function AdminPage() {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["adm-stats"] });
    qc.invalidateQueries({ queryKey: ["adm-users"] });
    qc.invalidateQueries({ queryKey: ["adm-cases"] });
  };

  const adminAnalyticsFn = useServerFn(adminAnalytics);
  const stats = useQuery({
    queryKey: ["adm-stats"],
    queryFn: () => adminAnalyticsFn(),
  });

  const adminUsersFn = useServerFn(adminListUsers);
  const users = useQuery({
    queryKey: ["adm-users"],
    queryFn: () => adminUsersFn(),
  });

  const adminCasesFn = useServerFn(adminListAllCases);
  const cases = useQuery({
    queryKey: ["adm-cases"],
    queryFn: () => adminCasesFn(),
  });

  const delCaseFn = useServerFn(adminDeleteCase);
  const delCase = useMutation({
    mutationFn: async (caseId: string) => delCaseFn({ data: { caseId } }),
    onSuccess: invalidate,
  });

  const toggleFn = useServerFn(adminToggleRole);
  const toggle = useMutation({
    mutationFn: async (v: { id: string; admin: boolean }) => toggleFn({ data: { targetUserId: v.id, makeAdmin: v.admin } }),
    onSuccess: invalidate,
  });

  const delUserFn = useServerFn(adminDeleteUser);
  const delUser = useMutation({
    mutationFn: async (id: string) => delUserFn({ data: { targetUserId: id } }),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin Console</h1>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Users", stats.data?.userCount],
          ["Cases", stats.data?.caseCount],
          ["Completed", stats.data?.completedCount],
          ["Conversations", stats.data?.conversationCount],
          ["Messages", stats.data?.messageCount],
        ].map(([label, val]) => (
          <div key={label as string} className="panel p-4">
            <div className="text-xs text-muted-foreground mono uppercase">{label}</div>
            <div className="text-3xl font-bold text-primary mt-1">{val ?? "—"}</div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-header"><span>// AGENT USAGE</span></div>
        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          {(stats.data?.agentUsage ?? []).map((a: any) => (
            <div key={a.agent_key} className="bg-secondary rounded p-3">
              <div className="mono text-xs text-muted-foreground">{a.agent_key}</div>
              <div className="text-xl font-bold">{a.count}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><span>// USERS</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground mono border-b border-border">
              <tr><th className="text-left p-3">Email</th><th className="text-left p-3">Name</th><th className="text-left p-3">Role</th><th className="text-left p-3">Cases</th><th className="text-right p-3">Actions</th></tr>
            </thead>
            <tbody>
              {(users.data?.users ?? []).map((u: any) => {
                const isAdmin = u.role === "admin";
                return (
                  <tr key={u.id} className="border-b border-border/50">
                    <td className="p-3 mono text-xs">{u.email}</td>
                    <td className="p-3">{u.fullName}</td>
                    <td className="p-3">
                      <span className={`mono text-xs px-2 py-0.5 rounded ${isAdmin ? "bg-primary/20 text-primary" : "bg-secondary"}`}>{u.role}</span>
                    </td>
                    <td className="p-3 mono">{u.caseCount}</td>
                    <td className="p-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: u.id, admin: !isAdmin })}>
                        {isAdmin ? <ShieldOff className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm("Delete user?")) delUser.mutate(u.id); }}>
                        <UserX className="w-4 h-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><span>// ALL RCA CASES</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground mono border-b border-border">
              <tr><th className="text-left p-3">Title</th><th className="text-left p-3">Owner</th><th className="text-left p-3">Asset</th><th className="text-left p-3">Status</th><th className="text-left p-3">Created</th><th className="text-right p-3"></th></tr>
            </thead>
            <tbody>
              {(cases.data?.cases ?? []).map((c: any) => (
                <tr key={c.id} className="border-b border-border/50">
                  <td className="p-3">{c.title}</td>
                  <td className="p-3 mono text-xs">{c.owner?.email}</td>
                  <td className="p-3 mono text-xs">{c.asset_id}</td>
                  <td className="p-3 mono text-xs">{c.status}</td>
                  <td className="p-3 mono text-xs">{new Date(c.created_at).toLocaleString()}</td>
                  <td className="p-3 text-right">
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm("Delete?")) delCase.mutate(c.id); }}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
