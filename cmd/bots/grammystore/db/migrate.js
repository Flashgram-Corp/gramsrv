// Applies db/migrations/*.sql on startup so `docker compose up` (or `npm
// start`) upgrades an existing database without manual psql. Every migration
// is idempotent (ADD COLUMN/INDEX IF NOT EXISTS, drop-then-add constraints),
// so re-running all of them every boot is safe: on a fresh install created
// from db/init.sql they are no-ops, on an existing install they close any
// schema gap. Each file is sent as a single multi-statement query and runs
// atomically.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseURL } from "../src/config.js";

const migrationsDir = join(fileURLToPath(new URL(".", import.meta.url)), "migrations");

export async function applyMigrations(connectionString = databaseURL()) {
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort();
  if (!files.length) return [];
  const pool = new pg.Pool({ connectionString });
  try {
    const applied = [];
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      console.log(`Applying database migration ${file}`);
      await pool.query(sql);
      applied.push(file);
    }
    return applied;
  } finally {
    await pool.end();
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  applyMigrations().catch((error) => {
    console.error("Database migration failed", error);
    process.exit(1);
  });
}