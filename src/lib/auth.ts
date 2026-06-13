import { getDb, generateId } from "./database";
import bcryptPkg from "bcryptjs";
import jwtPkg from "jsonwebtoken";
const { compare, hash } = bcryptPkg;
const { sign, verify } = jwtPkg;

const JWT_SECRET = process.env.JWT_SECRET || "rca-secret-change-me";
const TOKEN_EXPIRY = "30d";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "user";
}

interface DbUser {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  role: "admin" | "user";
  created_at: string;
  updated_at: string;
}

interface DbSession {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

export async function signup(
  email: string,
  password: string,
  fullName?: string,
): Promise<{ user: AuthUser; token: string }> {
  const db = getDb();

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
    | Record<string, unknown>
    | undefined;
  if (existing) {
    throw new Error("Email already registered");
  }

  const passwordHash = await hash(password, 10);
  const id = generateId();

  const result = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const role = result.count === 0 ? "admin" : "user";

  db.prepare(
    "INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)",
  ).run(id, email, passwordHash, fullName || null, role);

  const token = createToken(id);
  createSession(id, token);

  return {
    user: { id, email, fullName: fullName || null, role },
    token,
  };
}

export async function signin(
  email: string,
  password: string,
): Promise<{ user: AuthUser; token: string }> {
  const db = getDb();

  const userRow = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | DbUser
    | undefined;
  if (!userRow) {
    throw new Error("Invalid email or password");
  }

  const valid = await compare(password, userRow.password_hash);
  if (!valid) {
    throw new Error("Invalid email or password");
  }

  const token = createToken(userRow.id);
  createSession(userRow.id, token);

  return {
    user: { id: userRow.id, email: userRow.email, fullName: userRow.full_name, role: userRow.role },
    token,
  };
}

export function createToken(userId: string): string {
  const db = getDb();
  const userRow = db
    .prepare("SELECT email, full_name, role FROM users WHERE id = ?")
    .get(userId) as { email: string; full_name: string | null; role: string } | undefined;
  return sign(
    {
      sub: userId,
      email: userRow?.email || "",
      full_name: userRow?.full_name,
      role: userRow?.role || "user",
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY },
  );
}

export function createSession(userId: string, token: string) {
  const db = getDb();
  const id = generateId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)",
  ).run(id, userId, token, expiresAt);
}

export function invalidateSession(token: string) {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function getSessionUser(token: string): AuthUser | null {
  const db = getDb();
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as
    | DbSession
    | undefined;
  if (!session) return null;

  const exp = new Date(session.expires_at);
  if (exp < new Date()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }

  const userRow = db
    .prepare("SELECT id, email, full_name, role FROM users WHERE id = ?")
    .get(session.user_id) as
    | { id: string; email: string; full_name: string | null; role: string }
    | undefined;
  return userRow
    ? {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        role: userRow.role as "admin" | "user",
      }
    : null;
}

export async function changeUserRole(userId: string, role: "admin" | "user") {
  const db = getDb();
  await Promise.resolve();
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

export function deleteUser(userId: string) {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export interface DbUserRow {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  created_at: string;
  caseCount: number;
  agentUsage: Array<{ agent_key: string; count: number }>;
}

export function getAllUsers(): DbUserRow[] {
  const db = getDb();
  const users = db
    .prepare(
      "SELECT id, email, full_name as fullName, role, created_at FROM users ORDER BY created_at DESC",
    )
    .all() as Array<{
    id: string;
    email: string;
    fullName: string | null;
    role: string;
    created_at: string;
  }>;
  const caseCounts = db
    .prepare("SELECT user_id, COUNT(*) as cnt FROM rca_cases GROUP BY user_id")
    .all() as Array<{ user_id: string; cnt: number }>;
  const countMap = new Map(caseCounts.map((c) => [c.user_id, c.cnt]));

  const agentUsageList = db
    .prepare(
      `
    SELECT user_id, agent_key, COUNT(*) as cnt 
    FROM conversations 
    GROUP BY user_id, agent_key
  `,
    )
    .all() as Array<{ user_id: string; agent_key: string; cnt: number }>;

  const agentUsageMap = new Map<string, Array<{ agent_key: string; count: number }>>();
  for (const item of agentUsageList) {
    if (!agentUsageMap.has(item.user_id)) {
      agentUsageMap.set(item.user_id, []);
    }
    agentUsageMap.get(item.user_id)!.push({ agent_key: item.agent_key, count: item.cnt });
  }

  return users.map((u) => ({
    ...u,
    caseCount: countMap.get(u.id) || 0,
    agentUsage: agentUsageMap.get(u.id) || [],
  }));
}

export interface DbAnalytics {
  userCount: number;
  caseCount: number;
  completedCount: number;
  conversationCount: number;
  messageCount: number;
  agentUsage: Array<{ agent_key: string; count: number }>;
}

export function getAnalytics(): DbAnalytics {
  const db = getDb();
  const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number })
    .count;
  const caseCount = (
    db.prepare("SELECT COUNT(*) as count FROM rca_cases").get() as { count: number }
  ).count;
  const completedCount = (
    db.prepare("SELECT COUNT(*) as count FROM rca_cases WHERE status = 'completed'").get() as {
      count: number;
    }
  ).count;
  const convCount = (
    db.prepare("SELECT COUNT(*) as count FROM conversations").get() as { count: number }
  ).count;
  const msgCount = (db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number })
    .count;
  const agentUsage = db
    .prepare("SELECT agent_key, COUNT(*) as count FROM conversations GROUP BY agent_key")
    .all() as Array<{ agent_key: string; count: number }>;
  return {
    userCount,
    caseCount,
    completedCount,
    conversationCount: convCount,
    messageCount: msgCount,
    agentUsage,
  };
}

export interface DbCaseRow {
  id: string;
  title: string;
  asset_id: string | null;
  status: string;
  created_at: string;
  owner: { email: string | null; fullName: string | null };
}

export function getAllCases(): DbCaseRow[] {
  const db = getDb();
  const cases = db
    .prepare(
      `
    SELECT c.id, c.title, c.asset_id, c.status, c.created_at, u.email as owner_email, u.full_name as owner_name
    FROM rca_cases c
    LEFT JOIN users u ON c.user_id = u.id
    ORDER BY c.created_at DESC
  `,
    )
    .all() as Array<{
    id: string;
    title: string;
    asset_id: string | null;
    status: string;
    created_at: string;
    owner_email: string | null;
    owner_name: string | null;
  }>;
  return cases.map((c) => ({
    ...c,
    owner: { email: c.owner_email, fullName: c.owner_name },
  }));
}

export async function adminCreateUser(
  email: string,
  password: string,
  fullName: string,
  role: "admin" | "user",
): Promise<AuthUser> {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    throw new Error("Email already registered");
  }
  const passwordHash = await hash(password, 10);
  const id = generateId();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)",
  ).run(id, email, passwordHash, fullName || null, role);
  return { id, email, fullName: fullName || null, role };
}

export function createInvite(email: string | null, role: "admin" | "user", createdBy: string) {
  const db = getDb();
  const code =
    Math.random().toString(36).substring(2, 10).toUpperCase() +
    "-" +
    Math.random().toString(36).substring(2, 6).toUpperCase();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO invites (code, email, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(code, email || null, role, createdBy, expiresAt);
  return { code, expiresAt };
}

export interface DbInvite {
  code: string;
  email: string | null;
  role: "admin" | "user";
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  creator_email?: string | null;
}

export function getInvites(): DbInvite[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT i.*, u.email as creator_email 
    FROM invites i
    LEFT JOIN users u ON i.created_by = u.id
    ORDER BY i.created_at DESC
  `,
    )
    .all() as DbInvite[];
}

export function deleteInvite(code: string) {
  const db = getDb();
  db.prepare("DELETE FROM invites WHERE code = ?").run(code);
}

export function verifyInviteCode(code: string): { email: string | null; role: string } {
  const db = getDb();
  const invite = db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as
    | DbInvite
    | undefined;
  if (!invite) {
    throw new Error("Invalid invite code");
  }
  if (invite.used_at) {
    throw new Error("This invite code has already been used");
  }
  if (new Date(invite.expires_at) < new Date()) {
    throw new Error("This invite code has expired");
  }
  return { email: invite.email, role: invite.role };
}

export async function signupWithInvite(
  code: string,
  email: string,
  password: string,
  fullName: string,
) {
  const db = getDb();
  const verified = verifyInviteCode(code);
  if (verified.email && verified.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error("This invite code is restricted to a different email address");
  }

  // Create user using our signup method
  const result = await signup(email, password, fullName);

  // If the invite specified a different role (e.g. admin), update user role
  if (verified.role !== result.user.role) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(verified.role, result.user.id);
    result.user.role = verified.role as "admin" | "user";
  }

  // Mark invite as used
  db.prepare("UPDATE invites SET used_at = datetime('now'), used_by = ? WHERE code = ?").run(
    result.user.id,
    code,
  );

  return result;
}

export async function adminResetPassword(userId: string, newPassword: string) {
  const db = getDb();
  const passwordHash = await hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string) {
  const db = getDb();
  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
    | { password_hash: string }
    | undefined;
  if (!user) {
    throw new Error("User not found");
  }
  const valid = await compare(oldPassword, user.password_hash);
  if (!valid) {
    throw new Error("Incorrect current password");
  }
  const passwordHash = await hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}
