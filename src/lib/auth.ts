import type { NextRequest } from "next/server";

/**
 * Guards cron and sync routes. These endpoints can write to Futmondo and burn
 * API quota, so an unset CRON_SECRET denies access rather than allowing it.
 */
export function isAuthorizedRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;

  // Vercel Cron sends the secret in this header on some plans.
  return req.headers.get("x-vercel-cron-secret") === secret;
}

export function authFailureReason(): string {
  return process.env.CRON_SECRET
    ? "Send Authorization: Bearer <CRON_SECRET>."
    : "CRON_SECRET is not set, so protected routes are disabled.";
}
