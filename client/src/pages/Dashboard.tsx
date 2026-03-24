import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FlaskConical, CheckCircle, AlertTriangle, Bell, Plus, ChevronRight,
  Zap, Play, Pause, XCircle, LogOut, Activity, Loader2,
  ShieldAlert, Stethoscope, Timer, Eye, Pill, Trash2, Pencil, X, Check } from "lucide-react";
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
interface UserSupplement { id: number; name: string; dose: string; unit: string; frequency: string; notes: string | null; }
interface SupplementAnalysis {
  summary: string;
  overallRisk: "low" | "moderate" | "high";
  items: { name: string; currentDose: string | null; recommendedDose: string | null; status: string; note: string }[];
  timingSchedule: { time: string; supplements: string[]; reason: string }[];
  interactions: { supplements: string[]; type: string; risk: string; reason: string; recommendation: string }[];
  missingFromStack: string[];
  stackOptimisation: string[];
}

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

// ─── Supplements tab ──────────────────────────────────────────────────────────────
const UNITS = ["mg", "mcg", "IU", "g", "ml", "mmol", "capsule", "tablet"];
const FREQUENCIES = ["daily", "twice daily", "three times daily", "every other day", "weekly"];
const statusStyle: Record<string, string> = {
  sufficient:       "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  insufficient:     "text-amber-400 bg-amber-500/10 border-amber-500/20",
  excess:           "text-red-400 bg-red-500/10 border-red-500/20",
  not_in_protocol:  "text-sky-400 bg-sky-500/10 border-sky-500/20",
  not_taking:       "text-muted-foreground bg-muted border-border",
};
const statusLabel: Record<string, string> = {
  sufficient: "Sufficient", insufficient: "Insufficient", excess: "Excess",
  not_in_protocol: "Not in protocol", not_taking: "Not taking",
};

interface SplitSlot { time: string; dose: string; unit: string; notes: string; }
interface LookupResult { name: string; hasSplitDose?: boolean; commonDose: string; unit: string; frequency: string;
  splitSchedule?: SplitSlot[];
  typicalRange: string; upperLimit: string; bestTiming: string; notes: string; warnings: string; }

function SupplementsTab({ userId }: { userId: number }) {
  const { toast } = useToast();
  // "idle" → user clicks Add → "searching" (shows search box)
  // → lookup returns result → "confirm" (shows pre-filled card to review & tweak)
  // → save → "idle"
  type AddMode = "idle" | "searching" | "looking" | "confirm";
  const [addMode, setAddMode] = useState<AddMode>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  // form used both for "confirm" (new) and "edit" (existing)
  const [form, setForm] = useState({ name: "", dose: "", unit: "mg", frequency: "daily", notes: "" });
  const [analysis, setAnalysis] = useState<SupplementAnalysis | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const { data: supplements, refetch } = useQuery<UserSupplement[]>({
    queryKey: ["/api/supplements"],
    refetchOnWindowFocus: true,
  });

  const addM = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/supplements", data),
    onSuccess: () => {
      refetch(); resetAdd();
      toast({ title: "Supplement added" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const editM = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/supplements/${id}`, data),
    onSuccess: () => { refetch(); setEditId(null); setAddMode("idle"); toast({ title: "Updated" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/supplements/${id}`),
    onSuccess: () => { refetch(); setAnalysis(null); toast({ title: "Removed" }); },
  });

  function resetAdd() {
    setAddMode("idle"); setSearchQuery(""); setLookupResult(null); setEditId(null);
    setForm({ name: "", dose: "", unit: "mg", frequency: "daily", notes: "" });
  }

  async function doLookup() {
    if (!searchQuery.trim()) return;
    setAddMode("looking");
    try {
      const data: LookupResult = await apiRequest("POST", "/api/supplements/lookup", { name: searchQuery.trim() });
      if ((data as any).error) throw new Error((data as any).error);
      setLookupResult(data);
      // Split-dose products (e.g. AM/PM multivitamins): pre-fill with first slot
      // Each slot will be saved as a separate supplement entry
      const firstSlot = data.hasSplitDose && data.splitSchedule?.[0];
      setForm({
        name: data.name || searchQuery.trim(),
        dose: firstSlot ? firstSlot.dose : (data.commonDose || ""),
        unit: firstSlot ? firstSlot.unit : (data.unit || "mg"),
        frequency: data.frequency || "daily",
        notes: firstSlot ? `${firstSlot.time}${firstSlot.notes ? ` — ${firstSlot.notes}` : ""}` : (data.bestTiming || ""),
      });
      setAddMode("confirm");
    } catch (e: any) {
      toast({ title: "Lookup failed", description: e.message, variant: "destructive" });
      setAddMode("searching");
    }
  }

  function startEdit(s: UserSupplement) {
    setEditId(s.id);
    setForm({ name: s.name, dose: s.dose, unit: s.unit, frequency: s.frequency, notes: s.notes || "" });
    setLookupResult(null);
    setAddMode("confirm");
  }

  async function handleSave() {
    if (!form.name.trim() || !form.dose.trim()) return;
    if (editId) {
      editM.mutate({ id: editId, data: form });
      return;
    }
    // Split-dose product: save each slot separately
    const slots = lookupResult?.hasSplitDose && lookupResult.splitSchedule?.length
      ? lookupResult.splitSchedule
      : null;
    if (slots) {
      try {
        for (const slot of slots) {
          await apiRequest("POST", "/api/supplements", {
            userId,
            name: lookupResult!.name,
            dose: slot.dose,
            unit: slot.unit,
            frequency: "daily",
            notes: `${slot.time}${slot.notes ? ` — ${slot.notes}` : ""}`,
          });
        }
        refetch(); resetAdd();
        toast({ title: `Added ${slots.length} formulas`, description: `${lookupResult!.name} saved as ${slots.length} separate entries.` });
      } catch (e: any) {
        toast({ title: "Failed", description: e.message, variant: "destructive" });
      }
    } else {
      addM.mutate({ ...form, userId });
    }
  }

  async function runAnalysis() {
    setAnalysing(true); setAnalysis(null);
    try {
      const data = await apiRequest("POST", "/api/supplements/analyse");
      setAnalysis(data);
    } catch (e: any) { toast({ title: "Analysis failed", description: e.message, variant: "destructive" }); }
    finally { setAnalysing(false); }
  }

  const riskColor = { low: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    moderate: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    high: "text-red-400 bg-red-500/10 border-red-500/20" };

  const isSaving = addM.isPending || editM.isPending;

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-foreground">My Supplements</p>
          <p className="text-xs text-muted-foreground">{(supplements ?? []).length} supplement{(supplements ?? []).length !== 1 ? "s" : ""} logged</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
            onClick={runAnalysis} disabled={analysing}>
            {analysing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            {analysing ? "Analysing…" : "Analyse vs protocols"}
          </Button>
          {addMode === "idle" && (
            <Button size="sm" className="gap-1.5" onClick={() => setAddMode("searching")}>
              <Plus className="w-3.5 h-3.5" /> Add supplement
            </Button>
          )}
        </div>
      </div>

      {/* Step 1: Search */}
      {addMode === "searching" && (
        <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-3">
          <p className="text-sm font-semibold text-foreground">Search supplement</p>
          <p className="text-xs text-muted-foreground">Type a supplement name and we’ll look up the standard dosage, timing, and safety info for you.</p>
          <div className="flex gap-2">
            <input
              autoFocus
              className="flex-1 rounded-lg border border-border bg-background text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="e.g. Vitamin D3, Magnesium Glycinate, Zinc…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doLookup()}
            />
            <Button size="sm" className="gap-1.5 shrink-0" onClick={doLookup} disabled={!searchQuery.trim()}>
              Search
            </Button>
            <Button size="sm" variant="ghost" onClick={resetAdd}><X className="w-4 h-4" /></Button>
          </div>
        </div>
      )}

      {/* Step 1.5: Loading */}
      {addMode === "looking" && (
        <div className="rounded-xl border border-primary/20 bg-card p-6 flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
          <div>
            <p className="text-sm font-semibold text-foreground">Looking up “{searchQuery}”…</p>
            <p className="text-xs text-muted-foreground mt-0.5">Fetching evidence-based dosage information.</p>
          </div>
        </div>
      )}

      {/* Step 2: Review + confirm (also used for edit) */}
      {addMode === "confirm" && (
        <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">{editId ? "Edit supplement" : "Review & confirm"}</p>
            <button onClick={resetAdd} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
          </div>

          {/* Lookup info card (new only) */}
          {lookupResult && !editId && (
            <div className="rounded-lg bg-muted/30 border border-border/50 p-3 space-y-1.5 text-xs">
              {lookupResult.notes && <p className="text-foreground/80">{lookupResult.notes}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                {lookupResult.typicalRange && <span>Range: <span className="text-foreground font-medium">{lookupResult.typicalRange}</span></span>}
                {lookupResult.upperLimit && <span>Upper limit: <span className="text-foreground font-medium">{lookupResult.upperLimit}</span></span>}
              </div>
              {lookupResult.warnings && (
                <div className="flex items-start gap-1.5 bg-amber-500/10 rounded-lg p-2 border border-amber-500/20 mt-1">
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                  <span className="text-amber-300">{lookupResult.warnings}</span>
                </div>
              )}
              {/* Split-dose notice */}
              {lookupResult.hasSplitDose && lookupResult.splitSchedule && lookupResult.splitSchedule.length > 0 && (
                <div className="bg-sky-500/10 border border-sky-500/20 rounded-lg p-2.5 space-y-2">
                  <p className="text-sky-400 font-semibold">Split-dose product — {lookupResult.splitSchedule.length} separate formulas</p>
                  {lookupResult.splitSchedule.map((slot, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-sky-300 font-bold">{slot.dose} {slot.unit}</span>
                      <span className="text-muted-foreground">{slot.time}{slot.notes ? ` — ${slot.notes}` : ""}</span>
                    </div>
                  ))}
                  <p className="text-muted-foreground text-[10px]">Each formula below will be saved as a separate entry in your stack.</p>
                </div>
              )}
            </div>
          )}

          {/* Editable fields — pre-filled from lookup */}
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Name</label>
              <input className="w-full rounded-lg border border-border bg-background text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Dose</label>
              <input className="w-full rounded-lg border border-border bg-background text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                value={form.dose} onChange={e => setForm(f => ({ ...f, dose: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Unit</label>
              <select className="w-full rounded-lg border border-border bg-background text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Frequency</label>
              <select className="w-full rounded-lg border border-border bg-background text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}>
                {FREQUENCIES.map(fr => <option key={fr} value={fr}>{fr}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Notes <span className="opacity-60">(timing, brand, form)</span></label>
              <input className="w-full rounded-lg border border-border bg-background text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="e.g. softgel, with fat, morning"
                value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="gap-1.5" onClick={handleSave}
              disabled={!form.name.trim() || !form.dose.trim() || isSaving}>
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {editId ? "Save changes" : "Add to my stack"}
            </Button>
            {!editId && (
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setAddMode("searching")}>
                ← Search again
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Supplement list */}
      {(supplements ?? []).length === 0 && addMode === "idle" ? (
        <div className="rounded-xl border border-dashed border-border/60 p-10 text-center">
          <Pill className="w-9 h-9 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No supplements logged yet</p>
          <p className="text-xs text-muted-foreground mt-1">Add the supplements you are currently taking to check them against your active protocols.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(supplements ?? []).map(s => (
            <div key={s.id} className="flex items-center gap-4 rounded-xl border border-border/60 bg-card px-4 py-3">
              {/* Dosage — the primary fact */}
              <div className="shrink-0 text-center min-w-[56px]">
                <p className="text-lg font-bold text-foreground leading-none">{s.dose}</p>
                <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wide mt-0.5">{s.unit}</p>
              </div>
              <div className="w-px h-8 bg-border/60 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground leading-snug">{s.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {s.frequency}{s.notes ? ` · ${s.notes}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => startEdit(s)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => deleteM.mutate(s.id)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Analysis result */}
      {analysis && (
        <div className="rounded-xl border border-primary/20 bg-card p-5 space-y-5">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-foreground">Stack Analysis</h3>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{analysis.summary}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${riskColor[analysis.overallRisk]}`}>
                {analysis.overallRisk} risk
              </span>
              <button onClick={() => setAnalysis(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Timing schedule */}
          {(analysis.timingSchedule ?? []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-sky-400 uppercase tracking-wide">Recommended timing schedule</p>
              {(analysis.timingSchedule ?? []).map((slot, i) => (
                <div key={i} className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                  <p className="text-xs font-bold text-sky-400 mb-1.5">{slot.time}</p>
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {slot.supplements.map((s, j) => (
                      <span key={j} className="text-[11px] font-medium bg-sky-500/10 text-sky-300 border border-sky-500/20 px-2 py-0.5 rounded-full">{s}</span>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{slot.reason}</p>
                </div>
              ))}
            </div>
          )}

          {/* Interactions */}
          {(analysis.interactions ?? []).length > 0 && (() => {
            const typeLabel: Record<string, string> = {
              absorption_competition: "Absorption competition",
              receptor_competition: "Receptor competition",
              counteraction: "Counteraction",
              synergy: "Synergy",
              timing_conflict: "Timing conflict",
            };
            const typeColor: Record<string, string> = {
              absorption_competition: "text-amber-400 bg-amber-500/10 border-amber-500/20",
              receptor_competition: "text-red-400 bg-red-500/10 border-red-500/20",
              counteraction: "text-red-400 bg-red-500/10 border-red-500/20",
              synergy: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
              timing_conflict: "text-amber-400 bg-amber-500/10 border-amber-500/20",
            };
            const issues = (analysis.interactions ?? []).filter(ix => ix.type !== "synergy");
            const synergies = (analysis.interactions ?? []).filter(ix => ix.type === "synergy");
            return (
              <>
                {issues.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Conflicts & interactions</p>
                    {issues.map((ix, i) => (
                      <div key={i} className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border shrink-0 ${typeColor[ix.type] || "text-muted-foreground bg-muted border-border"}`}>
                            {typeLabel[ix.type] || ix.type}
                          </span>
                          <span className={`text-[10px] font-bold uppercase ${ix.risk === "high" ? "text-red-400" : ix.risk === "moderate" ? "text-amber-400" : "text-muted-foreground"}`}>{ix.risk} risk</span>
                          <p className="text-xs font-semibold text-foreground">{ix.supplements.join(" × ")}</p>
                        </div>
                        <p className="text-xs text-muted-foreground">{ix.reason}</p>
                        {ix.recommendation && (
                          <p className="text-xs text-primary font-medium">→ {ix.recommendation}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {synergies.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">Synergies</p>
                    {synergies.map((ix, i) => (
                      <div key={i} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
                        <p className="text-xs font-semibold text-foreground">{ix.supplements.join(" + ")}</p>
                        <p className="text-xs text-muted-foreground">{ix.reason}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {/* Per-supplement dosage status */}
          {(analysis.items ?? []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Dosage vs protocol</p>
              {(analysis.items ?? []).map((item, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3">
                  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border shrink-0 mt-0.5 ${statusStyle[item.status] || "text-muted-foreground bg-muted border-border"}`}>
                    {statusLabel[item.status] || item.status}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground">{item.name}</p>
                    <div className="flex flex-wrap gap-3 mt-0.5">
                      {item.currentDose && <span className="text-xs text-muted-foreground">Taking: <span className="text-foreground font-bold">{item.currentDose}</span></span>}
                      {item.recommendedDose && <span className="text-xs text-muted-foreground">Protocol: <span className="text-primary font-medium">{item.recommendedDose}</span></span>}
                    </div>
                    {item.note && <p className="text-xs text-muted-foreground mt-1">{item.note}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Missing from stack */}
          {(analysis.missingFromStack ?? []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Missing from your stack</p>
              <div className="flex flex-wrap gap-2">
                {(analysis.missingFromStack ?? []).map((s, i) => (
                  <span key={i} className="text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-lg">{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Stack optimisation tips */}
          {(() => {
            // AI sometimes returns this as a string instead of array — normalise
            const tips = Array.isArray(analysis.stackOptimisation)
              ? analysis.stackOptimisation
              : analysis.stackOptimisation ? [analysis.stackOptimisation as unknown as string] : [];
            return tips.length > 0 ? (
              <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 space-y-1.5">
                <p className="text-xs font-semibold text-primary uppercase tracking-wide">Stack optimisation</p>
                {tips.map((tip, i) => (
                  <p key={i} className="text-xs text-foreground/80">→ {tip}</p>
                ))}
              </div>
            ) : null;
          })()}
        </div>
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
  const [tab, setTab] = useState<"active" | "library" | "nudges" | "supplements">("active");
  const [crossRef, setCrossRef] = useState<CrossRefResult | null>(null);
  const [crossRefLoading, setCrossRefLoading] = useState(false);

  const { data: userProtocols, refetch: refetchActive } = useQuery<UserProtocol[]>({
    queryKey: ["/api/user/protocols"],
    refetchInterval: 10000,          // poll every 10s
    refetchOnWindowFocus: "always",  // always refetch on tab focus, no debounce
    staleTime: 0,                    // always treat as stale — never show cached version
  });
  const { data: library } = useQuery<Protocol[]>({
    queryKey: ["/api/protocols"],
    refetchInterval: 10000,
    refetchOnWindowFocus: "always",
    staleTime: 0,
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
          <button className={tabClass("supplements")} onClick={() => setTab("supplements")}>
            <span className="flex items-center gap-1.5"><Pill className="w-3.5 h-3.5" />Supplements</span>
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

        {tab === "supplements" && user && (
          <SupplementsTab userId={user.id} />
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
