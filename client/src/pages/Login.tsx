import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Loader2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";

export default function Login() {
  const [, navigate] = useLocation();
  const { login, isLoading } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try { await login(email, password); navigate("/"); }
    catch (err: any) { toast({ title: "Sign in failed", description: err.message, variant: "destructive" }); }
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
        <Card className="border-border/60">
          <CardHeader className="pb-4"><CardTitle className="text-lg">Sign in</CardTitle><CardDescription>Access your protocols</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required /></div>
              <div className="space-y-1.5"><Label>Password</Label><Input type="password" placeholder="Your password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
              <Button type="submit" className="w-full" disabled={isLoading || !email || !password}>
                {isLoading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}{isLoading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">No account? <Link href="/register"><a className="text-primary font-medium hover:underline">Create one</a></Link></p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
