import { pgTable, text, serial, integer, jsonb, timestamp, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable("prx_users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  // AXON integration
  axonUrl: text("axon_url"),
  axonUserId: integer("axon_user_id"),
  axonWebhookSecret: text("axon_webhook_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
});
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type User = typeof users.$inferSelect;

// ─── Protocols ────────────────────────────────────────────────────────────────
// Master protocol library — can be created by modules (AI-generated) or manually
export const protocols = pgTable("prx_protocols", {
  id: serial("id").primaryKey(),
  // Source: 'biomarkerlab' | 'biolune' | 'manual' | 'system'
  sourceModule: text("source_module").notNull().default("manual"),
  sourceUserId: integer("source_user_id"), // which user's analysis generated this
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(), // 'supplements' | 'diet' | 'lifestyle' | 'injectables' | 'medical' | 'habits'
  priority: text("priority").notNull().default("medium"), // 'high' | 'medium' | 'low'
  // ProtocolRX standard fields (from BioMarkerLab's protocol_id format)
  protocolId: text("protocol_id"),       // e.g. "vitamin-d3-repletion-v1"
  steps: jsonb("steps"),                 // string[]
  dosage: text("dosage"),
  duration: text("duration"),
  monitoring: text("monitoring"),
  completionCriteria: text("completion_criteria"),
  conflictsWith: jsonb("conflicts_with"), // string[] — protocol_ids or supplement names
  contraindications: text("contraindications"),
  evidence: jsonb("evidence"),           // {title, source, url, summary}[]
  // Metadata
  isPublic: boolean("is_public").notNull().default(false), // visible in library to all users
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type Protocol = typeof protocols.$inferSelect;

// ─── User Protocols ────────────────────────────────────────────────────────────
// A user's activated instance of a protocol
export const userProtocols = pgTable("prx_user_protocols", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  protocolId: integer("protocol_id").notNull(),
  status: text("status").notNull().default("active"), // 'active' | 'paused' | 'completed' | 'cancelled'
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Conflict state — set by conflict checker
  conflictFlag: boolean("conflict_flag").notNull().default(false),
  conflictDetails: jsonb("conflict_details"), // [{conflictsWith: string, reason: string}]
  // Adherence tracking
  adherenceScore: real("adherence_score"), // 0-100
  lastCheckinAt: timestamp("last_checkin_at", { withTimezone: true }),
  notes: text("notes"),
});
export type UserProtocol = typeof userProtocols.$inferSelect;

// ─── Checkins ──────────────────────────────────────────────────────────────────
// Daily adherence log — user marks steps as done
export const checkins = pgTable("prx_checkins", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  userProtocolId: integer("user_protocol_id").notNull(),
  completedSteps: jsonb("completed_steps"), // string[] of step indices completed
  note: text("note"),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).defaultNow().notNull(),
});
export type Checkin = typeof checkins.$inferSelect;

// ─── Nudges ────────────────────────────────────────────────────────────────────
// Scheduled nudges/reminders for active protocols
export const nudges = pgTable("prx_nudges", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  userProtocolId: integer("user_protocol_id").notNull(),
  type: text("type").notNull(), // 'daily_reminder' | 'milestone' | 'conflict_alert' | 'completion'
  title: text("title").notNull(),
  body: text("body"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type Nudge = typeof nudges.$inferSelect;

// ─── User Supplements ────────────────────────────────────────────────────────
// What the user is currently actually taking (may overlap or differ from protocols)
export const userSupplements = pgTable("prx_user_supplements", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),          // e.g. "Vitamin D3"
  dose: text("dose").notNull(),          // e.g. "5000"
  unit: text("unit").notNull(),          // e.g. "IU" | "mg" | "mcg" | "g"
  frequency: text("frequency").notNull().default("daily"), // e.g. "daily" | "twice daily" | "weekly"
  notes: text("notes"),                  // optional: brand, timing, form
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const insertSupplementSchema = createInsertSchema(userSupplements).omit({ id: true, createdAt: true });
export type InsertSupplement = z.infer<typeof insertSupplementSchema>;
export type UserSupplement = typeof userSupplements.$inferSelect;
