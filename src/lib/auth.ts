import { query, queryOne, execute, generateId, initializeSchema } from "./database";
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
  await initializeSchema();

  const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) throw new Error("Email already registered");

  const passwordHash = await hash(password, 10);
  const id = generateId();

  const countRow = await queryOne<{ count: number }>("SELECT COUNT(*) as count FROM users");
  const role = (countRow?.count ?? 0) === 0 ? "admin" : "user";

  await execute(
    "INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)",
    [id, email, passwordHash, fullName || null, role],
  );

  const token = await createToken(id);
  await createSession(id, token);

  return { user: { id, email, fullName: fullName || null, role: role as "admin" | "user" }, token };
}

export async function signin(
  email: string,
  password: string,
): Promise<{ user: AuthUser; token: string }> {
  await initializeSchema();

  const userRow = await queryOne<DbUser>("SELECT * FROM users WHERE email = ?", [email]);
  if (!userRow) throw new Error("Invalid email or password");

  const valid = await compare(password, userRow.password_hash);
  if (!valid) throw new Error("Invalid email or password");

  const token = await createToken(userRow.id);
  await createSession(userRow.id, token);

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      fullName: userRow.full_name,
      role: userRow.role,
    },
    token,
  };
}

export async function createToken(userId: string): Promise<string> {
  const userRow = await queryOne<{ email: string; full_name: string | null; role: string }>(
    "SELECT email, full_name, role FROM users WHERE id = ?",
    [userId],
  );
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

export async function createSession(userId: string, token: string): Promise<void> {
  const id = generateId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  // Upsert: if same user_id already has a session, replace it
  await execute(
    "INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE token = VALUES(token), expires_at = VALUES(expires_at)",
    [id, userId, token, expiresAt],
  );
}

export async function invalidateSession(token: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE token = ?", [token]);
}

export async function getSessionUser(token: string): Promise<AuthUser | null> {
  await initializeSchema();

  const session = await queryOne<DbSession>("SELECT * FROM sessions WHERE token = ?", [token]);
  if (!session) return null;

  const exp = new Date(session.expires_at);
  if (exp < new Date()) {
    await execute("DELETE FROM sessions WHERE id = ?", [session.id]);
    return null;
  }

  const userRow = await queryOne<{ id: string; email: string; full_name: string | null; role: string }>(
    "SELECT id, email, full_name, role FROM users WHERE id = ?",
    [session.user_id],
  );
  return userRow
    ? {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        role: userRow.role as "admin" | "user",
      }
    : null;
}

export async function changeUserRole(userId: string, role: "admin" | "user"): Promise<void> {
  await execute("UPDATE users SET role = ? WHERE id = ?", [role, userId]);
}

export function deleteUser(userId: string): Promise<void> {
  return execute("DELETE FROM users WHERE id = ?", [userId]).then(() => undefined);
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

export async function getAllUsers(): Promise<DbUserRow[]> {
  const users = await query<{
    id: string;
    email: string;
    fullName: string | null;
    role: string;
    created_at: string;
  }>("SELECT id, email, full_name as fullName, role, created_at FROM users ORDER BY created_at DESC");

  const caseCounts = await query<{ user_id: string; cnt: number }>(
    "SELECT user_id, COUNT(*) as cnt FROM rca_cases GROUP BY user_id",
  );
  const countMap = new Map(caseCounts.map((c) => [c.user_id, c.cnt]));

  const agentUsageList = await query<{ user_id: string; agent_key: string; cnt: number }>(
    "SELECT user_id, agent_key, COUNT(*) as cnt FROM conversations GROUP BY user_id, agent_key",
  );
  const agentUsageMap = new Map<string, Array<{ agent_key: string; count: number }>>();
  for (const item of agentUsageList) {
    if (!agentUsageMap.has(item.user_id)) agentUsageMap.set(item.user_id, []);
    agentUsageMap.get(item.user_id)!.push({ agent_key: item.agent_key, count: Number(item.cnt) });
  }

  return users.map((u) => ({
    ...u,
    caseCount: countMap.get(u.id) ? Number(countMap.get(u.id)) : 0,
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

export async function getAnalytics(): Promise<DbAnalytics> {
  const [userCount, caseCount, completedCount, convCount, msgCount, agentUsage] = await Promise.all([
    queryOne<{ count: number }>("SELECT COUNT(*) as count FROM users"),
    queryOne<{ count: number }>("SELECT COUNT(*) as count FROM rca_cases"),
    queryOne<{ count: number }>("SELECT COUNT(*) as count FROM rca_cases WHERE status = 'completed'"),
    queryOne<{ count: number }>("SELECT COUNT(*) as count FROM conversations"),
    queryOne<{ count: number }>("SELECT COUNT(*) as count FROM messages"),
    query<{ agent_key: string; count: number }>(
      "SELECT agent_key, COUNT(*) as count FROM conversations GROUP BY agent_key",
    ),
  ]);
  return {
    userCount: Number(userCount?.count ?? 0),
    caseCount: Number(caseCount?.count ?? 0),
    completedCount: Number(completedCount?.count ?? 0),
    conversationCount: Number(convCount?.count ?? 0),
    messageCount: Number(msgCount?.count ?? 0),
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

export async function getAllCases(): Promise<DbCaseRow[]> {
  const cases = await query<{
    id: string;
    title: string;
    asset_id: string | null;
    status: string;
    created_at: string;
    owner_email: string | null;
    owner_name: string | null;
  }>(`
    SELECT c.id, c.title, c.asset_id, c.status, c.created_at, u.email as owner_email, u.full_name as owner_name
    FROM rca_cases c
    LEFT JOIN users u ON c.user_id = u.id
    ORDER BY c.created_at DESC
  `);
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
  const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) throw new Error("Email already registered");
  const passwordHash = await hash(password, 10);
  const id = generateId();
  await execute(
    "INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)",
    [id, email, passwordHash, fullName || null, role],
  );
  return { id, email, fullName: fullName || null, role };
}

export async function createInvite(
  email: string | null,
  role: "admin" | "user",
  createdBy: string,
): Promise<{ code: string; expiresAt: string }> {
  const code =
    Math.random().toString(36).substring(2, 10).toUpperCase() +
    "-" +
    Math.random().toString(36).substring(2, 6).toUpperCase();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await execute(
    "INSERT INTO invites (code, email, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    [code, email || null, role, createdBy, expiresAt],
  );
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

export async function getInvites(): Promise<DbInvite[]> {
  return query<DbInvite>(`
    SELECT i.*, u.email as creator_email
    FROM invites i
    LEFT JOIN users u ON i.created_by = u.id
    ORDER BY i.created_at DESC
  `);
}

export async function deleteInvite(code: string): Promise<void> {
  await execute("DELETE FROM invites WHERE code = ?", [code]);
}

export function verifyInviteCode(invite: DbInvite): { email: string | null; role: string } {
  if (invite.used_at) throw new Error("This invite code has already been used");
  if (new Date(invite.expires_at) < new Date()) throw new Error("This invite code has expired");
  return { email: invite.email, role: invite.role };
}

export async function getInviteByCode(code: string): Promise<DbInvite | null> {
  const invite = await queryOne<DbInvite>("SELECT * FROM invites WHERE code = ?", [code]);
  if (!invite) throw new Error("Invalid invite code");
  return invite;
}

export async function signupWithInvite(
  code: string,
  email: string,
  password: string,
  fullName: string,
): Promise<{ user: AuthUser; token: string }> {
  const invite = await getInviteByCode(code);
  if (!invite) throw new Error("Invalid invite code");
  const verified = verifyInviteCode(invite);
  if (verified.email && verified.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error("This invite code is restricted to a different email address");
  }

  const result = await signup(email, password, fullName);

  if (verified.role !== result.user.role) {
    await execute("UPDATE users SET role = ? WHERE id = ?", [verified.role, result.user.id]);
    result.user.role = verified.role as "admin" | "user";
  }

  await execute(
    "UPDATE invites SET used_at = NOW(), used_by = ? WHERE code = ?",
    [result.user.id, code],
  );

  return result;
}

export async function adminResetPassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await hash(newPassword, 10);
  await execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
  await execute("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await queryOne<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    [userId],
  );
  if (!user) throw new Error("User not found");
  const valid = await compare(oldPassword, user.password_hash);
  if (!valid) throw new Error("Incorrect current password");
  const passwordHash = await hash(newPassword, 10);
  await execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
}
