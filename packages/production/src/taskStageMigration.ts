import type { Database } from "bun:sqlite";

/** Retains the original table as a migration archive; no task or ledger rows are deleted. */
export function migrateTextTaskStage(db: Database) {
  const schema = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'generation_task'").get() as { sql: string };
  if (schema.sql.includes("'text'")) return;
  const oldCheck = "stage IN ('image','video','speech','transcription','synthesis')";
  if (!schema.sql.includes(oldCheck)) throw new Error("Unknown task schema; migration requires explicit review.");
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'generation_task'").get()) {
    throw new Error("Custom task triggers require explicit migration review.");
  }
  const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'generation_task' AND sql IS NOT NULL").all() as Array<{ name: string }>;
  if (indexes.some(item => !["generation_task_provider_id", "generation_task_recovery"].includes(item.name))) {
    throw new Error("Custom task indexes require explicit migration review.");
  }
  const foreignKeys = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  const legacy = (db.query("PRAGMA legacy_alter_table").get() as { legacy_alter_table: number }).legacy_alter_table;
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
  try {
    if ((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys) {
      throw new Error("Task schema migration cannot run inside another transaction.");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      // Recheck under the writer lock if another process completed migration first.
      const current = db.query("SELECT sql FROM sqlite_master WHERE name = 'generation_task'").get() as { sql: string };
      if (!current.sql.includes("'text'")) {
        const next = current.sql.replace(/CREATE TABLE(?: IF NOT EXISTS)? ["`]?generation_task["`]?/i,
          "CREATE TABLE generation_task_text_upgrade").replace(oldCheck, "stage IN ('image','video','speech','transcription','synthesis','text')");
        db.exec(next);
        db.exec("INSERT INTO generation_task_text_upgrade SELECT * FROM generation_task");
        db.exec("ALTER TABLE generation_task RENAME TO generation_task_before_text");
        db.exec("ALTER TABLE generation_task_text_upgrade RENAME TO generation_task");
        db.exec(`CREATE UNIQUE INDEX generation_task_text_provider_id ON generation_task(provider, provider_task_id)
          WHERE provider_task_id IS NOT NULL;
          CREATE INDEX generation_task_text_recovery ON generation_task(state, request_started, provider_task_id);`);
        if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Task migration foreign key validation failed.");
      }
      db.exec("COMMIT");
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacy}; PRAGMA foreign_keys = ${foreignKeys};`);
  }
}
