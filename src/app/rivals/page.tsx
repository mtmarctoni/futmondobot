import type { Metadata } from "next";
import { runAnalysis } from "@/lib/engine";
import { RivalsClient } from "./rivals-client";

export const metadata: Metadata = {
  title: "Rivals — FutmondoBot",
};

// The report reads live Futmondo state, so it must never be prerendered.
export const dynamic = "force-dynamic";

export default async function RivalsPage() {
  // Running the engine here rather than through /api/analyze means the page
  // arrives with its data and no client round trip.
  const report = await runAnalysis();
  return <RivalsClient initial={report} />;
}
