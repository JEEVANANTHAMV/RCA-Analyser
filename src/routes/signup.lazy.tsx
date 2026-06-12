import { createLazyFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, type FormEvent } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useServerFn } from "@tanstack/react-start";
import { validateInviteCodeFn } from "@/lib/auth.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle, KeyRound, UserPlus, Loader2 } from "lucide-react";

export const Route = createLazyFileRoute("/signup")({
  component: SignupPage,
});

function SignupPage() {
  const { code: urlCode } = Route.useSearch();
  const nav = useNavigate();
  const { signupWithInvite } = useAuth();

  const [inviteCode, setInviteCode] = useState(urlCode || "");
  const [isVerified, setIsVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [lockedEmail, setLockedEmail] = useState<string | null>(null);
  const [signupErr, setSignupErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const validateCode = useServerFn(validateInviteCodeFn);

  const handleVerify = useCallback(
    async (codeToVerify: string) => {
      if (!codeToVerify.trim()) return;
      setVerifying(true);
      setVerifyErr(null);
      try {
        const invite = await validateCode({ data: { code: codeToVerify } });
        setIsVerified(true);
        if (invite.email) {
          setEmail(invite.email);
          setLockedEmail(invite.email);
        } else {
          setLockedEmail(null);
        }
      } catch (e: unknown) {
        setIsVerified(false);
        const message = e instanceof Error ? e.message : String(e);
        setVerifyErr(message || "Invalid or expired invite code");
      } finally {
        setVerifying(false);
      }
    },
    [validateCode],
  );

  useEffect(() => {
    if (urlCode) {
      handleVerify(urlCode);
    }
  }, [urlCode, handleVerify]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isVerified) return;
    setSignupErr(null);
    setLoading(true);
    const result = await signupWithInvite(inviteCode, email, password, fullName);
    setLoading(false);
    if (result.error) return setSignupErr(result.error);
    nav({ to: "/dashboard" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="panel w-full max-w-md">
        <div className="panel-header">
          <span>// OPERATOR REGISTER</span>
          <span
            className={`status-dot ${isVerified ? "text-[color:var(--signal-ok)]" : "text-[color:var(--signal-warn)]"}`}
          />
        </div>

        {!isVerified ? (
          <div className="p-6 space-y-4">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-primary animate-pulse" />
              Invite Required
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Registration on this RCA Console is restricted. You must enter a valid invite code
              from your Administrator to create an account.
            </p>

            <div className="space-y-2 mt-4">
              <Label htmlFor="code-input">Invite Code</Label>
              <div className="flex gap-2">
                <Input
                  id="code-input"
                  placeholder="e.g. ABCD-1234"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  className="mono uppercase text-sm"
                />
                <Button
                  onClick={() => handleVerify(inviteCode)}
                  disabled={verifying || !inviteCode.trim()}
                >
                  {verifying ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking…</>) : "Verify"}
                </Button>
              </div>
              {verifyErr && (
                <p className="text-xs text-destructive font-mono flex items-center gap-1 mt-1">
                  <XCircle className="w-3.5 h-3.5" />
                  {verifyErr}
                </p>
              )}
            </div>

            <div className="border-t border-border/50 pt-4 mt-6 flex justify-between text-xs text-muted-foreground mono">
              <span>RCA.OPS v1.0</span>
              <Link to="/login" className="text-primary hover:underline">
                Back to sign in
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <UserPlus className="w-5 h-5 text-[color:var(--signal-ok)]" />
              <h1 className="text-xl font-bold">Register Operator</h1>
            </div>

            <div className="bg-[color:var(--color-signal-ok)]/10 border border-[color:var(--color-signal-ok)]/30 rounded p-3 text-xs mono text-[color:var(--signal-ok)] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Invite verified successfully!</span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                placeholder="e.g. John Doe"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={!!lockedEmail}
                placeholder="e.g. operator@company.com"
                className={
                  lockedEmail ? "bg-muted text-muted-foreground mono cursor-not-allowed" : ""
                }
              />
              {lockedEmail && (
                <p className="text-[10px] text-muted-foreground mono">
                  // Locked to invited email address
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                placeholder="Minimum 8 characters"
              />
            </div>

            {signupErr && (
              <p className="text-xs text-destructive font-mono flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" />
                {signupErr}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full mt-2">
              {loading ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Provisioning Account…</>) : "Create Operator Account"}
            </Button>

            <div className="flex justify-between text-xs text-muted-foreground mono border-t border-border/50 pt-4 mt-6">
              <button
                type="button"
                onClick={() => {
                  setIsVerified(false);
                  if (!urlCode) setInviteCode("");
                }}
                className="hover:text-primary transition-colors"
              >
                // Use different code
              </button>
              <Link to="/login" className="text-primary hover:underline">
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
