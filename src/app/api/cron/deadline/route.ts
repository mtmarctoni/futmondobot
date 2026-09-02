import { NextRequest, NextResponse } from "next/server";
import { runAnalysis } from "@/lib/engine";
import { formatReportMessage, notify } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    const auth = process.env.CRON_SECRET;
    const header = req.headers.get("authorization") ?? "";
    if (auth && header !== `Bearer ${auth}`) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const report = await runAnalysis();
    const msg = formatReportMessage(report);
    const { sent } = await notify(msg);
    return NextResponse.json({ ok: true, sent, headline: report.today.headline });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
