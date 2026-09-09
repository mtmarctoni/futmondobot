/**
 * The low-value opportunity radar: cheap players whose value is rising today.
 *
 * This is a speculation module, and it is deliberately separate from
 * `runMarket`. `market.buys` answers "who improves the XI", ranks by absolute
 * upgrade while cash is abundant, and ignores a player who would not start.
 * The radar answers a different question -- "whose price is moving off the
 * floor" -- so it applies exactly two conditions and no others. Mixing the two
 * rankings would make both unreadable.
 *
 * The daily change comes from `/1/player/summary`'s `prices[]`, which is
 * republished in full on every call and is the one exception to "history
 * cannot be backfilled" (docs/futmondo-api.md). It deliberately does *not*
 * come from `player_snapshots`: the clause-price sync only fans out to players
 * with an owner, so a machine listing -- which is most of what sits at this
 * price -- has no stored series at all.
 */
import type { PlayerPricePoint } from "../futmondo/types";

import { DEFAULT_BID_INCREMENT, suggestBid } from "./market";

/**
 * The price floor this module looks below, in euros.
 *
 * A constant rather than a setting: it is the definition of the module, not a
 * tuning knob, and a threshold that can move without a deploy is a threshold
 * nobody can reconstruct from the report afterwards.
 */
export const LOW_VALUE_CEILING = 2_500_000;

/** A market listing with everything the radar needs to judge it. */
export interface RadarListing {
  playerId: string;
  name: string;
  role: string;
  clubName: string | null;
  /** Asking price: the auction floor, not the market value. */
  price: number;
  /** Market value, the figure the ceiling is applied to. */
  value: number;
  /** Minimum bid step from `/1/market/playerauctionsummary`. */
  increment: number;
  /** Daily value series from `/1/player/summary`. Empty when unread. */
  prices: PlayerPricePoint[];
}

export interface LowValueOpportunity {
  playerId: string;
  name: string;
  role: string;
  clubName: string | null;
  /** Market value today, at or below LOW_VALUE_CEILING. */
  value: number;
  /** Asking price on the listing. */
  price: number;
  /** Euros the value gained on the most recent day. Always positive here. */
  dailyChange: number;
  /** That gain over the previous day's value, as a fraction. 0.05 is +5%. */
  dailyChangePct: number;
  /** Asking price plus whole increment steps: what to actually offer. */
  suggestedBid: number;
  increment: number;
}

export interface RadarInput {
  listings: RadarListing[];
  /** The most Futmondo would let us offer for one player. Caps the bid. */
  ceiling: number;
}

export interface RadarReport {
  /** Cheap and rising, best percentage rise first. */
  opportunities: LowValueOpportunity[];
  /**
   * Listings under the ceiling whose daily change could not be read, because
   * the price series was unread or a day old at most.
   *
   * Counted and surfaced rather than folded into "not rising". An unknown
   * change is not a flat one, and a module that cannot tell them apart makes a
   * failed read look exactly like a market with no opportunities in it.
   */
  unknownChange: number;
}

/**
 * The most recent daily move in a price series.
 *
 * Null when there are fewer than two points, which is a real state: a player
 * who joined the championship today has one valuation and no move yet.
 */
function dailyChange(prices: PlayerPricePoint[]): { change: number; previous: number } | null {
  if (prices.length < 2) return null;
  // Sorted here rather than trusted: `parsePlayerPrices` sorts ascending, but
  // the radar also runs over listings assembled elsewhere, and reading the
  // wrong two points would invent a move that never happened.
  const sorted = [...prices].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  return { change: latest.price - previous.price, previous: previous.price };
}

/**
 * What to actually offer for a cheap listing.
 *
 * `suggestBid` adds a percentage markup and rounds it **down** to a whole
 * increment step, which is right for an expensive player and a no-op for a
 * cheap one: 12% of a 2.0M ask is 240.000, less than the observed 250.000
 * step, so it floors to zero steps and hands back the asking price. The ask is
 * the auction floor, so that bid loses every contested listing by
 * construction -- and this module only ever looks at that band.
 *
 * So the radar raises the floor to one whole step above the ask wherever the
 * ceiling allows it. Where it does not, the shared result stands rather than a
 * bid we could not fund.
 */
function radarBid(args: { price: number; ceiling: number; increment: number }): number {
  const shared = suggestBid(args);
  const increment = args.increment > 0 ? args.increment : DEFAULT_BID_INCREMENT;
  const oneStep = args.price + increment;
  return oneStep <= args.ceiling ? Math.max(shared, oneStep) : shared;
}

/**
 * Cheap players whose value rose on the most recent day, best rise first.
 *
 * Strictly two conditions, as specified: at or under the ceiling, and a
 * positive daily change. Availability, expected points and whether they would
 * start are all deliberately not consulted -- a speculation is a bet on the
 * price, and `market.buys` is where a bet on the XI belongs.
 */
export function detectOpportunities(input: RadarInput): RadarReport {
  const opportunities: LowValueOpportunity[] = [];
  let unknownChange = 0;

  for (const listing of input.listings) {
    if (listing.value > LOW_VALUE_CEILING) continue;

    const move = dailyChange(listing.prices);
    if (move === null) {
      unknownChange += 1;
      continue;
    }
    if (move.change <= 0) continue;

    opportunities.push({
      playerId: listing.playerId,
      name: listing.name,
      role: listing.role,
      clubName: listing.clubName,
      value: listing.value,
      price: listing.price,
      dailyChange: move.change,
      // Against the previous day's value, which is what a percentage rise
      // means. Dividing by today's value would understate every gain.
      dailyChangePct: move.previous > 0 ? move.change / move.previous : 0,
      suggestedBid: radarBid({
        price: listing.price,
        ceiling: input.ceiling,
        increment: listing.increment,
      }),
      increment: listing.increment,
    });
  }

  opportunities.sort((a, b) => b.dailyChangePct - a.dailyChangePct);
  return { opportunities, unknownChange };
}
