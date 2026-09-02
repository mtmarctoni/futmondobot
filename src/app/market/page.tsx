import type { Metadata } from "next";
import { runAnalysis } from "@/lib/engine";
import { MarketClient } from "./market-client";

export const metadata: Metadata = {
  title: "Market — FutmondoBot",
};

// The report reads live Futmondo state, so it must never be prerendered.
export const dynamic = "force-dynamic";

export default async function MarketPage() {
  // Running the engine here rather than through /api/analyze means the page
  // arrives with its data and no client round trip.
  const report = await runAnalysis();
  return <MarketClient initial={report} />;
}
