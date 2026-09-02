import { NextRequest, NextResponse } from "next/server";
import { authFailureReason, isAuthorizedRequest } from "@/lib/auth";
import { syncAll, syncClausePrices } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The data-collection cron. Every run that succeeds is a day of history the
 * API will never give us again, so this is the job that matters most for the
 * app to get better over time.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedRequest(req)) {
    return NextResponse.json(
      { ok: false, error: authFailureReason() },
      { status: 401 },
    );
  }

  const reports = await syncAll();

  // Clause prices are one request per player, so only a bounded slice runs per
  // invocation. Successive runs rotate through the staleset.
  try {
    reports.push(await syncClausePrices({ limit: 60 }));
  } catch (err) {
    reports.push({
      job: "clauses",
      wrote: {},
      warnings: [err instanceof Error ? err.message : String(err)],
      durationMs: 0,
    });
  }

  const warnings = reports.flatMap((r) => r.warnings);
  return NextResponse.json({ ok: true, reports, warningCount: warnings.length });
}
