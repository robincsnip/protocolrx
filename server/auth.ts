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
}
