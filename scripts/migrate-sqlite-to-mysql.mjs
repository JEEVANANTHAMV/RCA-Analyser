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

  console.log("Successfully connected to both databases. Starting migration...\n");

  try {
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
