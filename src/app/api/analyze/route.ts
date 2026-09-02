import { NextResponse } from "next/server";
import { runAnalysis } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  const report = await runAnalysis();
  // A report that could not be produced is still a valid answer describing
  // why, so the UI can render the reason instead of a blank page.
  return NextResponse.json(report, { status: report.error ? 503 : 200 });
}
