import type { Metadata } from "next";
import { ClausesClient } from "./clauses-client";

export const metadata: Metadata = {
  title: "Clauses — FutmondoBot",
};

export default function ClausesPage() {
  return <ClausesClient />;
}
