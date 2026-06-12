import { createFileRoute, Link, useNavigate, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getAuthToken } from "@/lib/auth-check";

export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    const token = getAuthToken();
    if (token) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.error) return setErr(result.error);
    nav({ to: "/dashboard" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="panel w-full max-w-md">
        <div className="panel-header">
          <span>SECURE TERMINAL ACCESS</span>
          <span className="status-dot text-[color:var(--signal-ok)]" />
        </div>
        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div>
            <h1 className="text-2xl font-bold">RCA Operations Console</h1>
            <p className="text-sm text-muted-foreground mt-1">Sign in to continue</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Operator email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {err && <p className="text-sm text-destructive font-mono">{err}</p>}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Authenticating…</>) : "Sign in"}
          </Button>
          <p className="text-sm text-muted-foreground text-center">
            No account?{" "}
            <Link to="/signup" className="text-primary hover:underline">
              Request access
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
