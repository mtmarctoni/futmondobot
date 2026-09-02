import type { Metadata } from "next";
import { runAnalysis } from "@/lib/engine";
import { ClausesClient } from "./clauses-client";

export const metadata: Metadata = {
  title: "Clauses — FutmondoBot",
};

// The report reads live Futmondo state, so it must never be prerendered.
export const dynamic = "force-dynamic";

export default async function ClausesPage() {
  // Running the engine here rather than through /api/analyze means the page
  // arrives with its data and no client round trip.
  const report = await runAnalysis();
  return <ClausesClient initial={report} />;
}
