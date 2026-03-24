import type { Express } from "express";
import type { Server } from "http";
import { registerAuthRoutes, requireAuth, type AuthRequest } from "./auth";
import { storage } from "./storage";
import type { Response } from "express";

export async function registerRoutes(httpServer: Server, app: Express) {
  registerAuthRoutes(app);

  app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "ProtocolRX" }));

  // ── Protocol library ──────────────────────────────────────────────────────
  // GET all available protocols (public + user's own)
  app.get("/api/protocols", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const protocols = await storage.getProtocols(req.userId);
      res.json(protocols);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // POST create a new protocol (from BioMarkerLab or manually)
  app.post("/api/protocols", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const protocol = await storage.createProtocol({ ...req.body, sourceUserId: req.userId });
      res.json(protocol);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── User protocols (activated instances) ─────────────────────────────────
  app.get("/api/user/protocols", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const userProtocols = await storage.getUserProtocols(req.userId!);
      res.json(userProtocols);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // POST activate a protocol — runs conflict check first
  app.post("/api/user/protocols/:protocolId/activate", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const protocolId = parseInt(req.params.protocolId);
      const protocol = await storage.getProtocolById(protocolId);
      if (!protocol) return res.status(404).json({ error: "Protocol not found." });

      // Run conflict check
      const { hasConflict, conflicts } = await storage.checkConflicts(req.userId!, protocol);

      // Activate regardless, but flag conflicts
      const userProtocol = await storage.activateProtocol(req.userId!, protocolId);

      if (hasConflict) {
        await storage.updateUserProtocol(userProtocol.id, {
          conflictFlag: true,
          conflictDetails: conflicts as any,
        });
        // Create a conflict nudge
        await storage.createNudge({
          userId: req.userId!,
          userProtocolId: userProtocol.id,
          type: "conflict_alert",
          title: `⚠️ Conflict detected: ${protocol.name}`,
          body: conflicts.map(c => c.reason).join(" "),
        });
      }

      // Create activation nudge
      await storage.createNudge({
        userId: req.userId!,
        userProtocolId: userProtocol.id,
        type: "daily_reminder",
        title: `Protocol started: ${protocol.name}`,
        body: protocol.steps ? `${(protocol.steps as string[]).length} steps to follow daily.` : undefined,
      });

      // Emit event to AXON
      const user = await storage.getUserById(req.userId!);
      emitAxonEvent(user, "protocol.activated", {
        protocolId: protocol.id,
        name: protocol.name,
        category: protocol.category,
        hasConflict,
        status: { activeProtocols: (await storage.getUserProtocols(req.userId!)).filter(p => p.status === "active").length },
      });

      res.json({ userProtocol: { ...userProtocol, protocol }, hasConflict, conflicts });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // PATCH update status (pause/resume/complete/cancel)
  app.patch("/api/user/protocols/:id", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { status, notes } = req.body;
      const up = await storage.getUserProtocolById(parseInt(req.params.id));
      if (!up || up.userId !== req.userId) return res.status(403).json({ error: "Access denied" });
      const updates: any = {};
      if (status) updates.status = status;
      if (notes !== undefined) updates.notes = notes;
      if (status === "completed") updates.completedAt = new Date() as any;
      await storage.updateUserProtocol(parseInt(req.params.id), updates);
      // Emit pause/resume event to AXON
      const user = await storage.getUserById(req.userId!);
      if (status === "paused" || status === "active") {
        emitAxonEvent(user, status === "paused" ? "protocol.paused" : "protocol.resumed", {
          userProtocolId: up.id,
        });
      }
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/user/protocols/:id/pause — toggle on hold (removes from cross-reference)
  app.put("/api/user/protocols/:id/pause", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const up = await storage.getUserProtocolById(parseInt(req.params.id));
      if (!up || up.userId !== req.userId) return res.status(403).json({ error: "Access denied" });
      const newStatus = up.status === "paused" ? "active" : "paused";
      await storage.updateUserProtocol(up.id, { status: newStatus });
      const user = await storage.getUserById(req.userId!);
      emitAxonEvent(user, newStatus === "paused" ? "protocol.paused" : "protocol.resumed", { userProtocolId: up.id });
      res.json({ ok: true, status: newStatus });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Checkins ──────────────────────────────────────────────────────────────
  app.post("/api/user/protocols/:id/checkin", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { completedSteps, note } = req.body;
      await storage.createCheckin({
        userId: req.userId!,
        userProtocolId: parseInt(req.params.id),
        completedSteps,
        note,
      });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Nudges ────────────────────────────────────────────────────────────────
  app.get("/api/nudges", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const nudges = await storage.getPendingNudges(req.userId!);
      res.json(nudges);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.patch("/api/nudges/:id/read", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      await storage.markNudgeRead(parseInt(req.params.id));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Inbound webhook from AXON / BioMarkerLab ─────────────────────────────
  // Receives a protocol from another module and stores it in the library.
  // AXON sends moduleToken as 'prxUserId' in format "userId:webhookSecret".
  app.post("/api/webhook/protocol", async (req, res) => {
    try {
      const { protocol, prxUserId, secret, conditionName, sequenceHint } = req.body;
      if (!prxUserId || !protocol) return res.status(400).json({ error: "prxUserId and protocol required." });

      // Parse userId:secret compound token (sent by AXON forwarding)
      let resolvedUserId: number;
      let resolvedSecret: string | undefined = secret;
      if (typeof prxUserId === "string" && prxUserId.includes(":")) {
        const [uidStr, embeddedSecret] = prxUserId.split(":");
        resolvedUserId = parseInt(uidStr);
        resolvedSecret = embeddedSecret;
      } else {
        resolvedUserId = Number(prxUserId);
      }

      const user = await storage.getUserById(resolvedUserId);
      if (!user) return res.status(404).json({ error: "User not found." });
      // Validate secret
      if (user.axonWebhookSecret && resolvedSecret !== user.axonWebhookSecret) {
        return res.status(401).json({ error: "Invalid secret." });
      }
      // Save protocol to library for this user
      const saved = await storage.createProtocol({
        sourceModule: protocol.sourceModule ?? "biomarkerlab",
        sourceUserId: resolvedUserId,
        name: protocol.recommendation || protocol.name || conditionName || "Protocol",
        description: [
          protocol.rationale,
          sequenceHint ? `📍 Sequence note: ${sequenceHint}` : null,
        ].filter(Boolean).join(" • ") || undefined,
        category: protocol.category ?? "supplements",
        priority: protocol.priority ?? "medium",
        protocolId: protocol.protocol?.protocol_id ?? undefined,
        steps: protocol.protocol?.steps,
        dosage: protocol.protocol?.dosage,
        duration: protocol.protocol?.duration,
        monitoring: protocol.protocol?.monitoring,
        completionCriteria: protocol.protocol?.completion_criteria,
        conflictsWith: protocol.protocol?.conflicts_with,
        contraindications: protocol.protocol?.contraindications,
        evidence: protocol.evidence,
        isPublic: false,
      });
      // Auto-activate if requested
      if (req.body.autoActivate !== false) {
        const { hasConflict, conflicts } = await storage.checkConflicts(resolvedUserId, saved);
        const up = await storage.activateProtocol(resolvedUserId, saved.id);
        if (hasConflict) {
          await storage.updateUserProtocol(up.id, { conflictFlag: true, conflictDetails: conflicts as any });
          await storage.createNudge({
            userId: resolvedUserId,
            userProtocolId: up.id,
            type: "conflict_alert",
            title: `⚠️ Conflict: ${saved.name}`,
            body: conflicts.map((c: any) => c.reason).join(" "),
          });
        }
        return res.json({ saved, activated: true, hasConflict, conflicts });
      }
      res.json({ saved, activated: false });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── AXON connect/disconnect ───────────────────────────────────────────────
  app.post("/api/axon/connect", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { axonUrl, axonEmail, axonPassword } = req.body;
      const baseUrl = axonUrl.replace(/\/$/, "");
      const axonRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: axonEmail, password: axonPassword }),
      });
      if (!axonRes.ok) {
        const err = await axonRes.json().catch(() => ({})) as any;
        return res.status(400).json({ error: err.error || "Could not sign in to AXON." });
      }
      const axonData = await axonRes.json() as any;
      const webhookSecret = require("crypto").randomBytes(24).toString("hex");
      await storage.updateUser(req.userId!, { axonUrl: baseUrl, axonUserId: axonData.user?.id, axonWebhookSecret: webhookSecret } as any);
      // Determine self URL for AXON to forward protocol.push events back to us
      const selfUrl = process.env.APP_URL
        || (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null);
      // Register with AXON: pass moduleToken (userId:secret) so AXON can identify our user on forwarding
      const moduleToken = `${req.userId}:${webhookSecret}`;
      await fetch(`${baseUrl}/api/modules/protocolrx/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${axonData.token}` },
        body: JSON.stringify({ moduleToken, moduleUrl: selfUrl }),
      });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/axon/status", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUserById(req.userId!);
      res.json({ connected: !!(user?.axonUrl && user?.axonUserId), axonUrl: user?.axonUrl ?? null });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Supplement lookup — fetch evidence-based dosage from Perplexity ──────────────
  app.post("/api/supplements/lookup", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { name } = req.body as { name: string };
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });

      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "AI not configured" });

      const prompt = `You are a clinical nutritionist. Look up evidence-based information about the supplement: "${name.trim()}"

RESPOND ONLY WITH VALID JSON. No markdown, no explanation. Start with { and end with }.

Return this exact structure:
{
  "name": "full correct name of the supplement (e.g. Vitamin D3 (Cholecalciferol))",
  "commonDose": "most common supplemental dose as a number (e.g. 2000)",
  "unit": "unit — must be one of: mg, mcg, IU, g, ml, mmol, capsule, tablet",
  "frequency": "one of: daily, twice daily, three times daily, every other day, weekly",
  "typicalRange": "typical safe supplemental range for healthy adults (e.g. 1000-5000 IU/day)",
  "upperLimit": "tolerable upper intake level if known (e.g. 4000 IU/day)",
  "bestTiming": "when to take it for best absorption (1 sentence)",
  "notes": "1-2 sentence plain-English note about this supplement and what it does",
  "warnings": "key safety consideration or empty string"
}`;

      const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 600,
        }),
      });
      const aiData = await aiRes.json() as any;
      const raw = aiData.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try { const match = raw.match(/\{[\s\S]*\}/); parsed = JSON.parse(match ? match[0] : raw); }
      catch { return res.status(500).json({ error: "Could not parse supplement data. Try a different name." }); }
      res.json(parsed);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── User Supplements CRUD ─────────────────────────────────────────────────
  app.get("/api/supplements", requireAuth, async (req: AuthRequest, res: Response) => {
    try { res.json(await storage.getUserSupplements(req.userId!)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/supplements", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { name, dose, unit, frequency, notes } = req.body;
      if (!name || !dose || !unit) return res.status(400).json({ error: "name, dose and unit are required" });
      const s = await storage.createUserSupplement({ userId: req.userId!, name, dose, unit, frequency: frequency || "daily", notes: notes || null });
      res.json(s);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/supplements/:id", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const supplements = await storage.getUserSupplements(req.userId!);
      if (!supplements.find(s => s.id === id)) return res.status(403).json({ error: "Access denied" });
      await storage.updateUserSupplement(id, req.body);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/supplements/:id", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const supplements = await storage.getUserSupplements(req.userId!);
      if (!supplements.find(s => s.id === id)) return res.status(403).json({ error: "Access denied" });
      await storage.deleteUserSupplement(id);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/supplements/analyse — AI analysis: actual intake vs active protocols
  app.post("/api/supplements/analyse", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "AI not configured. Set PERPLEXITY_API_KEY in Railway." });

      const [supplements, userProtocolsList] = await Promise.all([
        storage.getUserSupplements(req.userId!),
        storage.getUserProtocols(req.userId!),
      ]);
      const activeProtocols = userProtocolsList.filter(up => up.status === "active" && up.protocol);

      if (supplements.length === 0 && activeProtocols.length === 0) {
        return res.status(400).json({ error: "Add supplements and/or activate protocols first." });
      }

      const supplementList = supplements.length > 0
        ? supplements.map(s => `- ${s.name}: ${s.dose} ${s.unit} ${s.frequency}${s.notes ? ` (${s.notes})` : ""}`).join("\n")
        : "(none entered)";

      const protocolList = activeProtocols.length > 0
        ? activeProtocols.map(up => {
            const p = up.protocol!;
            return `- ${p.name} | dosage: ${p.dosage || "unspecified"} | conflicts_with: ${(p.conflictsWith as string[] | null)?.join(", ") || "none"}`;
          }).join("\n")
        : "(no active protocols)";

      const prompt = `You are a clinical pharmacist and nutritionist with deep knowledge of pharmacokinetics, receptor pharmacology, and nutrient biochemistry. Perform a comprehensive analysis of this patient's supplement stack.

RESPOND ONLY WITH VALID JSON. No markdown. Start with { and end with }.

CURRENT SUPPLEMENTS (name: dose unit frequency, timing notes):
${supplementList}

ACTIVE HEALTH PROTOCOLS (AI-generated recommendations):
${protocolList}

ANALYSIS REQUIREMENTS — be thorough and specific:
1. RECEPTOR & TRANSPORTER COMPETITION: Identify supplements sharing the same transporters or receptors (e.g. zinc/copper via ZIP transporters, calcium/magnesium via TRPM7, iron/zinc via DMT1, competing amino acids via LAT1). Flag where one will inhibit absorption of another at the doses given.
2. TIMING CONFLICTS: Identify pairs that must NOT be taken together due to absorption interference (e.g. calcium blocks iron absorption, zinc reduces copper, fat-soluble vitamins compete, stimulants affect sleep supplements). Provide a concrete recommended separation window in hours.
3. SYNERGIES: Identify beneficial combinations where one enhances the other (e.g. Vitamin D3+K2, Vitamin C+Iron, Magnesium+B6, Zinc+B6 for P5P conversion).
4. COUNTERACTION: Identify where supplements work against each other therapeutically (e.g. melatonin + stimulants, omega-3 anticoagulant effect + other blood thinners, adaptogen combinations).
5. DOSAGE VS PROTOCOL: Compare actual intake to protocol recommendations — flag gaps, excesses, and what's missing.

Return this exact JSON (no extra fields, no markdown):
{
  "summary": "3-4 sentence clinical overview of this stack",
  "overallRisk": "low|moderate|high",
  "items": [
    {
      "name": "supplement name",
      "currentDose": "e.g. 5000 IU daily — or null",
      "recommendedDose": "from protocol — or null if no protocol",
      "status": "sufficient | insufficient | excess | not_in_protocol | not_taking",
      "note": "1 sentence clinical note on this specific dose"
    }
  ],
  "timingSchedule": [
    {
      "time": "e.g. Morning with breakfast",
      "supplements": ["Supplement A", "Supplement B"],
      "reason": "Why these go together at this time"
    }
  ],
  "interactions": [
    {
      "supplements": ["name1", "name2"],
      "type": "absorption_competition | receptor_competition | counteraction | synergy | timing_conflict",
      "risk": "low|moderate|high",
      "reason": "Specific mechanism in plain English (e.g. 'Zinc and copper share the ZIP family transporters — taking both together at these doses will reduce copper absorption by ~40%')",
      "recommendation": "Concrete action (e.g. 'Take copper 4+ hours apart from zinc, or reduce zinc to 15mg')"
    }
  ],
  "missingFromStack": ["supplement recommended by protocol but not being taken"],
  "stackOptimisation": ["1-2 sentence actionable tip to improve the stack"]
}`;

      const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar-pro", messages: [{ role: "user", content: prompt }], max_tokens: 4000 }),
      });
      const aiData = await aiRes.json() as any;
      const raw = aiData.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try { const match = raw.match(/\{[\s\S]*\}/); parsed = JSON.parse(match ? match[0] : raw); }
      catch { return res.status(500).json({ error: "AI returned invalid JSON. Please try again." }); }
      res.json(parsed);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── AI Cross-reference analysis across all active protocols ───────────────
  app.post("/api/protocols/cross-reference", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const allUserProtocols = await storage.getUserProtocols(req.userId!);
      const active = allUserProtocols.filter(up => up.status === "active" && up.protocol);
      if (active.length === 0) return res.status(400).json({ error: "No active protocols to analyse." });

      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "AI not configured. Set PERPLEXITY_API_KEY in Railway." });

      const protocolSummaries = active.map(up => {
        const p = up.protocol!;
        return `Protocol: ${p.name}
Category: ${p.category}
Dosage: ${p.dosage || "not specified"}
Steps: ${(p.steps as string[] | null)?.join("; ") || "none"}
Duration: ${p.duration || "unspecified"}
Conflicts with: ${(p.conflictsWith as string[] | null)?.join(", ") || "none listed"}
Contraindications: ${p.contraindications || "none"}`;
      }).join("\n\n---\n\n");

      const prompt = `You are a clinical pharmacist and nutritionist. Analyse the following ${active.length} active health protocols for a single patient.

RESPOND ONLY WITH VALID JSON. No markdown, no explanation. Start with { and end with }.

PROTOCOLS:
${protocolSummaries}

Return this JSON structure:
{
  "summary": "2-3 sentence plain-English overview of the combined protocol stack",
  "overallRisk": "low|moderate|high",
  "conflicts": [
    { "protocolA": "name", "protocolB": "name", "reason": "plain-English explanation" }
  ],
  "dosageTotals": [
    { "supplement": "name", "totalDose": "combined dose across protocols", "safetyNote": "brief safety note or empty string" }
  ],
  "sequenceRecommendations": [
    "Recommendation 1 about timing or order"
  ]
}`;

      const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2000,
        }),
      });

      const aiData = await aiRes.json() as any;
      const raw = aiData.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : raw);
      } catch {
        return res.status(500).json({ error: "AI returned invalid JSON. Please try again." });
      }

      res.json(parsed);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Daily nudge cron (runs every hour, generates nudges for users who missed checkin) ─
  setInterval(() => storage.generateDailyNudges().catch(console.error), 60 * 60 * 1000);
}

// ── AXON event emitter ─────────────────────────────────────────────────────
async function emitAxonEvent(user: any, eventType: string, payload: object): Promise<void> {
  if (!user?.axonUrl || !user?.axonUserId) return;
  try {
    await fetch(`${user.axonUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-axon-secret": user.axonWebhookSecret ?? "" },
      body: JSON.stringify({ moduleId: "protocolrx", eventType, axonUserId: user.axonUserId, payload }),
    });
  } catch (e: any) { console.error("[axon] emit failed:", e.message); }
}
