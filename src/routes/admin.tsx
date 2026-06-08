import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AuthGate } from "@/components/app-shell";
import {
  adminListUsers,
  adminListAllCases,
  adminAnalytics,
  adminDeleteCase,
  adminToggleRole,
  adminDeleteUser,
  adminGenerateInvite,
  adminBulkGenerateInvites,
  adminListInvites,
  adminDeleteInvite,
  adminResetOperatorPassword,
} from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_BY_KEY, AgentKey } from "@/lib/agents";
import { toast } from "sonner";
import { DbUserRow, DbCaseRow, DbInvite } from "@/lib/auth";
import {
  Trash2,
  ShieldCheck,
  ShieldOff,
  UserX,
  Key,
  Copy,
  Plus,
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  ShieldAlert,
  CheckCircle,
  RefreshCw,
  BarChart2,
  Users,
  FileText,
} from "lucide-react";

export const Route = createFileRoute("/admin")({
  component: () => (
    <AuthGate adminOnly>
      <AdminPage />
    </AuthGate>
  ),
});

function AdminPage() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"incidents" | "users" | "access">("incidents");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [resettingUser, setResettingUser] = useState<DbUserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["adm-stats"] });
    qc.invalidateQueries({ queryKey: ["adm-users"] });
    qc.invalidateQueries({ queryKey: ["adm-cases"] });
    qc.invalidateQueries({ queryKey: ["adm-invites"] });
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

  const adminInvitesFn = useServerFn(adminListInvites);
  const invites = useQuery({
    queryKey: ["adm-invites"],
    queryFn: () => adminInvitesFn(),
  });

  const delCaseFn = useServerFn(adminDeleteCase);
  const delCase = useMutation({
    mutationFn: async (caseId: string) => delCaseFn({ data: { caseId } }),
    onSuccess: () => {
      invalidate();
      toast.success("RCA case deleted");
    },
  });

  const toggleFn = useServerFn(adminToggleRole);
  const toggle = useMutation({
    mutationFn: async (v: { id: string; admin: boolean }) =>
      toggleFn({ data: { targetUserId: v.id, makeAdmin: v.admin } }),
    onSuccess: () => {
      invalidate();
      toast.success("User role updated");
    },
  });

  const delUserFn = useServerFn(adminDeleteUser);
  const delUser = useMutation({
    mutationFn: async (id: string) => delUserFn({ data: { targetUserId: id } }),
    onSuccess: () => {
      invalidate();
      toast.success("User deleted");
    },
  });

  const generateInviteFn = useServerFn(adminGenerateInvite);
  const generateInvite = useMutation({
    mutationFn: async (v: { email: string; role: "admin" | "user" }) =>
      generateInviteFn({ data: v }),
    onSuccess: () => {
      invalidate();
    },
  });

  const bulkInviteFn = useServerFn(adminBulkGenerateInvites);
  const bulkInvite = useMutation({
    mutationFn: async (v: { textarea: string; role: "admin" | "user" }) =>
      bulkInviteFn({ data: v }),
    onSuccess: () => {
      invalidate();
    },
  });

  const deleteInviteFn = useServerFn(adminDeleteInvite);
  const deleteInvite = useMutation({
    mutationFn: async (code: string) => deleteInviteFn({ data: { code } }),
    onSuccess: () => {
      invalidate();
      toast.success("Invite code revoked");
    },
  });

  const resetPasswordFn = useServerFn(adminResetOperatorPassword);
  const resetPassword = useMutation({
    mutationFn: async (v: { targetUserId: string; newPassword: string }) =>
      resetPasswordFn({ data: v }),
    onSuccess: () => {
      invalidate();
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="text-primary w-6 h-6" />
            Admin Operations Console
          </h1>
          <p className="text-sm text-muted-foreground mono">
            // Control panel for system configuration and user management
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={invalidate} className="mono text-xs">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> REFRESH_SYSTEM
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border/80 overflow-x-auto">
        <button
          onClick={() => setActiveTab("incidents")}
          className={`px-4 py-2 text-xs font-mono uppercase tracking-wider border-b-2 -mb-[2px] whitespace-nowrap transition-colors ${activeTab === "incidents" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          // 01. Incidents & Usage
        </button>
        <button
          onClick={() => setActiveTab("users")}
          className={`px-4 py-2 text-xs font-mono uppercase tracking-wider border-b-2 -mb-[2px] whitespace-nowrap transition-colors ${activeTab === "users" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          // 02. Operator Management
        </button>
        <button
          onClick={() => setActiveTab("access")}
          className={`px-4 py-2 text-xs font-mono uppercase tracking-wider border-b-2 -mb-[2px] whitespace-nowrap transition-colors ${activeTab === "access" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          // 03. Invites & Provisioning
        </button>
      </div>

      {/* Metric summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Users", stats.data?.userCount, <Users className="w-4 h-4 text-primary" />],
          ["Cases", stats.data?.caseCount, <FileText className="w-4 h-4 text-primary" />],
          [
            "Completed",
            stats.data?.completedCount,
            <CheckCircle className="w-4 h-4 text-[color:var(--signal-ok)]" />,
          ],
          ["Convs", stats.data?.conversationCount, <BarChart2 className="w-4 h-4 text-accent" />],
          ["Messages", stats.data?.messageCount, <BarChart2 className="w-4 h-4 text-accent" />],
        ].map(([label, val, icon]) => (
          <div key={label as string} className="panel p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-muted-foreground mono uppercase">
              <span>{label}</span>
              {icon}
            </div>
            <div className="text-3xl font-bold text-foreground mt-3">{val ?? "—"}</div>
          </div>
        ))}
      </div>

      {/* Tab Contents */}
      {activeTab === "incidents" && (
        <div className="space-y-6 animate-fadeIn">
          {/* Agent usage summary */}
          <div className="panel">
            <div className="panel-header">
              <span>// AGENT WORKLOAD STATS</span>
            </div>
            {stats.data?.agentUsage?.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground mono">
                // No agent telemetry available yet
              </p>
            ) : (
              <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-2">
                {(stats.data?.agentUsage ?? []).map((a) => {
                  const agent = AGENT_BY_KEY[a.agent_key as AgentKey];
                  return (
                    <div
                      key={a.agent_key}
                      className="bg-secondary/40 border border-border/50 rounded p-3"
                    >
                      <div className="mono text-xs text-muted-foreground uppercase truncate">
                        {agent?.name || a.agent_key}
                      </div>
                      <div className="text-xl font-bold mt-1 text-primary">{a.count} sessions</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cases */}
          <div className="panel">
            <div className="panel-header">
              <span>// ALL ROOT CAUSE CASES</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground mono border-b border-border">
                  <tr>
                    <th className="text-left p-3">Title</th>
                    <th className="text-left p-3">Owner</th>
                    <th className="text-left p-3">Asset</th>
                    <th className="text-left p-3">Status</th>
                    <th className="text-left p-3">Created</th>
                    <th className="text-right p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {cases.data?.cases?.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-muted-foreground mono">
                        // No cases registered in the system
                      </td>
                    </tr>
                  ) : (
                    (cases.data?.cases ?? []).map((c: DbCaseRow) => (
                      <tr key={c.id} className="border-b border-border/50">
                        <td className="p-3 font-medium">{c.title}</td>
                        <td className="p-3 mono text-xs">{c.owner?.email || "// SYSTEM"}</td>
                        <td className="p-3 mono text-xs">{c.asset_id ?? "none"}</td>
                        <td className="p-3">
                          <span
                            className={`mono text-xs px-2 py-0.5 rounded ${c.status === "completed" ? "bg-[color:var(--color-signal-ok)]/10 text-[color:var(--signal-ok)]" : "bg-[color:var(--color-signal-warn)]/10 text-[color:var(--signal-warn)]"}`}
                          >
                            {c.status}
                          </span>
                        </td>
                        <td className="p-3 mono text-xs">
                          {new Date(c.created_at).toLocaleString()}
                        </td>
                        <td className="p-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (confirm("Delete this case?")) delCase.mutate(c.id);
                            }}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === "users" && (
        <div className="space-y-6 animate-fadeIn">
          {/* User management list */}
          <div className="panel">
            <div className="panel-header">
              <span>// ACTIVE OPERATORS</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground mono border-b border-border">
                  <tr>
                    <th className="text-left p-3">Email</th>
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Role</th>
                    <th className="text-left p-3">RCAs Created</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(users.data?.users ?? []).map((u: DbUserRow) => {
                    const isUserAdmin = u.role === "admin";
                    const isExpanded = expandedUser === u.id;
                    return (
                      <>
                        <tr
                          key={u.id}
                          className="border-b border-border/50 hover:bg-secondary/20 transition-colors"
                        >
                          <td className="p-3 mono text-xs font-semibold">{u.email}</td>
                          <td className="p-3">{u.fullName || "—"}</td>
                          <td className="p-3">
                            <span
                              className={`mono text-xs px-2 py-0.5 rounded ${isUserAdmin ? "bg-primary/20 text-primary border border-primary/30" : "bg-secondary text-muted-foreground border border-border"}`}
                            >
                              {u.role}
                            </span>
                          </td>
                          <td className="p-3 mono font-medium">{u.caseCount}</td>
                          <td className="p-3 text-right space-x-1 whitespace-nowrap">
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Agent Usage Details"
                              onClick={() => setExpandedUser(isExpanded ? null : u.id)}
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Reset Password"
                              onClick={() => setResettingUser(u)}
                            >
                              <Key className="w-4 h-4 text-primary" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title={
                                isUserAdmin ? "Revoke Admin Privilege" : "Grant Admin Privilege"
                              }
                              onClick={() => toggle.mutate({ id: u.id, admin: !isUserAdmin })}
                            >
                              {isUserAdmin ? (
                                <ShieldOff className="w-4 h-4 text-muted-foreground" />
                              ) : (
                                <ShieldCheck className="w-4 h-4 text-[color:var(--signal-ok)]" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Delete Operator"
                              onClick={() => {
                                if (confirm(`Are you sure you want to delete ${u.email}?`))
                                  delUser.mutate(u.id);
                              }}
                            >
                              <UserX className="w-4 h-4 text-destructive" />
                            </Button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td
                              colSpan={5}
                              className="bg-secondary/20 p-4 border-b border-border/50 animate-fadeIn"
                            >
                              <div className="space-y-3">
                                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground border-b border-border/40 pb-1">
                                  // Agent telemetry for {u.fullName || u.email}
                                </div>
                                {u.agentUsage?.length === 0 ? (
                                  <p className="text-xs text-muted-foreground mono">
                                    // No agent records for this operator
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    {u.agentUsage?.map(
                                      (usage: { agent_key: string; count: number }) => {
                                        const agent = AGENT_BY_KEY[usage.agent_key as AgentKey];
                                        return (
                                          <div
                                            key={usage.agent_key}
                                            className="bg-card border border-border/50 rounded p-2.5"
                                          >
                                            <div className="text-[10px] text-muted-foreground mono uppercase truncate">
                                              {agent?.name || usage.agent_key}
                                            </div>
                                            <div className="text-sm font-bold text-primary mt-0.5">
                                              {usage.count} conversations
                                            </div>
                                          </div>
                                        );
                                      },
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === "access" && (
        <div className="space-y-6 max-w-4xl mx-auto animate-fadeIn">
          {/* Invites Management */}
          <div className="panel max-w-xl mx-auto">
            <div className="panel-header">
              <span>// GENERATE & SEND REGISTRATION INVITE</span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const email = fd.get("invite-email") as string;
                const role = fd.get("invite-role") as "admin" | "user";

                generateInvite.mutate(
                  { email, role },
                  {
                    onSuccess: () => {
                      toast.success(`Invite generated and email sent to ${email}`);
                      (e.target as HTMLFormElement).reset();
                    },
                    onError: (err: unknown) => {
                      const message = err instanceof Error ? err.message : String(err);
                      toast.error(message || "Failed to generate invite");
                    },
                  },
                );
              }}
              className="p-6 space-y-4"
            >
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Recipient Email Address</Label>
                <Input
                  id="invite-email"
                  name="invite-email"
                  type="email"
                  required
                  placeholder="e.g. operator@company.com"
                />
                <p className="text-[10px] text-muted-foreground mono">
                  // An invitation email with the setup link will be sent directly to this address
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Grant Role on Signup</Label>
                <select
                  id="invite-role"
                  name="invite-role"
                  className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="user">User (Operator)</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <Button type="submit" disabled={generateInvite.isPending} className="w-full mt-2">
                {generateInvite.isPending ? "Generating & Sending…" : "Generate & Send Invitation"}
              </Button>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const textarea = fd.get("bulk-textarea") as string;
                  const role = fd.get("bulk-role") as "admin" | "user";
                  bulkInvite.mutate(
                    { textarea, role },
                    {
                      onSuccess: (res) => {
                        const r = res as { results: Array<{ email: string; code: string; ok: boolean }> };
                        const ok = r.results.filter((x) => x.ok).length;
                        const fail = r.results.filter((x) => !x.ok).length;
                        toast.success(`${ok} invite(s) generated${fail > 0 ? `, ${fail} failed` : ""}`);
                      },
                      onError: (err: unknown) => {
                        const message = err instanceof Error ? err.message : String(err);
                        toast.error(message || "Bulk invite failed");
                      },
                    },
                  );
                }}
                className="mt-4 pt-4 border-t border-border/50 space-y-3"
              >
                <div className="space-y-1.5">
                  <Label>Bulk Import</Label>
                  <Textarea
                    name="bulk-textarea"
                    required
                    rows={6}
                    placeholder="Paste contacts below (semicolon separated, email is last token per entry)&#10;&#10;e.g. Manish Motwani Manish.Motwani@vedanta.co.in; Montu Makwana Montu.Makwana@vedanta.co.in;"
                  />
                  <p className="text-[10px] text-muted-foreground mono">
                    // Format per entry: Name Lastname email@domain.com — separate entries with ;
                  </p>
                </div>
                <div className="flex gap-2 items-end">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="bulk-role">Grant Role</Label>
                    <select
                      id="bulk-role"
                      name="bulk-role"
                      className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="user">User (Operator)</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </div>
                  <Button type="submit" disabled={bulkInvite.isPending} className="mb-0">
                    {bulkInvite.isPending ? "Processing…" : "Bulk Import & Send"}
                  </Button>
                </div>
              </form>
            </form>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span>// PENDING REGISTRATION INVITES</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground mono border-b border-border">
                  <tr>
                    <th className="text-left p-3">Invite Code</th>
                    <th className="text-left p-3">Recipient Email</th>
                    <th className="text-left p-3">Role</th>
                    <th className="text-left p-3">Status</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.data?.invites?.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-muted-foreground mono">
                        // No pending invite codes generated
                      </td>
                    </tr>
                  ) : (
                    (invites.data?.invites ?? []).map((inv: DbInvite) => {
                      const isExpired = new Date(inv.expires_at) < new Date();
                      const isUsed = !!inv.used_at;
                      let badge = (
                        <span className="text-[color:var(--signal-ok)] font-mono text-xs px-2 py-0.5 rounded bg-[color:var(--color-signal-ok)]/10">
                          // ACTIVE
                        </span>
                      );
                      if (isUsed)
                        badge = (
                          <span className="text-muted-foreground font-mono text-xs px-2 py-0.5 rounded bg-muted">
                            // USED
                          </span>
                        );
                      else if (isExpired)
                        badge = (
                          <span className="text-[color:var(--signal-crit)] font-mono text-xs px-2 py-0.5 rounded bg-[color:var(--color-signal-crit)]/10">
                            // EXPIRED
                          </span>
                        );

                      const inviteUrl = `${window.location.origin}/signup?code=${inv.code}`;

                      return (
                        <tr key={inv.code} className="border-b border-border/50">
                          <td className="p-3 mono font-semibold text-primary">{inv.code}</td>
                          <td className="p-3 mono text-xs">{inv.email ?? "Public (Anyone)"}</td>
                          <td className="p-3 mono text-xs uppercase">{inv.role}</td>
                          <td className="p-3">{badge}</td>
                          <td className="p-3 text-right space-x-1 whitespace-nowrap">
                            {!isUsed && !isExpired && (
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Copy Invite Link"
                                onClick={() => {
                                  navigator.clipboard.writeText(inviteUrl);
                                  toast.success("Invite registration link copied!");
                                }}
                              >
                                <Copy className="w-4 h-4" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Revoke Invite"
                              onClick={() => {
                                if (confirm(`Revoke and delete invite code ${inv.code}?`)) {
                                  deleteInvite.mutate(inv.code);
                                }
                              }}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Password Reset Modal Overlay */}
      {resettingUser && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="panel w-full max-w-md animate-fadeIn">
            <div className="panel-header">
              <span>// RESET OPERATOR PASSWORD</span>
              <button
                onClick={() => setResettingUser(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="w-4 h-4 inline rotate-45 transform hover:scale-110 transition-transform" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                Set a new password for{" "}
                <span className="text-foreground font-mono font-semibold">
                  {resettingUser.email}
                </span>
                . The operator's active sessions will be invalidated immediately.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="reset-pass">New Password</Label>
                <Input
                  id="reset-pass"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  minLength={8}
                />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="ghost" onClick={() => setResettingUser(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (newPassword.length < 8) {
                      toast.error("Password must be at least 8 characters");
                      return;
                    }
                    resetPassword.mutate(
                      { targetUserId: resettingUser.id, newPassword },
                      {
                        onSuccess: () => {
                          toast.success("Password reset successfully");
                          setResettingUser(null);
                          setNewPassword("");
                        },
                        onError: (err: unknown) => {
                          const message = err instanceof Error ? err.message : String(err);
                          toast.error(message || "Failed to reset password");
                        },
                      },
                    );
                  }}
                  disabled={resetPassword.isPending}
                >
                  {resetPassword.isPending ? "Resetting…" : "Confirm Password Reset"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
