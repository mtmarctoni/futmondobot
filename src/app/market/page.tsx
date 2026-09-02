import type { Metadata } from "next";
import { MarketClient } from "./market-client";

export const metadata: Metadata = {
  title: "Market — FutmondoBot",
};

export default function MarketPage() {
  return <MarketClient />;
}
