import type { Metadata } from "next";
import { runAnalysis } from "@/lib/engine";
import { LineupClient } from "./lineup-client";

export const metadata: Metadata = {
  title: "Lineup — FutmondoBot",
};

// The report reads live Futmondo state, so it must never be prerendered.
export const dynamic = "force-dynamic";

export default async function LineupPage() {
  // Running the engine here rather than through /api/analyze means the page
  // arrives with its data and no client round trip.
  const report = await runAnalysis();
  return <LineupClient initial={report} />;
}
