import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Lazily built so `next build` does not crash when DATABASE_URL is absent —
 * Next evaluates top-level module code at build time, and neon() throws
 * without a URL. A plain function rather than a Proxy: Proxy wrappers around
 * DB clients break libraries that introspect the object.
 */
let cached: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Run `vercel env pull .env.local` or provision the Neon integration.",
    );
  }
  cached = neon(url);
  return cached;
}

/** True when a database is configured, so callers can degrade instead of throw. */
export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Tests only. */
export function resetSqlCache(): void {
  cached = null;
}
