import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FlaskConical, CheckCircle, Clock, AlertTriangle, Bell, Plus, ChevronRight,
  Zap, Play, Pause, XCircle, LogOut, Activity, CheckSquare, RefreshCw, Loader2,
  ShieldAlert, Stethoscope, Timer, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";
import { apiRequest, queryClient } from "@/lib/queryClient";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Protocol { id: number; name: string; description: string | null; category: string;
  priority: string; steps: string[] | null; dosage: string | null; duration: string | null;
  monitoring: string | null; completionCriteria: string | null; conflictsWith: string[] | null;
  contraindications: string | null; sourceModule: string; }
interface UserProtocol { id: number; protocolId: number; status: string; adherenceScore: number | null;
  lastCheckinAt: string | null; conflictFlag: boolean; conflictDetails: any; protocol?: Protocol; startedAt: string; }
interface Nudge { id: number; type: string; title: string; body: string | null; createdAt: string; userProtocolId: number; readAt?: string | null; }
interface CrossRefResult { summary: string; conflicts: { protocolA: string; protocolB: string; reason: string }[];
  dosageTotals: { supplement: string; totalDose: string; safetyNote: string }[];
  sequenceRecommendations: string[]; overallRisk: "low" | "moderate" | "high"; }

// ─── Category colours ─────────────────────────────────────────────────────────
const catColor: Record<string, string> = {
  supplements: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  diet: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  lifestyle: "text-sky-400 bg-sky-500/10 border-sky-500/20",
  injectables: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  medical: "text-red-400 bg-red-500/10 border-red-500/20",
  habits: "text-teal-400 bg-teal-500/10 border-teal-500/20",
};
const priorityColor = { high: "text-red-400", medium: "text-amber-400", low: "text-muted-foreground" };

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Protocol detail panel (shared) ─────────────────────────────────────────
function ProtocolDetail({ protocol, onActivate, isActivating, isPaused, onPause, onResume, onComplete, onCheckin, mode }:
  { protocol: Protocol; onActivate?: () => void; isActivating?: boolean;
    isPaused?: boolean; onPause?: () => void; onResume?: () => void;
    onComplete?: () => void; onCheckin?: () => void; mode: "library" | "active"; }) {
  return (
    <div className="border-t border-border/50 p-4 space-y-3">
      {protocol.steps && protocol.steps.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Protocol steps</p>
          <ol className="space-y-1.5">
            {protocol.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-foreground/80">
                <span className="w-4 h-4 rounded-full bg-primary/15 text-primary font-semibold text-[10px] flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {protocol.dosage && (
          <div className="bg-muted/40 rounded-lg p-2.5 col-span-2">
            <div className="flex items-center gap-1.5 mb-1"><Stethoscope className="w-3 h-3 text-primary" /><p className="text-muted-foreground font-medium">Dosage</p></div>
            <p className="text-foreground font-semibold">{protocol.dosage}</p>
          </div>
        )}
        {protocol.duration && (
          <div className="bg-muted/40 rounded-lg p-2.5">
            <div className="flex items-center gap-1.5 mb-1"><Timer className="w-3 h-3 text-sky-400" /><p className="text-muted-foreground font-medium">Duration</p></div>
            <p className="text-foreground font-medium">{protocol.duration}</p>
          </div>
        )}
        {protocol.monitoring && (
          <div className="bg-muted/40 rounded-lg p-2.5">
            <div className="flex items-center gap-1.5 mb-1"><Eye className="w-3 h-3 text-emerald-400" /><p className="text-muted-foreground font-medium">Monitor</p></div>
            <p className="text-foreground font-medium">{protocol.monitoring}</p>
          </div>
        )}
        {protocol.completionCriteria && (
          <div className="bg-muted/40 rounded-lg p-2.5 col-span-2">
            <div className="flex items-center gap-1.5 mb-1"><CheckCircle className="w-3 h-3 text-emerald-400" /><p className="text-muted-foreground font-medium">Done when</p></div>
            <p className="text-foreground font-medium">{protocol.completionCriteria}</p>
          </div>
        )}
      </div>
      {protocol.contraindications && (
        <div className="flex items-start gap-2 bg-amber-500/10 rounded-lg p-2.5 border border-amber-500/20">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300">{protocol.contraindications}</p>
        </div>
      )}
      {mode === "library" && onActivate && (
        <Button size="sm" className="w-full gap-2" onClick={onActivate} disabled={isActivating}>
          <Play className="w-3.5 h-3.5" /> {isActivating ? "Activating…" : "Activate protocol"}
        </Button>
      )}
      {mode === "active" && (
        <div className="flex gap-2">
          {onCheckin && (
            <Button size="sm" variant="default" className="flex-1 gap-1.5" onClick={onCheckin}>
              <CheckSquare className="w-3.5 h-3.5" /> Check in
            </Button>
          )}
          {!isPaused && onPause && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={onPause}>
              <Pause className="w-3.5 h-3.5" /> Pause
            </Button>
          )}
          {isPaused && onResume && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={onResume}>
              <Play className="w-3.5 h-3.5" /> Resume
            </Button>
          )}
          {onComplete && (
            <Button size="sm" variant="ghost" className="gap-1.5 text-emerald-400 hover:text-emerald-300" onClick={onComplete}>
              <CheckCircle className="w-3.5 h-3.5" /> Done
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Protocol card (library) ──────────────────────────────────────────────────
function ProtocolCard({ protocol, onActivate, isActivating }: { protocol: Protocol; onActivate: () => void; isActivating: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-border/60 bg-card hover:border-primary/30 transition-colors">
      <button className="w-full text-left p-4" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${catColor[protocol.category] || "text-muted-foreground bg-muted border-border"}`}>
                {protocol.category}
              </span>
              <span className={`text-[10px] font-medium uppercase ${priorityColor[protocol.priority as keyof typeof priorityColor] || ""}`}>
                {protocol.priority}
              </span>
              {protocol.sourceModule !== "manual" && (
                <span className="text-[10px] text-muted-foreground">via {protocol.sourceModule}</span>
              )}
            </div>
            <p className="text-sm font-semibold text-foreground leading-snug">{protocol.name}</p>
            {protocol.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{protocol.description}</p>}
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform mt-0.5 ${expanded ? "rotate-90" : ""}`} />
        </div>
      </button>
      {expanded && (
        <ProtocolDetail protocol={protocol} mode="library" onActivate={onActivate} isActivating={isActivating} />
      )}
    </div>
  );
}

// Parse a duration string like "3 months" or "6 weeks" into days
function parseDurationDays(duration: string | null): number | null {
  if (!duration) return null;
  const m = duration.match(/(\d+)\s*(day|week|month|year)/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("day")) return n;
  if (unit.startsWith("week")) return n * 7;
  if (unit.startsWith("month")) return n * 30;
  if (unit.startsWith("year")) return n * 365;
  return null;
}

// ─── Active protocol card (expandable) ───────────────────────────────────────
function ActiveProtocolCard({ up, onCheckin, onPause, onResume, onComplete }: {
  up: UserProtocol; onCheckin: () => void; onPause: () => void; onResume: () => void; onComplete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const p = up.protocol;
  const daysSince = Math.floor((Date.now() - new Date(up.startedAt).getTime()) / 86400000);
  const isPaused = up.status === "paused";
  const totalDays = parseDurationDays(p?.duration ?? null);
  const progressPct = totalDays ? Math.min(100, Math.round((daysSince / totalDays) * 100)) : null;

  return (
    <div className={`rounded-xl border bg-card transition-colors ${up.conflictFlag ? "border-amber-500/40" : isPaused ? "border-border/30 opacity-70" : "border-border/60 hover:border-primary/30"}`}>
      {/* Header — always visible, clickable to expand */}
      <button className="w-full text-left p-4" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {up.conflictFlag && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                  <AlertTriangle className="w-2.5 h-2.5" /> Conflict
                </span>
              )}
              <span className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded border ${
                isPaused ? "text-muted-foreground border-border bg-muted" : "text-primary border-primary/30 bg-primary/10"}`}>
                {isPaused ? "on hold" : "active"}
              </span>
              {p && <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded border ${catColor[p.category] || ""}`}>{p.category}</span>}
              {p?.priority && <span className={`text-[10px] font-medium uppercase ${priorityColor[p.priority as keyof typeof priorityColor] || ""}`}>{p.priority}</span>}
            </div>
            <p className="text-sm font-semibold text-foreground">{p?.name ?? "Protocol"}</p>
            {p?.dosage && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                <span className="text-muted-foreground/70">Dosage: </span>{p.dosage}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              Day {daysSince + 1}{p?.duration ? ` of ${p.duration}` : ""}
              {up.lastCheckinAt && ` · Last logged ${timeAgo(up.lastCheckinAt)}`}
            </p>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform mt-1 ${expanded ? "rotate-90" : ""}`} />
        </div>

        {/* Duration progress bar — only shown when duration is known */}
        {progressPct !== null && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">Time elapsed</span>
              <span className="text-xs font-semibold text-foreground">{progressPct}%</span>
            </div>
            <Progress value={progressPct} className="h-1.5" />
          </div>
        )}

        {/* Conflict details */}
        {up.conflictFlag && up.conflictDetails && (
          <div className="mt-2 bg-amber-500/10 rounded-lg p-2.5 border border-amber-500/20 space-y-1">
            <p className="text-xs font-semibold text-amber-400">⚠️ Potential conflicts detected</p>
            {(up.conflictDetails as any[]).map((c: any, i: number) => (
              <p key={i} className="text-xs text-amber-300/80">{c.reason}</p>
            ))}
          </div>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && p && (
        <ProtocolDetail
          protocol={p}
          mode="active"
          isPaused={isPaused}
          onCheckin={onCheckin}
          onPause={onPause}
          onResume={onResume}
          onComplete={onComplete}
        />
      )}
    </div>
  );
}

// ─── Cross-reference result panel ────────────────────────────────────────────
function CrossRefPanel({ result }: { result: CrossRefResult }) {
  const riskColor = { low: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    moderate: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    high: "text-red-400 bg-red-500/10 border-red-500/20" };
  return (
    <div className="rounded-xl border border-primary/20 bg-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-foreground">Protocol Cross-Reference</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{result.summary}</p>
        </div>
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border shrink-0 ${riskColor[result.overallRisk]}`}>
          {result.overallRisk} risk
        </span>
      </div>

      {result.conflicts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Conflicts</p>
          {result.conflicts.map((c, i) => (
            <div key={i} className="flex items-start gap-2 bg-amber-500/8 border border-amber-500/20 rounded-lg p-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-foreground">{c.protocolA} × {c.protocolB}</p>
                <p className="text-xs text-muted-foreground">{c.reason}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {result.dosageTotals.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-primary uppercase tracking-wide">Combined Dosages</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {result.dosageTotals.map((d, i) => (
              <div key={i} className="bg-muted/40 rounded-lg p-2.5">
                <p className="text-xs font-semibold text-foreground">{d.supplement}</p>
                <p className="text-xs text-primary font-medium">{d.totalDose}</p>
                {d.safetyNote && <p className="text-[10px] text-muted-foreground mt-0.5">{d.safetyNote}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {result.sequenceRecommendations.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-sky-400 uppercase tracking-wide">Sequence & Timing</p>
          {result.sequenceRecommendations.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-foreground/80">
              <span className="w-4 h-4 rounded-full bg-sky-500/15 text-sky-400 font-semibold text-[10px] flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
              {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<"active" | "library" | "nudges">("active");
  const [crossRef, setCrossRef] = useState<CrossRefResult | null>(null);
  const [crossRefLoading, setCrossRefLoading] = useState(false);

  const { data: userProtocols, refetch: refetchActive } = useQuery<UserProtocol[]>({
    queryKey: ["/api/user/protocols"],
    // Refetch every 15 seconds so pushed protocols appear without relogin
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
  const { data: library } = useQuery<Protocol[]>({
    queryKey: ["/api/protocols"],
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
  const { data: nudges, refetch: refetchNudges } = useQuery<Nudge[]>({ queryKey: ["/api/nudges"] });

  const activateM = useMutation({
    mutationFn: (protocolId: number) => apiRequest("POST", `/api/user/protocols/${protocolId}/activate`),
    onSuccess: (data: any) => {
      refetchActive();
      if (data.hasConflict) {
        toast({ title: "⚠️ Conflict detected", description: data.conflicts?.[0]?.reason, variant: "destructive" });
      } else {
        toast({ title: "Protocol activated", description: "Check in daily to track adherence." });
      }
    },
  });

  const updateM = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => apiRequest("PATCH", `/api/user/protocols/${id}`, { status }),
    onSuccess: () => { refetchActive(); queryClient.invalidateQueries({ queryKey: ["/api/nudges"] }); },
  });

  const checkinM = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/user/protocols/${id}/checkin`, { completedSteps: [], note: "" }),
    onSuccess: () => { refetchActive(); toast({ title: "Checked in ✓", description: "Adherence updated." }); },
  });

  const readNudgeM = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/nudges/${id}/read`),
    onSuccess: refetchNudges,
  });

  async function runCrossRef() {
    const active = (userProtocols ?? []).filter(up => up.status === "active");
    if (active.length < 1) {
      toast({ title: "No active protocols", description: "Activate at least one protocol first.", variant: "destructive" });
      return;
    }
    setCrossRefLoading(true);
    setCrossRef(null);
    try {
      const data = await apiRequest("POST", "/api/protocols/cross-reference");
      setCrossRef(data);
      setTab("active");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setCrossRefLoading(false);
    }
  }

  const activeProtocols = (userProtocols ?? []).filter(up => up.status === "active");
  const pausedProtocols = (userProtocols ?? []).filter(up => up.status === "paused");
  const unreadNudges = (nudges ?? []).filter(n => !n.readAt);

  const tabClass = (t: string) => `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
    tab === t ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
  }`;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-border/50 bg-background/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
              <FlaskConical className="w-4 h-4 text-primary" />
            </div>
            <span className="font-bold tracking-wide text-foreground">ProtocolRX</span>
          </div>
          <div className="flex items-center gap-2">
            {unreadNudges.length > 0 && (
              <button onClick={() => setTab("nudges")} className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                <Bell className="w-4 h-4" />
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary" />
              </button>
            )}
            <button onClick={logout} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Welcome + stats */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground">Hey, {user?.name?.split(" ")[0]}</h1>
            <p className="text-sm text-muted-foreground">{activeProtocols.length} active protocol{activeProtocols.length !== 1 ? "s" : ""}</p>
          </div>
          <div className="flex gap-3 flex-wrap">
            {[
              { label: "Active", value: activeProtocols.length, icon: Activity, color: "text-primary" },
              { label: "On hold", value: pausedProtocols.length, icon: Pause, color: "text-sky-400" },
              { label: "Conflicts", value: activeProtocols.filter(p => p.conflictFlag).length, icon: AlertTriangle, color: "text-amber-400" },
            ].map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="bg-card border border-border/50 rounded-xl px-4 py-2.5 text-center">
                <Icon className={`w-4 h-4 ${color} mx-auto mb-1`} />
                <p className="text-lg font-bold text-foreground leading-none">{value}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Cross-reference button */}
        {activeProtocols.length >= 1 && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              className="gap-2 border-primary/30 text-primary hover:bg-primary/10"
              onClick={runCrossRef}
              disabled={crossRefLoading}
            >
              {crossRefLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
              {crossRefLoading ? "Analysing protocols…" : "Cross-reference all protocols"}
            </Button>
            {crossRef && !crossRefLoading && (
              <button onClick={() => setCrossRef(null)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                Clear
              </button>
            )}
          </div>
        )}

        {/* Cross-reference result */}
        {crossRef && <CrossRefPanel result={crossRef} />}

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-card rounded-xl border border-border/50 w-fit">
          <button className={tabClass("active")} onClick={() => setTab("active")}>
            Active {activeProtocols.length > 0 && <span className="ml-1.5 text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">{activeProtocols.length}</span>}
          </button>
          <button className={tabClass("library")} onClick={() => setTab("library")}>Library</button>
          <button className={tabClass("nudges")} onClick={() => setTab("nudges")}>
            Nudges {unreadNudges.length > 0 && <span className="ml-1.5 text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">{unreadNudges.length}</span>}
          </button>
        </div>

        {/* Tab content */}
        {tab === "active" && (
          <div className="space-y-3">
            {activeProtocols.length === 0 && pausedProtocols.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 p-12 text-center">
                <FlaskConical className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No active protocols</p>
                <p className="text-xs text-muted-foreground mt-1">Browse the library to activate one, or connect BioMarkerLab to import protocols.</p>
                <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={() => setTab("library")}>
                  <Plus className="w-3.5 h-3.5" /> Browse library
                </Button>
              </div>
            ) : (
              <>
                {activeProtocols.map(up => (
                  <ActiveProtocolCard key={up.id} up={up}
                    onCheckin={() => checkinM.mutate(up.id)}
                    onPause={() => updateM.mutate({ id: up.id, status: "paused" })}
                    onResume={() => updateM.mutate({ id: up.id, status: "active" })}
                    onComplete={() => updateM.mutate({ id: up.id, status: "completed" })}
                  />
                ))}
                {pausedProtocols.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-2">On hold — excluded from cross-reference</p>
                    {pausedProtocols.map(up => (
                      <ActiveProtocolCard key={up.id} up={up}
                        onCheckin={() => checkinM.mutate(up.id)}
                        onPause={() => updateM.mutate({ id: up.id, status: "paused" })}
                        onResume={() => updateM.mutate({ id: up.id, status: "active" })}
                        onComplete={() => updateM.mutate({ id: up.id, status: "completed" })}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === "library" && (
          <div className="space-y-3">
            {(library ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 p-12 text-center">
                <p className="text-sm text-muted-foreground">No protocols yet. Connect BioMarkerLab to import AI-generated protocols.</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {(library ?? []).map(p => (
                  <ProtocolCard key={p.id} protocol={p}
                    onActivate={() => activateM.mutate(p.id)}
                    isActivating={activateM.isPending} />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "nudges" && (
          <div className="space-y-2">
            {(nudges ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 p-12 text-center">
                <Bell className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No nudges yet</p>
              </div>
            ) : (
              (nudges ?? []).map(n => (
                <div key={n.id} className={`rounded-xl border p-4 flex items-start gap-3 ${!n.readAt ? "border-primary/30 bg-primary/5" : "border-border/40 bg-card"}`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    n.type === "conflict_alert" ? "bg-amber-500/15" : "bg-primary/15"}`}>
                    {n.type === "conflict_alert" ? <AlertTriangle className="w-4 h-4 text-amber-400" /> : <Bell className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground">{n.title}</p>
                    {n.body && <p className="text-xs text-muted-foreground mt-0.5">{n.body}</p>}
                    <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(n.createdAt)}</p>
                  </div>
                  {!n.readAt && (
                    <button onClick={() => readNudgeM.mutate(n.id)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0">
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-border/40 py-4 mt-8">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} ProtocolRX</span>
          <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Created with Perplexity Computer</a>
        </div>
      </footer>
    </div>
  );
}
