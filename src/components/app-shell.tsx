import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Activity, LayoutDashboard, ShieldAlert, LogOut } from "lucide-react";
import { useEffect } from "react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <span className="font-display font-bold tracking-wide">RCA<span className="text-primary">.</span>OPS</span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link to="/dashboard"><Button variant="ghost" size="sm"><LayoutDashboard className="w-4 h-4 mr-2" />Cases</Button></Link>
            {isAdmin && <Link to="/admin"><Button variant="ghost" size="sm"><ShieldAlert className="w-4 h-4 mr-2" />Admin</Button></Link>}
            <span className="text-xs text-muted-foreground mx-3 mono hidden sm:inline">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={() => { logout(); nav({ to: "/login" }); }}>
              <LogOut className="w-4 h-4" />
            </Button>
          </nav>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

export function AuthGate({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { loading, user, isAdmin } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      nav({ to: "/login" });
    }
  }, [loading, user, nav]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground mono text-sm">// initializing…</div>;
  if (!user) return null;
  if (adminOnly && !isAdmin) return <div className="p-8 text-center text-destructive mono">// access denied — admin only</div>;
  return <AppShell>{children}</AppShell>;
}
