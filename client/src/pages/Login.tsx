import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Loader2, FlaskConical, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";
import { API_BASE } from "@/lib/queryClient";

const DEFAULT_AXON_URL = "https://axon-production-7c23.up.railway.app";

export default function Login() {
  const [, navigate] = useLocation();
  const { login, isLoading } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // AXON SSO state
  const [showAxon, setShowAxon] = useState(false);
  const [axonUrl, setAxonUrl] = useState(DEFAULT_AXON_URL);
  const [axonEmail, setAxonEmail] = useState("");
  const [axonPassword, setAxonPassword] = useState("");
  const [axonLoading, setAxonLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try { await login(email, password); navigate("/"); }
    catch (err: any) { toast({ title: "Sign in failed", description: err.message, variant: "destructive" }); }
  }

  async function handleAxonLogin(e: React.FormEvent) {
    e.preventDefault();
    setAxonLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/axon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ axonUrl, email: axonEmail, password: axonPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login with AXON failed.");
      // Store token + user the same way as normal login
      try { sessionStorage.setItem("prx_token", data.token); sessionStorage.setItem("prx_user", JSON.stringify(data.user)); } catch {}
      navigate("/");
      window.location.reload(); // refresh to pick up new session
    } catch (err: any) {
      toast({ title: "AXON login failed", description: err.message, variant: "destructive" });
    } finally { setAxonLoading(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center mx-auto">
            <FlaskConical className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-xl font-bold tracking-wide">ProtocolRX</h1>
          <p className="text-sm text-muted-foreground">Evidence-based health protocols</p>
        </div>

        {!showAxon ? (
          <>
            {/* Login with AXON — primary */}
            <button
              onClick={() => setShowAxon(true)}
              className="w-full flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl border-2 border-[#00D4AA]/40 bg-[#00D4AA]/8 hover:bg-[#00D4AA]/15 text-[#00D4AA] font-semibold text-sm transition-colors"
            >
              <Link2 className="w-4 h-4" />
              Login with AXON
            </button>

            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-border/50" />
              <span className="text-xs text-muted-foreground">or use email</span>
              <div className="flex-1 border-t border-border/50" />
            </div>

            <Card className="border-border/60">
              <CardContent className="pt-4">
                <form onSubmit={handleSubmit} className="space-y-3">
                  <div className="space-y-1.5"><Label className="text-xs">Email</Label><Input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Password</Label><Input type="password" placeholder="Your password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
                  <Button type="submit" variant="outline" className="w-full" disabled={isLoading || !email || !password}>
                    {isLoading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}{isLoading ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
                <p className="mt-3 text-center text-xs text-muted-foreground">No account? <Link href="/register"><a className="text-primary font-medium hover:underline">Create one</a></Link></p>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="border-[#00D4AA]/30">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-[#00D4AA]" />
                <CardTitle className="text-base">Login with AXON</CardTitle>
              </div>
              <CardDescription className="text-xs">Use your AXON credentials to access ProtocolRX</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAxonLogin} className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">AXON URL</Label>
                  <Input placeholder="https://your-axon.up.railway.app" value={axonUrl}
                    onChange={e => setAxonUrl(e.target.value)} className="text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Email</Label>
                  <Input type="email" placeholder="your@email.com" value={axonEmail}
                    onChange={e => setAxonEmail(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Password</Label>
                  <Input type="password" placeholder="Your AXON password" value={axonPassword}
                    onChange={e => setAxonPassword(e.target.value)} required />
                </div>
                <Button type="submit" className="w-full gap-2"
                  style={{ background: "#00D4AA", color: "#0A0D0F" }}
                  disabled={axonLoading || !axonEmail || !axonPassword}>
                  {axonLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {axonLoading ? "Connecting…" : "Continue with AXON"}
                </Button>
                <button type="button" onClick={() => setShowAxon(false)}
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">
                  ← Back
                </button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
