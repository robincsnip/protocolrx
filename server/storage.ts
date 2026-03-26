import { Pool } from "pg";
import type { User, Protocol, UserProtocol, Checkin, Nudge, UserSupplement, InsertSupplement } from "@shared/schema";

// ─── Nutrient canonicalisation ────────────────────────────────────────────────
//
// Converts a raw nutrient name (as returned by AI / label OCR) to a stable
// lower-case canonical key used for deduplication and aggregation.
//
// Rules applied in order:
//  1. Lower-case and trim
//  2. Strip parenthetical qualifiers  e.g. "Folate (as 5-MTHF)" → "folate"
//  3. Strip trailing form descriptors  e.g. "magnesium (from chelate)" → "magnesium"
//  4. Alias map — common synonyms / different label wordings → single canonical name
//  5. Strip any remaining trailing whitespace / punctuation

const ALIAS_MAP: [RegExp, string][] = [
  // Folate / folic acid — all forms map to "folate"
  [/\bfolic acid\b/, "folate"],
  [/\bfolate\b/, "folate"],
  // Vitamin B aliases
  [/\bthiamin(e)?\b/, "vitamin b1"],
  [/\bvitamin b-?1\b/, "vitamin b1"],
  [/\briboflavin\b/, "vitamin b2"],
  [/\bvitamin b-?2\b/, "vitamin b2"],
  [/\bniacin(amide)?\b|\bnicotinic acid\b|\bnicotinamide\b/, "niacin"],
  [/\bvitamin b-?3\b/, "niacin"],
  [/\bpantothenic acid\b|\bcalcium pantothenate\b/, "pantothenic acid"],
  [/\bvitamin b-?5\b/, "pantothenic acid"],
  [/\bpyridoxine\b|\bpyridoxal\b/, "vitamin b6"],
  [/\bvitamin b-?6\b/, "vitamin b6"],
  [/\bbiotin\b/, "biotin"],
  [/\bvitamin b-?7\b/, "biotin"],
  [/\bcobalamin\b|\bcyanocobalamin\b|\bmethylcobalamin\b|\badenosylcobalamin\b/, "vitamin b12"],
  [/\bvitamin b-?12\b/, "vitamin b12"],
  // Vitamin D forms
  [/\bvitamin d-?2\b|\bergocalciferol\b/, "vitamin d2"],
  [/\bvitamin d-?3\b|\bcholecalciferol\b/, "vitamin d3"],
  [/\bvitamin d\b(?![-23])/, "vitamin d"],
  // Vitamin K forms
  [/\bvitamin k-?1\b|\bphylloquinone\b|\bphytonadione\b/, "vitamin k1"],
  [/\bvitamin k-?2\b|\bmenaquinone\b|\bmk-?\d+\b/, "vitamin k2"],
  [/\bvitamin k\b(?![-12])/, "vitamin k"],
  // Vitamin E
  [/\btocopherol\b|\btocotrienol\b/, "vitamin e"],
  // Vitamin C
  [/\bascorbic acid\b|\bascorbate\b/, "vitamin c"],
  // Vitamin A
  [/\bbeta.?carotene\b/, "vitamin a (beta-carotene)"],
  [/\bretinol\b|\bretinyl\b/, "vitamin a (retinol)"],
  // Minerals — common label variants
  [/\belemental magnesium\b/, "magnesium"],
  [/\belemental zinc\b/, "zinc"],
  [/\belemental iron\b/, "iron"],
  [/\belemental calcium\b/, "calcium"],
  [/\belemental copper\b/, "copper"],
  // Omega-3
  [/\beicosapentaenoic acid\b/, "epa"],
  [/\bdocosahexaenoic acid\b/, "dha"],
  [/\bomega.?3\b/, "omega-3"],
];

/**
 * Produce a stable slug from a product name for cache keying.
 * "Doctor's Best High Absorption Magnesium 200 mg" → "doctors best high absorption magnesium 200 mg"
 */
export function productSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")          // apostrophes
    .replace(/[^a-z0-9\s]/g, " ")   // non-alphanumeric → space
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim();
}

export function canonicalizeNutrient(name: string): string {
  // Step 1: lower-case & trim
  let s = name.toLowerCase().trim();
  // Step 2: strip parenthetical qualifiers  "vitamin d3 (as cholecalciferol)" → "vitamin d3"
  s = s.replace(/\s*\(.*?\)/g, "").trim();
  // Step 3: strip "from ..." / "as ..." trailing forms (without parens)
  s = s.replace(/\s+(from|as|derived from|in the form of)\s+.*/i, "").trim();
  // Step 4: alias map
  for (const [pattern, canonical] of ALIAS_MAP) {
    if (pattern.test(s)) { s = canonical; break; }
  }
  // Step 5: strip trailing punctuation / extra spaces
  return s.replace(/[,;.]+$/, "").trim();
}

export interface LabelNutrient {
  name: string;
  amount: string;
  unit: string;
  dailyValue?: string;
  source?: "photo" | "search" | "manual";
}

/**
 * Merge two nutrient arrays for "add another photo".
 *
 * The incoming scan (new photo) always wins for any nutrient it explicitly
 * returned — whether that key existed before or not. This ensures a real photo
 * always overrides internet-fetched data that may have been mixed in with a
 * previous scan.
 *
 * Keys that only exist in the existing array and were NOT returned by the new
 * scan are kept as-is (they came from a different page the new photo didn’t
 * cover).
 *
 * "search" rows are ONLY kept if the incoming scan has no opinion on them.
 * The moment a photo scan mentions the same nutrient, the photo value wins.
 */
export function mergeNutrients(existing: LabelNutrient[], incoming: LabelNutrient[]): LabelNutrient[] {
  // Build a set of canonical keys the new scan explicitly returned
  const incomingKeys = new Set(incoming.map(n => canonicalizeNutrient(n.name)));

  // Start from existing, but DROP any key that the incoming scan also covers
  // (incoming will supply the authoritative value for those)
  const base = existing.filter(n => !incomingKeys.has(canonicalizeNutrient(n.name)));

  // Append all incoming rows (they win for their keys)
  return [...base, ...incoming];
}

/**
 * De-duplicate within a SINGLE scan result.
 * When the AI returns both a total row and an indented sub-form row for the same
 * nutrient, keep the one with the higher numeric amount (= the total).
 * Only used internally to clean up a single scan before storing.
 */
export function deduplicateScan(nutrients: LabelNutrient[]): LabelNutrient[] {
  const map = new Map<string, { entry: LabelNutrient; amt: number }>();
  for (const n of nutrients) {
    const key = canonicalizeNutrient(n.name);
    const amt = parseFloat(n.amount) || 0;
    const cur = map.get(key);
    if (!cur || amt > cur.amt) map.set(key, { entry: n, amt });
  }
  return Array.from(map.values()).map(v => v.entry);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prx_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      axon_url TEXT,
      axon_user_id INTEGER,
      axon_webhook_secret TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prx_protocols (
      id SERIAL PRIMARY KEY,
      source_module TEXT NOT NULL DEFAULT 'manual',
      source_user_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'supplements',
      priority TEXT NOT NULL DEFAULT 'medium',
      protocol_id TEXT,
      steps JSONB,
      dosage TEXT,
      duration TEXT,
      monitoring TEXT,
      completion_criteria TEXT,
      conflicts_with JSONB,
      contraindications TEXT,
      evidence JSONB,
      is_public BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prx_user_protocols (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      protocol_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      conflict_flag BOOLEAN NOT NULL DEFAULT false,
      conflict_details JSONB,
      adherence_score REAL,
      last_checkin_at TIMESTAMPTZ,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS prx_checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      user_protocol_id INTEGER NOT NULL,
      completed_steps JSONB,
      note TEXT,
      checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prx_nudges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      user_protocol_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      nudge_time TEXT DEFAULT '08:00',
      scheduled_for TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE prx_nudges ADD COLUMN IF NOT EXISTS nudge_time TEXT DEFAULT '08:00';

    CREATE TABLE IF NOT EXISTS prx_user_supplements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      dose TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'mg',
      frequency TEXT NOT NULL DEFAULT 'daily',
      notes TEXT,
      label_nutrients JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE prx_user_supplements ADD COLUMN IF NOT EXISTS label_nutrients JSONB;

    -- Temporary image store for label scans (cross-instance safe, expires after 10 min)
    CREATE TABLE IF NOT EXISTS prx_temp_images (
      token TEXT PRIMARY KEY,
      image_b64 TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
    );

    -- Shared product label cache — one row per unique product
    -- name_slug is a normalised key (lower-case, stripped punctuation)
    CREATE TABLE IF NOT EXISTS prx_product_cache (
      id SERIAL PRIMARY KEY,
      name_slug TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      serving_size TEXT,
      nutrients JSONB NOT NULL DEFAULT '[]',
      scan_count INTEGER NOT NULL DEFAULT 1,
      flagged BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("[prx] Schema ready");
}

initSchema().catch(e => console.error("[prx] Schema init failed:", e.message));

function mapUser(row: any): User {
  return { id: row.id, email: row.email, passwordHash: row.password_hash, name: row.name,
    axonUrl: row.axon_url ?? null, axonUserId: row.axon_user_id ?? null,
    axonWebhookSecret: row.axon_webhook_secret ?? null, createdAt: row.created_at };
}

function mapProtocol(row: any): Protocol {
  return { id: row.id, sourceModule: row.source_module, sourceUserId: row.source_user_id ?? null,
    name: row.name, description: row.description ?? null, category: row.category,
    priority: row.priority, protocolId: row.protocol_id ?? null, steps: row.steps ?? null,
    dosage: row.dosage ?? null, duration: row.duration ?? null, monitoring: row.monitoring ?? null,
    completionCriteria: row.completion_criteria ?? null, conflictsWith: row.conflicts_with ?? null,
    contraindications: row.contraindications ?? null, evidence: row.evidence ?? null,
    isPublic: row.is_public, createdAt: row.created_at };
}

function mapUserProtocol(row: any): UserProtocol & { protocol?: Protocol } {
  return { id: row.id, userId: row.user_id, protocolId: row.protocol_id, status: row.status,
    startedAt: row.started_at, completedAt: row.completed_at ?? null,
    conflictFlag: row.conflict_flag, conflictDetails: row.conflict_details ?? null,
    adherenceScore: row.adherence_score ?? null, lastCheckinAt: row.last_checkin_at ?? null,
    notes: row.notes ?? null,
    protocol: row.p_id ? mapProtocol({ id: row.p_id, source_module: row.p_source_module,
      source_user_id: row.p_source_user_id, name: row.p_name, description: row.p_description,
      category: row.p_category, priority: row.p_priority, protocol_id: row.p_protocol_id,
      steps: row.p_steps, dosage: row.p_dosage, duration: row.p_duration,
      monitoring: row.p_monitoring, completion_criteria: row.p_completion_criteria,
      conflicts_with: row.p_conflicts_with, contraindications: row.p_contraindications,
      evidence: row.p_evidence, is_public: row.p_is_public, created_at: row.p_created_at }) : undefined,
  };
}

function mapNudge(row: any): Nudge {
  return { id: row.id, userId: row.user_id, userProtocolId: row.user_protocol_id,
    type: row.type, title: row.title, body: row.body ?? null,
    nudgeTime: row.nudge_time ?? "08:00",
    scheduledFor: row.scheduled_for ?? null, sentAt: row.sent_at ?? null,
    readAt: row.read_at ?? null, createdAt: row.created_at };
}

export const storage = {
  // ── Users ──────────────────────────────────────────────────────────────────
  async createUser(data: { email: string; passwordHash: string; name: string }): Promise<User> {
    const { rows } = await pool.query(
      `INSERT INTO prx_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *`,
      [data.email, data.passwordHash, data.name]
    );
    return mapUser(rows[0]);
  },
  async getUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await pool.query(`SELECT * FROM prx_users WHERE email = $1`, [email]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  },
  async getUserById(id: number): Promise<User | undefined> {
    const { rows } = await pool.query(`SELECT * FROM prx_users WHERE id = $1`, [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  },
  async updateUser(id: number, fields: Partial<User>): Promise<User | undefined> {
    const colMap: Record<string, string> = { name: "name", axonUrl: "axon_url",
      axonUserId: "axon_user_id", axonWebhookSecret: "axon_webhook_secret" };
    const setClauses: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (key in fields) { setClauses.push(`${col} = $${i++}`); values.push((fields as any)[key] ?? null); }
    }
    if (setClauses.length === 0) return this.getUserById(id);
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE prx_users SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, values
    );
    return rows[0] ? mapUser(rows[0]) : undefined;
  },

  // ── Protocols ──────────────────────────────────────────────────────────────
  async createProtocol(data: Partial<Protocol>): Promise<Protocol> {
    const { rows } = await pool.query(
      `INSERT INTO prx_protocols (source_module, source_user_id, name, description, category,
        priority, protocol_id, steps, dosage, duration, monitoring, completion_criteria,
        conflicts_with, contraindications, evidence, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16) RETURNING *`,
      [data.sourceModule ?? "manual", data.sourceUserId ?? null, data.name, data.description ?? null,
       data.category ?? "supplements", data.priority ?? "medium", data.protocolId ?? null,
       data.steps ? JSON.stringify(data.steps) : null, data.dosage ?? null, data.duration ?? null,
       data.monitoring ?? null, data.completionCriteria ?? null,
       data.conflictsWith ? JSON.stringify(data.conflictsWith) : null,
       data.contraindications ?? null, data.evidence ? JSON.stringify(data.evidence) : null,
       data.isPublic ?? false]
    );
    return mapProtocol(rows[0]);
  },
  async getProtocols(userId?: number): Promise<Protocol[]> {
    // Returns public protocols + protocols created by this user
    const { rows } = await pool.query(
      `SELECT * FROM prx_protocols WHERE is_public = true OR source_user_id = $1 ORDER BY created_at DESC`,
      [userId ?? -1]
    );
    return rows.map(mapProtocol);
  },
  async getProtocolById(id: number): Promise<Protocol | undefined> {
    const { rows } = await pool.query(`SELECT * FROM prx_protocols WHERE id = $1`, [id]);
    return rows[0] ? mapProtocol(rows[0]) : undefined;
  },

  // ── User Protocols ─────────────────────────────────────────────────────────
  async activateProtocol(userId: number, protocolId: number): Promise<UserProtocol> {
    const { rows } = await pool.query(
      `INSERT INTO prx_user_protocols (user_id, protocol_id, status) VALUES ($1, $2, 'active') RETURNING *`,
      [userId, protocolId]
    );
    return mapUserProtocol(rows[0]);
  },
  async getUserProtocols(userId: number): Promise<(UserProtocol & { protocol?: Protocol })[]> {
    const { rows } = await pool.query(
      `SELECT up.*,
        p.id as p_id, p.source_module as p_source_module, p.source_user_id as p_source_user_id,
        p.name as p_name, p.description as p_description, p.category as p_category,
        p.priority as p_priority, p.protocol_id as p_protocol_id, p.steps as p_steps,
        p.dosage as p_dosage, p.duration as p_duration, p.monitoring as p_monitoring,
        p.completion_criteria as p_completion_criteria, p.conflicts_with as p_conflicts_with,
        p.contraindications as p_contraindications, p.evidence as p_evidence,
        p.is_public as p_is_public, p.created_at as p_created_at
       FROM prx_user_protocols up
       LEFT JOIN prx_protocols p ON p.id = up.protocol_id
       WHERE up.user_id = $1
       ORDER BY up.started_at DESC`,
      [userId]
    );
    return rows.map(mapUserProtocol);
  },
  async getUserProtocolById(id: number): Promise<UserProtocol | undefined> {
    const { rows } = await pool.query(
      `SELECT * FROM prx_user_protocols WHERE id = $1`, [id]
    );
    if (!rows[0]) return undefined;
    const r = rows[0];
    return {
      id: r.id, userId: r.user_id, protocolId: r.protocol_id,
      status: r.status, startedAt: r.started_at, completedAt: r.completed_at ?? null,
      conflictFlag: r.conflict_flag, conflictDetails: r.conflict_details ?? null,
      adherenceScore: r.adherence_score ?? null, lastCheckinAt: r.last_checkin_at ?? null,
      notes: r.notes ?? null,
    } as UserProtocol;
  },

  async updateUserProtocol(id: number, fields: Partial<UserProtocol>): Promise<void> {
    const colMap: Record<string, string> = { status: "status", conflictFlag: "conflict_flag",
      conflictDetails: "conflict_details", adherenceScore: "adherence_score",
      lastCheckinAt: "last_checkin_at", completedAt: "completed_at", notes: "notes" };
    const setClauses: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (key in fields) {
        setClauses.push(`${col} = $${i++}`);
        const val = (fields as any)[key];
        values.push(typeof val === "object" && val !== null && !(val instanceof Date) ? JSON.stringify(val) : val ?? null);
      }
    }
    if (setClauses.length === 0) return;
    values.push(id);
    await pool.query(`UPDATE prx_user_protocols SET ${setClauses.join(", ")} WHERE id = $${i}`, values);
  },

  // ── Conflict checker ────────────────────────────────────────────────────────
  async checkConflicts(userId: number, newProtocol: Protocol): Promise<{ hasConflict: boolean; conflicts: {name: string; reason: string}[] }> {
    const active = await this.getUserProtocols(userId);
    const activeProtocols = active.filter(up => up.status === "active" && up.protocol);
    const conflicts: {name: string; reason: string}[] = [];
    const newConflictsWith = (newProtocol.conflictsWith as string[] | null) ?? [];

    for (const up of activeProtocols) {
      const p = up.protocol!;
      // Check if new protocol lists this active one as a conflict
      if (newConflictsWith.some((c: string) =>
        c.toLowerCase().includes(p.name.toLowerCase()) ||
        (p.protocolId && c.toLowerCase().includes(p.protocolId.toLowerCase()))
      )) {
        conflicts.push({ name: p.name, reason: `${newProtocol.name} lists ${p.name} as a potential conflict.` });
      }
      // Check if existing protocol lists the new one as a conflict
      const existingConflicts = (p.conflictsWith as string[] | null) ?? [];
      if (existingConflicts.some((c: string) =>
        c.toLowerCase().includes(newProtocol.name.toLowerCase()) ||
        (newProtocol.protocolId && c.toLowerCase().includes(newProtocol.protocolId.toLowerCase()))
      )) {
        conflicts.push({ name: p.name, reason: `Your active protocol "${p.name}" conflicts with ${newProtocol.name}.` });
      }
    }
    return { hasConflict: conflicts.length > 0, conflicts };
  },

  // ── Checkins ───────────────────────────────────────────────────────────────
  async createCheckin(data: { userId: number; userProtocolId: number; completedSteps?: string[]; note?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO prx_checkins (user_id, user_protocol_id, completed_steps, note) VALUES ($1,$2,$3::jsonb,$4)`,
      [data.userId, data.userProtocolId, JSON.stringify(data.completedSteps ?? []), data.note ?? null]
    );
    // Update adherence and last checkin
    const { rows } = await pool.query(
      `SELECT COUNT(*) as total_days,
        (SELECT COUNT(*) FROM prx_checkins WHERE user_protocol_id = $1) as completed_days
       FROM prx_checkins WHERE user_protocol_id = $1`,
      [data.userProtocolId]
    );
    const completedDays = parseInt(rows[0]?.completed_days ?? "1");
    const { rows: upRows } = await pool.query(
      `SELECT started_at FROM prx_user_protocols WHERE id = $1`, [data.userProtocolId]
    );
    const daysSinceStart = Math.max(1, Math.floor((Date.now() - new Date(upRows[0]?.started_at).getTime()) / 86400000));
    const adherenceScore = Math.min(100, Math.round((completedDays / daysSinceStart) * 100));
    await this.updateUserProtocol(data.userProtocolId, {
      adherenceScore,
      lastCheckinAt: new Date() as any,
    });
  },

  // ── Nudges ──────────────────────────────────────────────────────────────────
  async getPendingNudges(userId: number): Promise<Nudge[]> {
    const { rows } = await pool.query(
      `SELECT * FROM prx_nudges WHERE user_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    return rows.map(mapNudge);
  },
  async createNudge(data: { userId: number; userProtocolId: number; type: string; title: string; body?: string; nudgeTime?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO prx_nudges (user_id, user_protocol_id, type, title, body, nudge_time) VALUES ($1,$2,$3,$4,$5,$6)`,
      [data.userId, data.userProtocolId, data.type, data.title, data.body ?? null, data.nudgeTime ?? "08:00"]
    );
  },
  async markNudgeRead(id: number): Promise<void> {
    await pool.query(`UPDATE prx_nudges SET read_at = NOW() WHERE id = $1`, [id]);
  },
  async updateNudgeTime(id: number, nudgeTime: string): Promise<void> {
    await pool.query(`UPDATE prx_nudges SET nudge_time = $1 WHERE id = $2`, [nudgeTime, id]);
  },
  async updateNudgeBody(id: number, body: string): Promise<void> {
    await pool.query(`UPDATE prx_nudges SET body = $1 WHERE id = $2`, [body, id]);
  },

  async getAllDailyNudges(userId: number): Promise<Nudge[]> {
    const { rows } = await pool.query(
      `SELECT * FROM prx_nudges
       WHERE user_id = $1 AND type = 'daily_reminder'
       ORDER BY nudge_time ASC, created_at DESC`,
      [userId]
    );
    return rows.map(mapNudge);
  },

  // ── Daily nudge generator (called on schedule) ─────────────────────────────
  async generateDailyNudges(): Promise<void> {
    // Find all active user protocols that haven't had a checkin today
    const { rows } = await pool.query(`
      SELECT up.id, up.user_id, p.name as protocol_name
      FROM prx_user_protocols up
      JOIN prx_protocols p ON p.id = up.protocol_id
      WHERE up.status = 'active'
        AND (up.last_checkin_at IS NULL OR up.last_checkin_at < NOW() - INTERVAL '20 hours')
    `);
    for (const row of rows) {
      await this.createNudge({
        userId: row.user_id,
        userProtocolId: row.id,
        type: "daily_reminder",
        title: `Check in: ${row.protocol_name}`,
        body: "Don't forget to log today's adherence for your active protocol.",
      });
    }
    console.log(`[prx] Generated ${rows.length} daily nudges`);
  },

  // ── User Supplements ─────────────────────────────────────────────────────
  async getUserSupplements(userId: number): Promise<UserSupplement[]> {
    const { rows } = await pool.query(
      `SELECT * FROM prx_user_supplements WHERE user_id = $1 ORDER BY name ASC`,
      [userId]
    );
    return rows.map(r => ({
      id: r.id, userId: r.user_id, name: r.name, dose: r.dose,
      unit: r.unit, frequency: r.frequency, notes: r.notes ?? null,
      labelNutrients: r.label_nutrients ?? null,
      createdAt: r.created_at,
    }) as UserSupplement);
  },

  async createUserSupplement(data: InsertSupplement): Promise<UserSupplement> {
    const { rows } = await pool.query(
      `INSERT INTO prx_user_supplements (user_id, name, dose, unit, frequency, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [data.userId, data.name.trim(), data.dose.trim(), data.unit.trim(),
       data.frequency || "daily", data.notes ?? null]
    );
    const r = rows[0];
    return { id: r.id, userId: r.user_id, name: r.name, dose: r.dose,
      unit: r.unit, frequency: r.frequency, notes: r.notes ?? null,
      labelNutrients: r.label_nutrients ?? null,
      createdAt: r.created_at } as UserSupplement;
  },

  async updateUserSupplement(id: number, data: Partial<InsertSupplement>): Promise<void> {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (data.name !== undefined)      { fields.push(`name=$${i++}`);      vals.push(data.name.trim()); }
    if (data.dose !== undefined)      { fields.push(`dose=$${i++}`);      vals.push(data.dose.trim()); }
    if (data.unit !== undefined)      { fields.push(`unit=$${i++}`);      vals.push(data.unit.trim()); }
    if (data.frequency !== undefined) { fields.push(`frequency=$${i++}`); vals.push(data.frequency); }
    if (data.notes !== undefined)     { fields.push(`notes=$${i++}`);     vals.push(data.notes); }
    if (!fields.length) return;
    vals.push(id);
    await pool.query(`UPDATE prx_user_supplements SET ${fields.join(", ")} WHERE id = $${i}`, vals);
  },

  async deleteUserSupplement(id: number): Promise<void> {
    await pool.query(`DELETE FROM prx_user_supplements WHERE id = $1`, [id]);
  },

  // ── Product cache ─────────────────────────────────────────────────────────────────

  async storeTempImage(token: string, imageB64: string): Promise<void> {
    await pool.query(
      `INSERT INTO prx_temp_images (token, image_b64) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET image_b64 = $2, expires_at = NOW() + INTERVAL '10 minutes'`,
      [token, imageB64]
    );
  },

  async getTempImage(token: string): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT image_b64 FROM prx_temp_images WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    return rows[0]?.image_b64 ?? null;
  },

  async deleteTempImage(token: string): Promise<void> {
    await pool.query(`DELETE FROM prx_temp_images WHERE token = $1`, [token]);
  },

  async getCachedProduct(slug: string): Promise<{ productName: string; servingSize: string | null; nutrients: object[]; scanCount: number } | null> {
    const { rows } = await pool.query(
      `SELECT product_name, serving_size, nutrients, scan_count FROM prx_product_cache WHERE name_slug = $1 AND flagged = false`,
      [slug]
    );
    if (!rows[0]) return null;
    return {
      productName: rows[0].product_name,
      servingSize: rows[0].serving_size ?? null,
      nutrients: rows[0].nutrients ?? [],
      scanCount: rows[0].scan_count,
    };
  },

  async upsertCachedProduct(slug: string, productName: string, servingSize: string | null, nutrients: object[]): Promise<void> {
    await pool.query(
      `INSERT INTO prx_product_cache (name_slug, product_name, serving_size, nutrients, scan_count, flagged, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, 1, false, NOW())
       ON CONFLICT (name_slug) DO UPDATE SET
         product_name = EXCLUDED.product_name,
         serving_size = EXCLUDED.serving_size,
         nutrients    = EXCLUDED.nutrients,
         scan_count   = prx_product_cache.scan_count + 1,
         flagged      = false,
         updated_at   = NOW()`,
      [slug, productName, servingSize, JSON.stringify(nutrients)]
    );
  },

  async flagCachedProduct(slug: string): Promise<void> {
    await pool.query(
      `UPDATE prx_product_cache SET flagged = true, updated_at = NOW() WHERE name_slug = $1`,
      [slug]
    );
  },

  async clearUserLabelNutrients(supplementId: number): Promise<void> {
    await pool.query(
      `UPDATE prx_user_supplements SET label_nutrients = NULL WHERE id = $1`,
      [supplementId]
    );
  },

  async saveManualNutrients(id: number, nutrients: object[]): Promise<void> {
    await pool.query(
      `UPDATE prx_user_supplements SET label_nutrients = $1::jsonb WHERE id = $2`,
      [JSON.stringify(nutrients), id]
    );
  },

  // ── Label nutrients (per user supplement row) ─────────────────────────────────

  async saveLabelNutrients(id: number, nutrients: object[]): Promise<void> {
    // Fetch existing nutrients so we can MERGE (not overwrite) for multi-photo labels
    const { rows } = await pool.query(
      `SELECT label_nutrients FROM prx_user_supplements WHERE id = $1`,
      [id]
    );
    const existing: any[] = rows[0]?.label_nutrients ?? [];

    // Merge: canonical key → keep entry with highest numeric amount
    // This deduplicates the same nutrient appearing on two different label pages
    const merged = mergeNutrients(existing, nutrients as any[]);

    await pool.query(
      `UPDATE prx_user_supplements SET label_nutrients = $1::jsonb WHERE id = $2`,
      [JSON.stringify(merged), id]
    );
  },
};
