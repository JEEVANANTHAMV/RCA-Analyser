import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/")({ component: Index });

function Index() {
  const { user, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    nav({ to: user ? "/dashboard" : "/login" });
  }, [user, loading, nav]);
  return <div className="min-h-screen flex items-center justify-center text-muted-foreground mono text-sm">// routing…</div>;
}
