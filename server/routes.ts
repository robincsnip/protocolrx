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

  // PATCH update status (pause/complete/cancel)
  app.patch("/api/user/protocols/:id", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { status, notes } = req.body;
      const updates: any = {};
      if (status) updates.status = status;
      if (notes !== undefined) updates.notes = notes;
      if (status === "completed") updates.completedAt = new Date() as any;
      await storage.updateUserProtocol(parseInt(req.params.id), updates);
      res.json({ ok: true });
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
  // Receives a protocol from another module and stores it in the library
  app.post("/api/webhook/protocol", async (req, res) => {
    try {
      const { protocol, prxUserId, secret } = req.body;
      if (!prxUserId || !protocol) return res.status(400).json({ error: "prxUserId and protocol required." });
      const user = await storage.getUserById(Number(prxUserId));
      if (!user) return res.status(404).json({ error: "User not found." });
      // Validate secret
      if (user.axonWebhookSecret && secret !== user.axonWebhookSecret) {
        return res.status(401).json({ error: "Invalid secret." });
      }
      // Save protocol to library for this user
      const saved = await storage.createProtocol({
        sourceModule: protocol.sourceModule ?? "biomarkerlab",
        sourceUserId: Number(prxUserId),
        name: protocol.recommendation || protocol.name,
        description: protocol.rationale,
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
      if (req.body.autoActivate) {
        const { hasConflict, conflicts } = await storage.checkConflicts(Number(prxUserId), saved);
        const up = await storage.activateProtocol(Number(prxUserId), saved.id);
        if (hasConflict) {
          await storage.updateUserProtocol(up.id, { conflictFlag: true, conflictDetails: conflicts as any });
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
      await fetch(`${baseUrl}/api/modules/protocolrx/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${axonData.token}` },
        body: JSON.stringify({ moduleToken: webhookSecret }),
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
