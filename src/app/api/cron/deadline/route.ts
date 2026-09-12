import { NextRequest, NextResponse } from "next/server";
import { authFailureReason, isAuthorizedRequest } from "@/lib/auth";
import { runAutomation } from "@/lib/automation";
import { sendReport } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The decision cron: set the lineup, then send the remaining money decisions
 * to Telegram as buttons.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedRequest(req)) {
    return NextResponse.json(
      { ok: false, error: authFailureReason() },
      { status: 401 },
    );
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const result = await runAutomation({ dryRun });

  let sent = 0;
  let notifyError: string | null = null;
  try {
    // Telegram failing must not hide that the lineup was written.
    // The notes are how a lineup write becomes visible: it leaves no trace in
    // any Futmondo payload.
    ({ sent } = await sendReport(result.report, result.notes));
  } catch (err) {
    notifyError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    sent,
    notifyError,
    headline: result.report.today.headline,
    lineup: result.lineup,
    notes: result.notes,
  });
}
