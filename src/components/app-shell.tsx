import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useServerFn } from "@tanstack/react-start";
import { changeOwnPasswordFn } from "@/lib/auth.functions";
import { toast } from "sonner";
import { Activity, LayoutDashboard, ShieldAlert, LogOut, Key, X, Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "@/components/theme-provider";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const nav = useNavigate();
  const [showChangePass, setShowChangePass] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { theme, toggleTheme } = useTheme();

  const changePassFn = useServerFn(changeOwnPasswordFn);

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await changePassFn({ data: { oldPassword, newPassword } });
      toast.success("Password updated successfully");
      setShowChangePass(false);
      setOldPassword("");
      setNewPassword("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || "Failed to update password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-10">
        <div className="w-full px-6 h-14 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <span className="font-display font-bold tracking-wide">
              RCA<span className="text-primary">.</span>OPS
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link to="/dashboard">
              <Button variant="ghost" size="sm">
                <LayoutDashboard className="w-4 h-4 mr-2" />
                Cases
              </Button>
            </Link>
            {isAdmin && (
              <Link to="/admin">
                <Button variant="ghost" size="sm">
                  <ShieldAlert className="w-4 h-4 mr-2" />
                  Admin
                </Button>
              </Link>
            )}
            <span className="text-xs text-muted-foreground mx-3 mono hidden sm:inline">
              {user?.email}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowChangePass(true)}
              title="Change Password"
            >
              <Key className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleTheme}
              title={theme === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"}
            >
              {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                logout();
                nav({ to: "/login" });
              }}
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </nav>
        </div>
      </header>
      <main className="w-full px-6 py-6">{children}</main>

      {/* Change Password Modal */}
      {showChangePass && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="panel w-full max-w-md animate-fadeIn">
            <div className="panel-header">
              <span>// UPDATE PASSWORD</span>
              <button
                onClick={() => setShowChangePass(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handlePasswordChange} className="p-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="old-pass">Current Password</Label>
                <Input
                  id="old-pass"
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  required
                  placeholder="Enter current password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pass">New Password</Label>
                <Input
                  id="new-pass"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="Minimum 8 characters"
                />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button type="button" variant="ghost" onClick={() => setShowChangePass(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? "Updating…" : "Update Password"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export function AuthGate({
  children,
  adminOnly = false,
}: {
  children: React.ReactNode;
  adminOnly?: boolean;
}) {
  const { loading, user, isAdmin } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      nav({ to: "/login" });
    }
  }, [loading, user, nav]);

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground mono text-sm">
        // initializing…
      </div>
    );
  if (!user) return null;
  if (adminOnly && !isAdmin)
    return (
      <div className="p-8 text-center text-destructive mono">// access denied — admin only</div>
    );
  return <AppShell>{children}</AppShell>;
}
