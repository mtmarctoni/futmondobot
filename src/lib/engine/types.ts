import type { FutmondoRole } from "../futmondo/types";

/** Money, prizes and market rules, read from the championship where possible. */
export interface LeagueRules {
  /** Starting budget per manager, in euros. */
  budget: number;
  initialPlayers: number;
  /** Prize money per point scored — the exchange rate between points and cash. */
  pricePerPoint: number;
  /**
   * Ceiling Futmondo enforces on any single offer. In this league it is
   * funds + 50% of team value.
   */
  maxOfferTeamValueShare: number;
}

export const DEFAULT_RULES: LeagueRules = {
  budget: 210_000_000,
  initialPlayers: 15,
  pricePerPoint: 60_000,
  maxOfferTeamValueShare: 0.5,
};

/**
 * A player with everything the engine needs to decide about them. Expected
 * points are in real points, not a normalised index, so every downstream
 * number stays interpretable: "6.2 points for 30M" beats "score 78".
 */
export interface Evaluated {
  playerId: string;
  name: string;
  role: FutmondoRole;
  clubName: string | null;
  clubId: string | null;
  slug: string | null;

  value: number;
  seasonPoints: number;

  /** Mean points in rounds where they actually played. */
  pointsPerStart: number;
  /** 0..1 chance of starting the next round. */
  startProbability: number;
  /** 0..1, higher is a harder fixture. */
  fixtureDifficulty: number;
  /** Opponent in the next fixture, for explaining a recommendation. */
  nextOpponent: string | null;
  /** Set when Futmondo reports an injury or suspension. */
  unavailableReason: string | null;

  /** Value change over the trend window, in euros. */
  valueDelta: number;
  /** Rounds of per-round evidence behind pointsPerStart. */
  sampleRounds: number;

  /** The headline number: points we expect next round. */
  expectedPoints: number;
  /** Expected points per million of value. */
  pointsPerMillion: number;

  ownerTeamId: string | null;
  clausePrice: number | null;
  clauseLocked: boolean | null;
  /** Human-readable justification, assembled while scoring. */
  notes: string[];
}

export function millions(euros: number): number {
  return euros / 1_000_000;
}

export function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M€`;
  }
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k€`;
  return `${sign}${Math.round(abs)}€`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
