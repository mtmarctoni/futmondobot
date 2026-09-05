import type { FutmondoRole } from "../futmondo/types";
import type { Availability } from "./availability";

/** Money, prizes and market rules, read from the championship where possible. */
export interface LeagueRules {
  /** Starting budget per manager, in euros. */
  budget: number;
  initialPlayers: number;
  /**
   * Prize money per point scored — the exchange rate between points and cash.
   *
   * Genuinely zero in some leagues, including this one (`moneyPerPoint: 0`),
   * where every euro of prize money comes from the round ranking instead. The
   * default used to be a hardcoded 60.000 and the parser read a key that does
   * not exist, so every "worth about X a round in prize money" sentence in the
   * app was fabricated. Zero means zero, not "unknown, use the default".
   */
  pricePerPoint: number;
  /** Prize pool distributed by round ranking, in euros per round. */
  pricePerRanking: number;
  /**
   * How the ranking pool is split. Observed value here is "flop"; the payout
   * shape behind it is not established, so nothing converts it to a per-point
   * rate. See OPEN-2 in docs/IMPROVEMENT-PLAN.md.
   */
  rankingMode: string | null;
  /**
   * Ceiling Futmondo enforces on any single offer. In this league it is
   * funds + 50% of team value.
   */
  maxOfferTeamValueShare: number;
  /** Share of value the machine pays for a direct sale (`dspct`). */
  directSellShare: number | null;
  /** Floor on our own asking price, as a share of value (`mnmp`). */
  minListingShare: number | null;
  /** Days between acquisition and the clause becoming payable (`enablingClause`). */
  clauseWindowDays: number | null;
  /** How long a listing lives (`bidDuration`). */
  bidDurationDays: number | null;
  /** How many machine listings appear per market refresh (`marketPlayers`). */
  marketPlayers: number | null;
}

export const DEFAULT_RULES: LeagueRules = {
  budget: 210_000_000,
  initialPlayers: 15,
  // Deliberately zero. Inventing a rate produced money claims that were not
  // true of this league; a real rate arrives from the configuration or not at
  // all, and every consumer omits the money sentence when there is none.
  pricePerPoint: 0,
  pricePerRanking: 0,
  rankingMode: null,
  maxOfferTeamValueShare: 0.5,
  directSellShare: null,
  minListingShare: null,
  clauseWindowDays: null,
  bidDurationDays: null,
  marketPlayers: null,
};

/** True when the league actually pays for points, so a money claim is honest. */
export function paysForPoints(rules: LeagueRules): boolean {
  return rules.pricePerPoint > 0;
}

/**
 * What the machine would pay for a player outright, when the league publishes
 * the rate. A guaranteed floor under any sale, and the number a "hold out for
 * more" decision has to be compared against.
 */
export function directSellFloor(
  rules: LeagueRules,
  value: number,
): number | null {
  if (rules.directSellShare === null || rules.directSellShare <= 0) return null;
  return Math.floor(value * rules.directSellShare);
}

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
  /** Set when Futmondo reports an injury, a doubt, a suspension or a departure. */
  unavailableReason: string | null;
  /**
   * How much of that reason to believe. A `doubt` still plays most weeks, so it
   * discounts the projection rather than deleting the player.
   */
  availability: Availability;

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
  /**
   * When the clause first becomes payable, ISO 8601. A clause dated in the
   * future cannot be paid today by anyone, in either direction: no steal to
   * make, and nothing of ours exposed.
   */
  clauseDate: string | null;
  /** Futmondo's own idea of a fair clause, from `/1/player/summary`. */
  suggestedClause: number | null;
  /** True when their owner already has them listed on the market. */
  onMarket: boolean;
  /** The asking price of that listing, when there is one. */
  askPrice: number | null;
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
