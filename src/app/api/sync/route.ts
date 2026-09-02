import { NextRequest, NextResponse } from "next/server";
import { authFailureReason, isAuthorizedRequest } from "@/lib/auth";
import {
  backfillRoundPoints,
  syncAvailability,
  syncClausePrices,
  syncDaily,
  syncLedger,
  syncOdds,
  syncProbableLineups,
  type SyncReport,
} from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const JOBS = {
  daily: () => syncDaily(),
  ledger: () => syncLedger(),
  odds: () => syncOdds(),
  availability: () => syncAvailability(),
  roundPoints: () => backfillRoundPoints(),
  clauses: () => syncClausePrices(),
  probableLineups: () => syncProbableLineups(),
} as const;

type JobName = keyof typeof JOBS;

function isJobName(value: string): value is JobName {
  return value in JOBS;
}

/**
 * Runs one named job, or the cheap set when none is named. Jobs are run in
 * sequence rather than in parallel: the Futmondo client shares one throttled
 * queue, so concurrency would gain nothing and only complicate failure.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedRequest(req)) {
    return NextResponse.json(
      { ok: false, error: authFailureReason() },
      { status: 401 },
    );
  }

  const requested = req.nextUrl.searchParams.get("job");
  const names: JobName[] = requested
    ? isJobName(requested)
      ? [requested]
      : []
    : ["daily", "ledger", "odds", "availability", "roundPoints", "probableLineups"];

  if (names.length === 0) {
    return NextResponse.json(
      { ok: false, error: `Unknown job. Available: ${Object.keys(JOBS).join(", ")}` },
      { status: 400 },
    );
  }

  const reports: SyncReport[] = [];
  for (const name of names) {
    try {
      reports.push(await JOBS[name]());
    } catch (err) {
      reports.push({
        job: name,
        wrote: {},
        warnings: [err instanceof Error ? err.message : String(err)],
        durationMs: 0,
      });
    }
  }

  return NextResponse.json({ ok: true, reports });
}

export const GET = POST;
