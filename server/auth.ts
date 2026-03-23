import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
import { registerSchema, loginSchema } from "@shared/schema";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET environment variable is required");

export interface AuthRequest extends Request { userId?: number; }

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in." });
  try {
    const payload = jwt.verify(token, JWT_SECRET!) as { userId: number };
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired." });
  }
}

export function registerAuthRoutes(app: any) {
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
      const { email, password, name } = parsed.data;
      if (await storage.getUserByEmail(email)) return res.status(409).json({ error: "Email already in use." });
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await storage.createUser({ email, passwordHash, name });
      const token = jwt.sign({ userId: user.id }, JWT_SECRET!, { expiresIn: "7d" });
      res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input." });
      const { email, password } = parsed.data;
      const user = await storage.getUserByEmail(email);
      if (!user) return res.status(401).json({ error: "Invalid email or password." });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: "Invalid email or password." });
      const token = jwt.sign({ userId: user.id }, JWT_SECRET!, { expiresIn: "7d" });
      res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/auth/me", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user) return res.status(404).json({ error: "User not found." });
      res.json({ id: user.id, email: user.email, name: user.name });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── Login with AXON ─────────────────────────────────────────────────────
  // Step 1: user provides AXON URL + credentials → we get a module token from AXON
  // Step 2: we verify the token → create/find local ProtocolRX user → return PRX JWT
  app.post("/api/auth/axon", async (req: Request, res: Response) => {
    try {
      const { axonUrl, email, password } = req.body;
      if (!axonUrl || !email || !password) {
        return res.status(400).json({ error: "axonUrl, email and password are required." });
      }
      const baseUrl = axonUrl.replace(/\/$/, "");

      // 1. Log in to AXON with user's credentials
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!loginRes.ok) {
        const err = await loginRes.json().catch(() => ({})) as any;
        return res.status(401).json({ error: err.error || "AXON login failed. Check your credentials." });
      }
      const loginData = await loginRes.json() as any;

      // 2. Request a module token from AXON
      const tokenRes = await fetch(`${baseUrl}/api/auth/module-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${loginData.token}` },
        body: JSON.stringify({ module: "protocolrx" }),
      });
      if (!tokenRes.ok) {
        return res.status(500).json({ error: "Could not obtain module token from AXON." });
      }
      const { moduleToken, user: axonUser } = await tokenRes.json() as any;

      // 3. Verify the module token using the shared JWT secret
      let decoded: any;
      try {
        decoded = require("jsonwebtoken").verify(moduleToken, JWT_SECRET!);
      } catch {
        return res.status(401).json({ error: "Invalid module token from AXON." });
      }

      // 4. Find or create local ProtocolRX user (keyed by email)
      let user = await storage.getUserByEmail(decoded.email);
      if (!user) {
        // Auto-create: use a random password hash (user will always log in via AXON)
        const randomHash = await bcrypt.hash(require("crypto").randomBytes(32).toString("hex"), 10);
        user = await storage.createUser({
          email: decoded.email,
          passwordHash: randomHash,
          name: decoded.name,
        });
      }

      // 5. Store AXON connection on this user
      await storage.updateUser(user.id, {
        axonUrl: baseUrl,
        axonUserId: decoded.axonUserId,
      } as any);

      // 6. Issue a ProtocolRX JWT
      const token = require("jsonwebtoken").sign({ userId: user.id }, JWT_SECRET!, { expiresIn: "7d" });
      res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Login with AXON failed." });
    }
  });
}
