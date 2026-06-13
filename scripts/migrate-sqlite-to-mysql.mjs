import fs from "fs";
import path from "path";

// ─── Load Environment variables manually from .env ───────────────────────────
const envPath = path.resolve(process.cwd(), ".env");
const env = {};
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("=");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join("=").trim();
      env[key] = val;
    }
  }
}

// Fallback values matches database.ts defaults
const mysqlConfig = {
  host: env.DATABASE_HOST || "172.17.0.1",
  port: parseInt(env.DATABASE_PORT || "3306", 10),
  user: env.DATABASE_USER || "forjinn",
  password: env.DATABASE_PASSWORD || "Psgcasmcom@12",
  database: env.DATABASE_NAME || "vedanta",
};

const sqlitePath = path.resolve(process.cwd(), "data", "app.db");

async function main() {
  console.log("=== SQLite to MySQL Data Migration Script ===");
  console.log(`SQLite Database path: ${sqlitePath}`);
  console.log(`MySQL connection: ${mysqlConfig.user}@${mysqlConfig.host}:${mysqlConfig.port}/${mysqlConfig.database}`);

  if (!fs.existsSync(sqlitePath)) {
    console.error(`Error: SQLite database file not found at ${sqlitePath}`);
    process.exit(1);
  }

  // ─── Load modules ──────────────────────────────────────────────────────────
  let Database;
  try {
    const sqliteModule = await import("better-sqlite3");
    Database = sqliteModule.default;
  } catch (err) {
    console.error("\nError: 'better-sqlite3' is not installed.");
    console.error("To run this migration script, please install it temporarily using:");
    console.error("  npm install better-sqlite3 --no-save\n");
    process.exit(1);
  }

  let mysql;
  try {
    mysql = (await import("mysql2/promise")).default;
  } catch (err) {
    console.error("\nError: 'mysql2' is not installed in the workspace.");
    console.error("Please run: npm install\n");
    process.exit(1);
  }

  // ─── Establish connections ──────────────────────────────────────────────────
  let sqliteDb;
  try {
    sqliteDb = new Database(sqlitePath, { readonly: true });
  } catch (err) {
    console.error(`Failed to open SQLite database: ${err.message}`);
    process.exit(1);
  }

  let mysqlPool;
  try {
    mysqlPool = mysql.createPool({
      ...mysqlConfig,
      connectionLimit: 1,
    });
    // Test connection
    await mysqlPool.query("SELECT 1");
  } catch (err) {
    console.error(`Failed to connect to MySQL database: ${err.message}`);
    sqliteDb.close();
    process.exit(1);
  }

  console.log("Successfully connected to both databases. Initializing schema in MySQL...\n");

  try {
    // ─── Create Tables ───────────────────────────────────────────────────────
    await mysqlPool.execute(`
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

    await mysqlPool.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        token TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) CHARACTER SET utf8mb4
    `);

    await mysqlPool.execute(`
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

    await mysqlPool.execute(`
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

    await mysqlPool.execute(`
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

    await mysqlPool.execute(`
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

    await mysqlPool.execute(`
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

    await mysqlPool.execute(`
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

    // Create Indexes
    const indexes = [
      "CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at)",
      "CREATE INDEX idx_conversations_case ON conversations(rca_case_id)",
      "CREATE INDEX idx_rca_cases_user ON rca_cases(user_id)",
      "CREATE INDEX idx_sessions_token ON sessions(token(255))",
      "CREATE INDEX idx_sessions_user ON sessions(user_id)",
      "CREATE INDEX idx_sessions_expires ON sessions(expires_at)",
      "CREATE INDEX idx_collaborators_case ON case_collaborators(case_id)",
      "CREATE INDEX idx_collaborators_user ON case_collaborators(user_id)",
      "CREATE INDEX idx_edit_history_case ON rca_edit_history(case_id, changed_at)",
      "CREATE INDEX idx_invites_code ON invites(code)",
    ];
    for (const idx of indexes) {
      try { await mysqlPool.execute(idx); } catch { /* index already exists */ }
    }

    console.log("Database schema initialized. Starting row migration...\n");

    // ─── Migrate tables in dependency order ──────────────────────────────────
    
    // 1. Users
    await migrateTable(sqliteDb, mysqlPool, "users", [
      "id",
      "email",
      "password_hash",
      "full_name",
      "role",
      "created_at",
      "updated_at",
    ]);

    // 2. Sessions
    await migrateTable(sqliteDb, mysqlPool, "sessions", [
      "id",
      "user_id",
      "token",
      "expires_at",
      "created_at",
    ]);

    // 3. RCA Cases
    await migrateTable(sqliteDb, mysqlPool, "rca_cases", [
      "id",
      "user_id",
      "title",
      "asset_id",
      "status",
      "incident_data",
      "final_report",
      "is_public",
      "public_slug",
      "created_at",
      "updated_at",
    ]);

    // 4. Conversations
    await migrateTable(sqliteDb, mysqlPool, "conversations", [
      "id",
      "user_id",
      "agent_key",
      "session_id",
      "title",
      "incident_context",
      "rca_case_id",
      "created_at",
      "updated_at",
    ]);

    // 5. Messages
    await migrateTable(sqliteDb, mysqlPool, "messages", [
      "id",
      "conversation_id",
      "role",
      "content",
      "raw_response",
      "attachments",
      "created_at",
    ]);

    // 6. Invites
    await migrateTable(sqliteDb, mysqlPool, "invites", [
      "code",
      "email",
      "role",
      "created_by",
      "created_at",
      "expires_at",
      "used_at",
      "used_by",
    ]);

    // 7. Case Collaborators
    await migrateTable(sqliteDb, mysqlPool, "case_collaborators", [
      "id",
      "case_id",
      "user_id",
      "added_by",
      "added_at",
    ]);

    // 8. Edit History
    await migrateTable(sqliteDb, mysqlPool, "rca_edit_history", [
      "id",
      "case_id",
      "user_id",
      "section",
      "snapshot",
      "summary",
      "changed_at",
    ]);

    console.log("\nMigration completed successfully!");
  } catch (err) {
    console.error(`Migration failed with error: ${err.message}`);
  } finally {
    sqliteDb.close();
    await mysqlPool.end();
  }
}

async function migrateTable(sqliteDb, mysqlPool, tableName, columns) {
  console.log(`Migrating table: ${tableName}...`);
  try {
    // Check if SQLite table exists
    const tableCheck = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableCheck) {
      console.log(`SQLite table ${tableName} does not exist, skipping.`);
      return;
    }

    const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all();
    console.log(`-> Found ${rows.length} rows in SQLite`);
    if (rows.length === 0) return;

    const placeholders = columns.map(() => "?").join(", ");
    const query = `INSERT IGNORE INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`;

    let count = 0;
    for (const row of rows) {
      const params = columns.map((col) => {
        const val = row[col];
        if (val === undefined) return null;
        return val;
      });
      await mysqlPool.execute(query, params);
      count++;
    }
    console.log(`-> Migrated ${count}/${rows.length} rows into MySQL`);
  } catch (err) {
    console.error(`-> Error migrating ${tableName}: ${err.message}`);
  }
}

main();
