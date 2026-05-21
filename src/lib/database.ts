import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import bcryptPkg from "bcryptjs";
const { hashSync: bcryptHashSync } = bcryptPkg;

function genUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c: string) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x4).toString(16);
  });
}

const DB_PATH = process.env.DATABASE_PATH || "./data/app.db";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initializeTables();
  }
  return _db;
}

function initializeTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      foreign key (user_id) references users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rca_cases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'archived')),
      incident_data TEXT,
      final_report TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      foreign key (user_id) references users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_key TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(8)))),
      title TEXT,
      incident_context TEXT,
      rca_case_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      foreign key (user_id) references users(id) ON DELETE CASCADE,
      foreign key (rca_case_id) references rca_cases(id) ON DELETE CASCADE,
      UNIQUE(rca_case_id, agent_key, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      raw_response TEXT,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      foreign key (conversation_id) references conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_case ON conversations(rca_case_id);
    CREATE INDEX IF NOT EXISTS idx_rca_cases_user ON rca_cases(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TRIGGER IF NOT EXISTS update_users_timestamp AFTER UPDATE ON users
    BEGIN
      UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS update_cases_timestamp AFTER UPDATE ON rca_cases
    BEGIN
      UPDATE rca_cases SET updated_at = datetime('now') WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS update_conversations_timestamp AFTER UPDATE ON conversations
    BEGIN
      UPDATE conversations SET updated_at = datetime('now') WHERE id = NEW.id;
    END;

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT,
      foreign key (created_by) references users(id) ON DELETE CASCADE,
      foreign key (used_by) references users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
  `);

  const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  if (userCount.count === 0) {
    const adminHash = bcryptHashSync("admin123", 10);
    db.prepare(
      "INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')",
    ).run(generateId(), "admin@rca.local", adminHash, "Admin User");

    const supportHash = bcryptHashSync("Psgcas@12", 10);
    db.prepare(
      "INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')",
    ).run(generateId(), "support@innosynth.org", supportHash, "Support Admin");
  }
}

export function generateId(): string {
  return genUuid();
}

export function cleanExpiredSessions() {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}
