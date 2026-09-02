import { ApiFootballProvider } from "./apiFootball";
import type { StatsProvider } from "./types";

let cached: StatsProvider | null = null;

/**
 * Create the active stats provider based on environment configuration.
 * Priority:
 *   1. API-Football (RapidAPI free tier) if API_FOOTBALL_KEY is set.
 *   2. null if no stats data source is configured (features degrade gracefully).
 */
export function getStatsProvider(): StatsProvider | null {
  if (cached) return cached;

  const key = process.env.API_FOOTBALL_KEY;
  if (key) {
    cached = new ApiFootballProvider(key);
  } else {
    cached = null;
  }
  return cached;
}
