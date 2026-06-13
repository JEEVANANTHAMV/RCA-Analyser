import mysql from "mysql2/promise";
import bcryptPkg from "bcryptjs";
const { hashSync: bcryptHashSync } = bcryptPkg;

function genUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c: string) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x4).toString(16);
  });
}

export function generateId(): string {
  return genUuid();
}

// ─── Connection pool ──────────────────────────────────────────────────────────

let _pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!_pool) {
    _pool = mysql.createPool({
      host: process.env.DATABASE_HOST || "172.17.0.1",
      port: parseInt(process.env.DATABASE_PORT || "3306", 10),
      user: process.env.DATABASE_USER || "forjinn",
      password: process.env.DATABASE_PASSWORD || "Psgcasmcom@12",
      database: process.env.DATABASE_NAME || "vedanta",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: "utf8mb4",
      timezone: "+00:00",
    });
  }
  return _pool;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/** SELECT multiple rows */
export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params ?? []);
  return rows as T[];
}

/** SELECT one row (or null) */
export async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** INSERT / UPDATE / DELETE */
export async function execute(sql: string, params?: any[]): Promise<mysql.ResultSetHeader> {
  const [result] = await getPool().execute(sql, params ?? []);
  return result as mysql.ResultSetHeader;
}

// ─── Schema initialisation ────────────────────────────────────────────────────

let _initialised = false;

export async function initializeSchema(): Promise<void> {
  if (_initialised) return;
  _initialised = true;

  const pool = getPool();

  // Core tables
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      token TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rca_cases (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      title TEXT NOT NULL,
      asset_id TEXT,
      status ENUM('in_progress','completed','archived') NOT NULL DEFAULT 'in_progress',
      incident_data LONGTEXT,
      final_report LONGTEXT,
      is_public TINYINT(1) NOT NULL DEFAULT 0,
      public_slug VARCHAR(50),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      agent_key VARCHAR(100) NOT NULL,
      session_id VARCHAR(100) NOT NULL,
      title TEXT,
      incident_context LONGTEXT,
      rca_case_id VARCHAR(36),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (rca_case_id) REFERENCES rca_cases(id) ON DELETE CASCADE,
      UNIQUE KEY uq_conversation (rca_case_id, agent_key, user_id)
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(36) PRIMARY KEY,
      conversation_id VARCHAR(36) NOT NULL,
      role ENUM('user','assistant','system') NOT NULL,
      content LONGTEXT NOT NULL,
      raw_response LONGTEXT,
      attachments LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS invites (
      code VARCHAR(50) PRIMARY KEY,
      email VARCHAR(255),
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      created_by VARCHAR(36) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      used_by VARCHAR(36),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS case_collaborators (
      id VARCHAR(36) PRIMARY KEY,
      case_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      added_by VARCHAR(36) NOT NULL,
      added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES rca_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_collaborator (case_id, user_id)
    ) CHARACTER SET utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rca_edit_history (
      id VARCHAR(36) PRIMARY KEY,
      case_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      section VARCHAR(100) NOT NULL,
      snapshot LONGTEXT,
      summary TEXT,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES rca_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  // Advisory lock table — one row per case, tracks who is actively editing.
  // Lock expires automatically after 2 hours of no heartbeat.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS case_locks (
      case_id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_heartbeat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES rca_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  // Indexes (CREATE INDEX IF NOT EXISTS not supported in older MySQL — use IF NOT EXISTS workaround)
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_conversations_case ON conversations(rca_case_id)",
    "CREATE INDEX IF NOT EXISTS idx_rca_cases_user ON rca_cases(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token(255))",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_collaborators_case ON case_collaborators(case_id)",
    "CREATE INDEX IF NOT EXISTS idx_collaborators_user ON case_collaborators(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_edit_history_case ON rca_edit_history(case_id, changed_at)",
    "CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code)",
  ];
  for (const idx of indexes) {
    try { await pool.execute(idx); } catch { /* index already exists */ }
  }

  // Seed default admin users if no users exist
  const [countRows] = await pool.execute("SELECT COUNT(*) as count FROM users") as any;
  const userCount = countRows[0].count as number;
  if (userCount === 0) {
    const adminHash = bcryptHashSync("admin123", 10);
    await pool.execute(
      "INSERT IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')",
      [generateId(), "admin@rca.local", adminHash, "Admin User"],
    );
    const supportHash = bcryptHashSync("Psgcas@12", 10);
    await pool.execute(
      "INSERT IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')",
      [generateId(), "support@innosynth.org", supportHash, "Support Admin"],
    );
  }
}

export async function cleanExpiredSessions(): Promise<void> {
  await execute("DELETE FROM sessions WHERE expires_at < NOW()");
}
