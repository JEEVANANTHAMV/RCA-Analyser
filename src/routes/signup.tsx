import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/signup")({ component: SignupPage });

function SignupPage() {
  const nav = useNavigate();
  const { signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const result = await signup(email, password, fullName);
    setLoading(false);
    if (result.error) return setErr(result.error);
    nav({ to: "/dashboard" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="panel w-full max-w-md">
        <div className="panel-header"><span>// REQUEST ACCESS</span><span className="status-dot text-[color:var(--signal-warn)]" /></div>
        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <h1 className="text-2xl font-bold">Create operator account</h1>
          <div className="space-y-2"><Label htmlFor="name">Full name</Label><Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required /></div>
          <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="space-y-2"><Label htmlFor="password">Password</Label><Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
          {err && <p className="text-sm text-destructive font-mono">{err}</p>}
          <Button type="submit" disabled={loading} className="w-full">{loading ? "Provisioning…" : "Create account"}</Button>
          <p className="text-sm text-muted-foreground text-center"><Link to="/login" className="text-primary hover:underline">Back to sign in</Link></p>
        </form>
      </div>
    </div>
  );
}
