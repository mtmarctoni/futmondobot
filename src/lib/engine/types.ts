import type { FutmondoRole } from "../futmondo/types";

export interface EngineConfig {
  budget: number;
  initialPlayers: number;
  pricePerPoint: number;
}

export interface ScoredPlayer {
  id: string;
  name: string;
  role: FutmondoRole;
  team: string;
  value: number;
  points: number;
  average: number;
  form: number; // derived from last 5 rounds (0-1 scale)
  fixtureDifficulty: number; // lower = easier upcoming fixtures (0-1)
  injuryRisk: number; // 0 = none, 1 = high
  valueScore: number; // points per million, normalized
  score: number; // composite recommendation score (0-100)
}

export function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}
