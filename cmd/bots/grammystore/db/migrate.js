// Applies db/migrations/*.sql once on startup so `docker compose up` (or `npm
// start`) upgrades an existing database without manual psql. Each file is
// recorded in a schema_migrations ledger with its SQL checksum and skipped on
// later boots, so destructive or lock-heavy DDL (001-number-retirement drops
// and recreates a constraint) is never replayed after it has been applied. A
// session advisory lock serializes migrators across replicas: the second
// instance waits for the first and then sees every migration already recorded.
//
// A fresh install created from db/init.sql runs every file exactly once before
// the bot starts; an existing install closes any schema gap the same way. Each
// file is sent as a single multi-statement query, so it runs atomically; the
// ledger row is written immediately after, and a crash in between simply
// replays that one (idempotent-by-design) file on the next boot.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseURL } from "../src/config.js";

const migrationsDir = join(fileURLToPath(new URL(".", import.meta.url)), "migrations");

const migrationLockKey = "grammystore migrations";

const ledgerDDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
)`;

function checksumOf(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function applyMigrations(connectionString = databaseURL()) {
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort();
  if (!files.length) return [];
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [migrationLockKey]);
    await client.query(ledgerDDL);
    const applied = [];
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = checksumOf(sql);
      const known = await client.query(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file]
      );
      if (known.rowCount > 0) {
        if (known.rows[0].checksum !== checksum) {
          throw new Error(
            `Migration ${file} was already applied but its SQL changed (checksum ${known.rows[0].checksum} != ${checksum}); refusing to replay it`
          );
        }
        console.log(`Skipping already-applied migration ${file}`);
        continue;
      }
      console.log(`Applying database migration ${file}`);
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
        [file, checksum]
      );
      applied.push(file);
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [migrationLockKey]);
    } catch {
      // The lock dies with the session anyway; never mask the real error.
    }
    client.release();
    await pool.end();
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  applyMigrations().catch((error) => {
    console.error("Database migration failed", error);
    process.exit(1);
  });
}