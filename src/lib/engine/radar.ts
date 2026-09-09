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

import { suggestBid } from "./market";

/**
 * The price floor this module looks below, in euros.
 *
 * A constant rather than a setting: it is the definition of the module, not a
 * tuning knob, and a threshold that can move without a deploy is a threshold
 * nobody can reconstruct from the report afterwards.
 */
export const LOW_VALUE_CEILING = 2_500_000;

/**
 * How far apart the two newest valuations may be, and how old the newest may
 * be, before the change between them stops being a *daily* one.
 *
 * Futmondo stamps the series around 02:25 UTC and the report runs whenever it
 * runs, so an exact 24h rule would reject every real series. Thirty-six hours
 * absorbs that jitter while still refusing a gap of two days or more.
 *
 * This matters because the alternative is a false claim rather than a missing
 * one: without it, a player last revalued a week ago is reported as "up 120k
 * today", and someone bids on that sentence.
 */
const DAILY_TOLERANCE_MS = 36 * 60 * 60 * 1000;

/**
 * Whether a listing is cheap enough to be worth a radar opinion at all.
 *
 * The single definition of "cheap", used both to decide which listings are
 * worth spending a value-history call on and to filter the results. Two copies
 * of this rule would drift by a euro and the radar would silently stop seeing
 * a player, with nothing anywhere reporting an error.
 */
export function couldBeOpportunity(value: number): boolean {
  return value > 0 && value <= LOW_VALUE_CEILING;
}

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
  /** When the report is being produced, to judge whether a series is current. */
  now: Date;
}

export interface RadarReport {
  /** Cheap and rising, best percentage rise first. */
  opportunities: LowValueOpportunity[];
  /**
   * Listings under the ceiling whose daily change could not be established:
   * the series was unread, has a single point, is stale, or has a hole in it
   * where yesterday should be.
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
function dailyChange(
  prices: PlayerPricePoint[],
  now: Date,
): { change: number; previous: number } | null {
  if (prices.length < 2) return null;
  // Sorted here rather than trusted: `parsePlayerPrices` sorts ascending, but
  // the radar also runs over listings assembled elsewhere, and reading the
  // wrong two points would invent a move that never happened.
  const sorted = [...prices].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];

  const latestAt = Date.parse(latest.date);
  const previousAt = Date.parse(previous.date);
  if (Number.isNaN(latestAt) || Number.isNaN(previousAt)) return null;

  // A stale series and a series with a hole in it are both "we do not know
  // today's change", not "today's change was this". Saying otherwise attaches
  // the word "today" to a move that happened a week ago.
  if (now.getTime() - latestAt > DAILY_TOLERANCE_MS) return null;
  if (latestAt - previousAt > DAILY_TOLERANCE_MS) return null;

  // A previous price of zero is the same parse artifact a current value of
  // zero is, and there is no percentage to express against it. Reporting it
  // printed "+100k (+0.0%)" -- a line that contradicts itself -- and sorted
  // the most extreme move in the list dead last.
  if (previous.price <= 0) return null;

  return { change: latest.price - previous.price, previous: previous.price };
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
    // A zero or negative value is a parse failure, not the cheapest player in
    // the league, and presenting one as a free opportunity is how a wrong
    // reading becomes a bid.
    if (!couldBeOpportunity(listing.value)) continue;

    const move = dailyChange(listing.prices, input.now);
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
      // means. Dividing by today's value would understate every gain, and the
      // previous value is guaranteed positive by dailyChange.
      dailyChangePct: move.change / move.previous,
      suggestedBid: suggestBid({
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
