import type { Metadata } from "next";
import { LineupClient } from "./lineup-client";

export const metadata: Metadata = {
  title: "Lineup — FutmondoBot",
};

export default function LineupPage() {
  return <LineupClient />;
}
