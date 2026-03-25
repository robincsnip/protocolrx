import type { Express } from "express";
import type { Server } from "http";
import { registerAuthRoutes, requireAuth, type AuthRequest } from "./auth";
import { storage, canonicalizeNutrient, productSlug, mergeNutrients, deduplicateScan } from "./storage";
import type { Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Normalise unit strings — strip DFE / NE / RAE qualifiers so aggregation stays
// in consistent units. "mcg DFE" and "mcg" are both just micrograms for our purposes.
function normalizeUnit(unit: string): string {
  return unit
    .replace(/\s*(DFE|RAE|NE|ATE|TE|AT)\s*$/i, "")   // dietary equivalents
    .replace(/^IU$/i, "IU")                             // keep IU as-is
    .trim();
}

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

      const prompt = `You are a clinical nutritionist. Look up the exact supplement: "${name.trim()}"

RESPOND ONLY WITH VALID JSON. No markdown. Start with { and end with }.

CRITICAL RULE on hasSplitDose — read carefully:
- hasSplitDose=TRUE: ONLY when the product physically contains two different capsule/tablet formulas in one package (e.g. "AM formula" and "PM formula" with different ingredients). Example: Thorne Multi-Vitamin Elite AM/PM.
- hasSplitDose=FALSE: for ALL other supplements, including those recommended to be taken twice daily or split across meals. Magnesium, zinc, vitamin D, fish oil, etc. are NEVER split-dose even if the instructions say "take 2 tablets twice daily". These are one formula, one product.
- When hasSplitDose=FALSE: set commonDose to the TOTAL daily dose as a single number (e.g. if 200mg twice daily → commonDose="400", unit="mg").
- When hasSplitDose=TRUE: set commonDose=null, populate splitSchedule with each formula.
- If unsure: default to hasSplitDose=FALSE.

{
  "name": "exact product name",
  "hasSplitDose": false,
  "commonDose": "total daily dose as a number, or null only for true AM/PM dual-formula products",
  "unit": "one of: mg mcg IU g ml mmol capsule tablet",
  "frequency": "one of: daily twice daily three times daily every other day weekly",
  "splitSchedule": [
    { "time": "Morning with breakfast", "dose": "3", "unit": "capsule", "notes": "AM formula" },
    { "time": "Evening with dinner", "dose": "3", "unit": "capsule", "notes": "PM formula" }
  ],
  "typicalRange": "safe supplemental range (e.g. 1000-5000 IU/day)",
  "upperLimit": "tolerable upper intake level or empty string",
  "bestTiming": "when to take it for best absorption (1 sentence)",
  "notes": "1-2 sentence plain-English description of what it does",
  "warnings": "key safety note or empty string"
}`;

      const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 800,
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

  // Temp image store: token -> { filePath, expires }
  const tempImages = new Map<string, { filePath: string; expires: number }>();

  // GET /api/supplements/label-img/:token — serve a temporarily stored label image
  // Used so sonar-pro can fetch the image via a public HTTPS URL
  app.get("/api/supplements/label-img/:token", (req, res) => {
    const entry = tempImages.get(req.params.token);
    if (!entry || Date.now() > entry.expires) {
      tempImages.delete(req.params.token);
      return res.status(404).send("Not found");
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    const stream = fs.createReadStream(entry.filePath);
    stream.on("error", () => res.status(404).send("Not found"));
    stream.pipe(res);
  });

  // POST /api/supplements/:id/scan-label — label OCR + nutrient extraction
  //
  // Strategy:
  //   0. Check product cache (skip AI entirely if hit + not force-refresh)
  //   1. Save image to /tmp, serve at public HTTPS URL
  //   2. sonar-pro vision call with that URL
  //   3. Fallback: text-based lookup by supplement name
  //   4. Write result to user's label_nutrients AND to shared product cache
  app.post("/api/supplements/:id/scan-label", requireAuth, async (req: AuthRequest, res: Response) => {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "AI not configured" });

    const id = parseInt(req.params.id);
    const supplements = await storage.getUserSupplements(req.userId!);
    const supp = supplements.find(s => s.id === id);
    if (!supp) return res.status(403).json({ error: "Access denied" });

    const { imageBase64, mimeType, force, merge } = req.body as { imageBase64: string; mimeType?: string; force?: boolean; merge?: boolean };
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    // force = bypass cache + replace all existing label data
    // merge = bypass cache + merge new scan into existing label data (add another photo)
    // normal = use cache if available
    const bypassCache = force || merge;

    const slug = productSlug(supp.name);
    console.log(`[scan-label] id=${id} slug="${slug}" mode=${force ? "force" : merge ? "merge" : "normal"} payload ~${Math.round(imageBase64.length * 0.75 / 1024)}KB`);

    // ── Step 0: Cache hit (normal mode only) ────────────────────────────────
    if (!bypassCache) {
      const cached = await storage.getCachedProduct(slug);
      if (cached && Array.isArray(cached.nutrients) && cached.nutrients.length > 0) {
        console.log(`[scan-label] cache HIT for "${slug}" (scanned ${cached.scanCount}x before)`);
        await storage.saveLabelNutrients(id, cached.nutrients);
        return res.json({
          productName: cached.productName,
          servingSize: cached.servingSize,
          nutrients: cached.nutrients,
          fromCache: true,
          scanCount: cached.scanCount,
        });
      }
    }

    // force mode: clear existing label data first so we get a clean slate
    if (force) {
      await storage.clearUserLabelNutrients(id);
    }

    const PPLX_PROMPT = `Extract nutrients from this supplement label. RESPOND ONLY WITH VALID JSON — no markdown, no code fences.

Return exactly:
{
  "productName": "exact product name from label",
  "servingSize": "e.g. 3 capsules",
  "nutrients": [
    { "name": "Vitamin D3", "amount": "2000", "unit": "IU", "dailyValue": "500%" }
  ]
}

RULES:
- Include every row from the Supplement Facts panel with exact amounts.
- Use the SIMPLE unit (e.g. "mcg" not "mcg DFE", "mg" not "mg NE").
- When a nutrient has BOTH a total amount AND a sub-form (e.g. "Folate 400 mcg" with indented "(240 mcg folic acid)"), output ONLY the top-level total row — skip the indented sub-form.
- Set dailyValue to "" if not listed.`;

    function extractJson(raw: string): any {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("No JSON in response");
      return JSON.parse(raw.slice(start, end + 1));
    }

    async function callPplx(content: any[]): Promise<any | null> {
      const r = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar-pro", messages: [{ role: "user", content }], max_tokens: 4000 }),
      });
      if (!r.ok) { console.error(`[scan-label] pplx ${r.status}:`, await r.text()); return null; }
      const d = await r.json() as any;
      const raw: string = d.choices?.[0]?.message?.content || "";
      console.log(`[scan-label] pplx raw (300 chars):`, raw.substring(0, 300));
      try { return extractJson(raw); } catch { return null; }
    }

    try {
      // ── Step 1: Save image to /tmp and expose as public HTTPS URL ──────────────
      const token = crypto.randomBytes(16).toString("hex");
      const tmpDir = "/tmp/prx-labels";
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, `${token}.jpg`);
      fs.writeFileSync(filePath, Buffer.from(imageBase64, "base64"));
      tempImages.set(token, { filePath, expires: Date.now() + 5 * 60 * 1000 });

      const appUrl = process.env.APP_URL || "https://protocolrx-production.up.railway.app";
      const imageUrl = `${appUrl}/api/supplements/label-img/${token}`;
      console.log(`[scan-label] serving image at ${imageUrl}`);

      // ── Step 2: Vision call with public URL ──────────────────────────────────
      let parsed = await callPplx([
        { type: "text", text: PPLX_PROMPT },
        { type: "image_url", image_url: { url: imageUrl } },
      ]);

      // ── Step 3: De-duplicate within the single scan result ───────────────────
      // Removes sub-form duplicates (e.g. "Folate" + "Folic Acid" in same response)
      if (parsed && Array.isArray(parsed.nutrients)) {
        parsed.nutrients = deduplicateScan(parsed.nutrients);
      }

      const visionCount = Array.isArray(parsed?.nutrients) ? parsed.nutrients.length : 0;
      console.log(`[scan-label] vision returned ${visionCount} nutrients`);

      // ── Step 4 (last resort): text lookup ONLY when vision completely failed ─────
      // DO NOT merge text-search results with vision results — web data may be a
      // different product version. Use photo as ground truth; text only fills a
      // total blank (can't read photo at all).
      if (visionCount === 0) {
        console.log(`[scan-label] vision returned nothing — falling back to text lookup for "${supp.name}"`);
        const textParsed = await callPplx([{
          type: "text",
          text: `Look up the COMPLETE supplement facts label for "${supp.name}"${supp.dose ? ` ${supp.dose}${supp.unit}` : ""}. RESPOND ONLY WITH VALID JSON — no markdown, no code fences.

Return:
{
  "productName": "exact product name",
  "servingSize": "serving size from label",
  "nutrients": [
    { "name": "nutrient name", "amount": "amount", "unit": "unit", "dailyValue": "% daily value or empty string" }
  ]
}

IMPORTANT: Include ALL nutrients — every single row from the label. Do not truncate.
Use the SIMPLE unit ("mcg" not "mcg DFE"). Output ONLY the top-level total; skip indented sub-forms.
Search iHerb, manufacturer website, Examine.com, or FDA databases for the real label data.`,
        }]);
        if (textParsed && Array.isArray(textParsed.nutrients) && textParsed.nutrients.length > 0) {
          parsed = { ...textParsed, nutrients: deduplicateScan(textParsed.nutrients) };
          console.log(`[scan-label] text lookup returned ${parsed.nutrients.length} nutrients`);
        }
      }

      // ── Cleanup temp image ───────────────────────────────────────────────────
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      tempImages.delete(token);

      if (!parsed || !Array.isArray(parsed.nutrients) || parsed.nutrients.length === 0) {
        return res.status(500).json({ error: "Could not extract label data. Try a clearer photo or check the supplement name." });
      }

      // ── Step 4: Save to user row, then write the MERGED result to cache ─────
      // saveLabelNutrients merges the new scan with existing DB data.
      // We then read back the merged result so the cache also reflects the full picture,
      // not just this one scan.
      await storage.saveLabelNutrients(id, parsed.nutrients);

      // Read the now-merged label data from DB to cache the complete set
      const updatedSupps = await storage.getUserSupplements(req.userId!);
      const updatedSupp = updatedSupps.find(s => s.id === id);
      const mergedNutrients = (updatedSupp as any)?.labelNutrients ?? parsed.nutrients;
      await storage.upsertCachedProduct(slug, parsed.productName || supp.name, parsed.servingSize || null, mergedNutrients);

      res.json({ ...parsed, nutrients: mergedNutrients, fromCache: false });
    } catch (e: any) {
      console.error("[scan-label] unexpected error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/supplements/:id/label-nutrients — save manually edited nutrients (full replace)
  app.put("/api/supplements/:id/label-nutrients", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const supplements = await storage.getUserSupplements(req.userId!);
      if (!supplements.find(s => s.id === id)) return res.status(403).json({ error: "Access denied" });
      const { nutrients } = req.body as { nutrients: object[] };
      if (!Array.isArray(nutrients)) return res.status(400).json({ error: "nutrients array required" });
      // Manual edit = full replace, skip merge
      await storage.saveManualNutrients(id, nutrients);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/supplements/:id/label — clear a user's stored label nutrients for one supplement
  app.delete("/api/supplements/:id/label", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const supplements = await storage.getUserSupplements(req.userId!);
      if (!supplements.find(s => s.id === id)) return res.status(403).json({ error: "Access denied" });
      await storage.clearUserLabelNutrients(id);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/supplements/cache/flag — flag a cached product as incorrect
  // The cache entry is marked flagged=true; next scan for this product will re-fetch from AI
  app.post("/api/supplements/cache/flag", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { supplementId } = req.body as { supplementId: number };
      if (!supplementId) return res.status(400).json({ error: "supplementId required" });
      const supplements = await storage.getUserSupplements(req.userId!);
      const supp = supplements.find(s => s.id === supplementId);
      if (!supp) return res.status(403).json({ error: "Access denied" });
      const slug = productSlug(supp.name);
      // Flag the shared cache + clear user's personal label data so they get a fresh scan
      await Promise.all([
        storage.flagCachedProduct(slug),
        storage.clearUserLabelNutrients(supplementId),
      ]);
      console.log(`[cache] flagged slug="${slug}" by userId=${req.userId}`);
      res.json({ ok: true, message: "Cache cleared for this product. Next scan will re-fetch label data." });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/supplements/nutrients — combine stored label nutrients from all scanned supplements
  app.post("/api/supplements/nutrients", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const supplements = await storage.getUserSupplements(req.userId!);
      if (supplements.length === 0) return res.status(400).json({ error: "No supplements logged" });

      // Aggregate nutrients from scanned labels using canonical keys to prevent double-counting
      // e.g. "Folate (as 5-MTHF)" + "Folic Acid" from the same/different products → one "Folate" entry
      type NutAgg = { amount: number; unit: string; sources: string[]; displayName: string };
      const nutrientMap: Record<string, NutAgg> = {};
      let unscanned: typeof supplements = [];

      for (const s of supplements) {
        const labelNutrients = (s as any).labelNutrients as { name: string; amount: string; unit: string }[] | null;
        if (labelNutrients && labelNutrients.length > 0) {
          for (const n of labelNutrients) {
            const key = canonicalizeNutrient(n.name);
            const amt = parseFloat(n.amount) || 0;
            if (!nutrientMap[key]) {
              // Capitalise the canonical key as display name
              const display = key.split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
              nutrientMap[key] = { amount: 0, unit: normalizeUnit(n.unit), sources: [], displayName: display };
            }
            nutrientMap[key].amount += amt;
            if (!nutrientMap[key].sources.includes(s.name)) nutrientMap[key].sources.push(s.name);
          }
        } else {
          unscanned.push(s);
        }
      }

      const scannedNutrients = Object.entries(nutrientMap).map(([, v]) => ({
        name: v.displayName,
        totalDailyDose: v.amount % 1 === 0 ? String(v.amount) : v.amount.toFixed(2),
        unit: v.unit,
        sources: v.sources,
        fromLabel: true,
      }));

      // If all supplements have been scanned, return immediately
      if (unscanned.length === 0) return res.json({ nutrients: scannedNutrients, unscanned: [] });

      // Still need AI for unscanned ones — return what we have plus a flag
      return res.json({
        nutrients: scannedNutrients,
        unscanned: unscanned.map(s => s.name),
      });

      // Dead code below kept for reference — the productList AI approach was unreliable
      const productList = supplements.map(s =>
        `- ${s.name}: ${s.dose} ${s.unit} ${s.frequency}${s.notes ? ` (${s.notes})` : ""}`
      ).join("\n");

      const prompt = `You are a nutritional biochemist with access to supplement label databases.
The user takes these products. For each one, list every nutrient/ingredient from its actual label at the given dose.

RESPOND ONLY WITH VALID JSON. Start with { end with }. No markdown, no explanation.

PRODUCTS TAKEN DAILY:
${productList}

RULES:
- Use the real label data for each named product (search for it if needed).
- For each nutrient found across ALL products, sum the total daily intake.
- If a supplement is listed twice (AM + PM), include both contributions.
- Only list nutrients with known amounts — do not guess.
- Nutrient names must be standard ("Vitamin D3", "Zinc", "Magnesium", "Vitamin B12", etc.).
- Return amounts as strings in the label unit.

{
  "nutrients": [
    { "name": "Vitamin D3", "totalDailyDose": "4000", "unit": "IU", "sources": ["Product A", "Product B"] },
    { "name": "Magnesium", "totalDailyDose": "600", "unit": "mg", "sources": ["Product B"] }
  ]
}`;

      const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar-pro", messages: [{ role: "user", content: prompt }], max_tokens: 4000 }),
      });
      const aiData = await aiRes.json() as any;
      const raw = aiData.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try {
        const match = raw.match(/\{[\s\S]*/);
        if (!match) throw new Error("no json");
        let candidate = match[0];
        try { parsed = JSON.parse(candidate); }
        catch {
          // Repair truncated JSON
          const opens = (candidate.match(/[\[{]/g) || []).length;
          const closes = (candidate.match(/[\]\}]/g) || []).length;
          let repair = candidate.trimEnd().replace(/,\s*$/, "");
          for (let i = 0; i < opens - closes; i++) repair += repair.lastIndexOf('[') > repair.lastIndexOf('{') ? ']' : '}';
          parsed = JSON.parse(repair);
        }
      } catch { return res.status(500).json({ error: "Could not parse nutrient data. Try again." }); }
      res.json(parsed);
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

      const prompt = `You are a clinical pharmacist. Analyse this supplement stack vs active protocols. Be specific about mechanisms.

RESPOND ONLY WITH VALID JSON. No markdown. Start with { end with }.

SUPPLEMENTS:
${supplementList}

PROTOCOLS:
${protocolList}

Return:
{
  "summary": "2-3 sentence clinical overview",
  "overallRisk": "low|moderate|high",
  "timingSchedule": [{"time":"Morning with food","supplements":["A","B"],"reason":"why"}],
  "interactions": [{
    "supplements":["A","B"],
    "type":"absorption_competition|receptor_competition|counteraction|synergy|timing_conflict",
    "risk":"low|moderate|high",
    "reason":"specific mechanism (e.g. ZIP transporter competition, 40% absorption reduction)",
    "recommendation":"concrete fix"
  }],
  "items": [{"name":"X","currentDose":"5000 IU daily","recommendedDose":"5000 IU","status":"sufficient|insufficient|excess|not_in_protocol|not_taking","note":"1 sentence"}],
  "missingFromStack": ["protocol-recommended supplement not being taken"],
  "stackOptimisation": ["actionable tip"]
}`;

      const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar-pro", messages: [{ role: "user", content: prompt }], max_tokens: 3000 }),
      });
      const aiData = await aiRes.json() as any;
      const raw = aiData.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try {
        // Try to extract and parse JSON, repairing truncation if needed
        const match = raw.match(/\{[\s\S]*/); // grab from first {
        if (!match) throw new Error("No JSON found");
        let candidate = match[0];
        // Attempt direct parse first
        try { parsed = JSON.parse(candidate); }
        catch {
          // Truncated JSON repair: close unclosed arrays/objects
          const opens = (candidate.match(/[\[{]/g) || []).length;
          const closes = (candidate.match(/[\]\}]/g) || []).length;
          let repair = candidate.trimEnd();
          // Remove trailing comma if any
          repair = repair.replace(/,\s*$/, "");
          // Close any open structures
          for (let i = 0; i < opens - closes; i++) {
            repair += repair.includes('[') && !repair.includes(']') ? ']' : '}';
          }
          parsed = JSON.parse(repair);
        }
      } catch (parseErr: any) {
        console.error("[prx] JSON parse failed. Raw:", raw.slice(0, 300));
        return res.status(500).json({ error: "AI returned incomplete JSON. Please try again." });
      }
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
