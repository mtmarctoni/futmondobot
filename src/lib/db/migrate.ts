import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@neondatabase/serverless";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * Applies any .sql file in migrations/ that has not run yet, in filename order.
 * Uses the WebSocket client rather than the HTTP one because migration files
 * contain multiple statements per file.
 */
export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client(databaseUrl);
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");

      // Each migration is one transaction: a half-applied schema is worse
      // than a failed run we can retry.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      applied.push(file);
    }
  } finally {
    await client.end();
  }

  return applied;
}
