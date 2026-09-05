/**
 * Market decisions.
 *
 * Two things earn money here, and they are not the same thing:
 *
 *   - Points. Where the league pays per point, a player who scores more is
 *     worth paying for even at a poor price per million. Where it does not —
 *     and this one does not, `moneyPerPoint` is 0 — points are still the whole
 *     objective, they simply do not convert to a euro figure. Nothing here
 *     prints a prize-money sentence unless the league actually pays one.
 *   - Value drift. Futmondo revalues players daily. Buying a rising player and
 *     selling a falling one compounds, and it is invisible without history —
 *     which is exactly what the snapshot table provides.
 *
 * Recommendations therefore compare a candidate against the player they would
 * actually replace, rather than ranking the market in isolation. A brilliant
 * forward is not a buy if your forwards are already better.
 *
 * Bidding is priced rather than accepted: proposing the asking price loses
 * every contested auction by construction, so a candidate carries a ceiling
 * (the most the player is worth to us) and a bid inside it, rounded to the
 * auction's own increment.
 */
import type { FutmondoRole } from "../futmondo/types";
import {
  directSellFloor,
  fmtMoney,
  millions,
  paysForPoints,
  type Evaluated,
  type LeagueRules,
} from "./types";

/**
 * Fallback minimum bid step, used only when `/1/market/playerauctionsummary`
 * could not be read for a candidate. Observed as 250.000 for one player; it may
 * well scale with value, so the live figure always wins.
 */
export const DEFAULT_BID_INCREMENT = 250_000;

/**
 * How far above the asking price to bid when nothing bounds us but the ceiling.
 *
 * A placeholder, and stated as one. The honest input is a clearing-price model
 * fitted to the `transfers` ledger — what listings actually sold for — and 21
 * rows is not a model. Until then a fixed markup at least stops us bidding the
 * floor. See IMP-9.
 */
export const PLACEHOLDER_MARKUP = 0.12;

/**
 * Rounds remaining in a season, used to turn a per-round upgrade into what the
 * player is worth over the rest of the campaign. Deliberately crude: the exact
 * figure matters far less than not treating a signing as a one-round rental.
 */
const REMAINING_ROUNDS_ASSUMPTION = 30;

export interface BuyCandidate {
  player: Evaluated;
  /** What the purchase would cost at the asking price: the floor, not a plan. */
  price: number;
  /** Expected points gained per round by replacing the weakest starter. */
  upgrade: number;
  /** The player they would displace, when they would displace anyone. */
  replaces: Evaluated | null;
  /**
   * Prize money per round the upgrade is worth. Null where the league does not
   * pay per point, which is not the same as zero and must not be printed.
   */
  weeklyReturn: number | null;
  /** The most this player is worth to us, bounded by funds and the ceiling. */
  ceiling: number;
  /** What to actually offer: asking price plus whole increment steps. */
  suggestedBid: number;
  /** The auction's minimum step, live where we could read it. */
  increment: number;
  affordable: boolean;
  reason: string;
}

export interface SellCandidate {
  player: Evaluated;
  /** Expected points lost per round by selling. Zero for a spare part. */
  cost: number;
  /** What the machine would pay outright, when the league publishes the rate. */
  directSell: number | null;
  /** True when they are already listed, so a sell action would duplicate one. */
  alreadyListed: boolean;
  reason: string;
}

/** One of our own listings, with whatever bids stand against it. */
export interface OwnListing {
  playerId: string;
  name: string;
  /** What we are asking. */
  price: number;
  value: number;
  expiresAt: string | null;
  /** Hours until the listing closes, negative once it has. */
  hoursToExpiry: number | null;
  /** Highest standing bid, when Futmondo reports the bid array. */
  topBid: number | null;
  bidCount: number;
  /** The guaranteed alternative: what the machine would pay right now. */
  directSell: number | null;
  reason: string;
}

export interface MarketReport {
  buys: BuyCandidate[];
  sells: SellCandidate[];
  /** Our own listings and the bids on them. Empty when the read failed. */
  listings: OwnListing[];
  funds: number;
  /** Funds already committed to standing bids, from `information.withheld`. */
  committed: number;
  /** Most Futmondo will let us offer for one player. */
  maxOffer: number;
  headline: string;
}

export interface MarketContext {
  /** Players listed today, machine-owned or from rivals. */
  listings: {
    player: Evaluated;
    price: number;
    /** Minimum bid step from `/1/market/playerauctionsummary`, when read. */
    increment?: number;
  }[];
  squad: Evaluated[];
  /** Who we would field right now, so a buy is judged against real starters. */
  starterIds: Set<string>;
  funds: number;
  teamValue: number;
  rules: LeagueRules;
  /** From /1/userteam/information when Futmondo reports it. */
  reportedMaxBid?: number;
  /** Cash held by our own standing bids. Not available to spend twice. */
  committed?: number;
  /** Our own market listings, from `/1/market/myplayers`. */
  ownListings?: {
    playerId: string;
    name: string;
    price: number;
    value: number;
    expiresAt?: string;
    bids?: { price: number }[];
  }[];
  now?: Date;
}

/**
 * A player is only worth buying if they would actually play. The comparison is
 * against the weakest current starter in the same role, since roles are
 * disjoint in this league.
 */
function weakestStarter(
  squad: Evaluated[],
  starterIds: Set<string>,
  role: FutmondoRole,
): Evaluated | null {
  const starters = squad
    .filter((p) => p.role === role && starterIds.has(p.playerId))
    .sort((a, b) => a.expectedPoints - b.expectedPoints);
  return starters[0] ?? null;
}

export function maxOffer(ctx: MarketContext): number {
  const computed = ctx.funds + ctx.teamValue * ctx.rules.maxOfferTeamValueShare;
  // Trust Futmondo's own ceiling when it gives one; ours is derived from the
  // settings and could drift if the league is reconfigured.
  //
  // Floored to whole euros: money in this game is integer euros, and a share of
  // team value lands on a fraction. Rounding up would offer a cent more than
  // the ceiling allows, so the ceiling rounds down.
  return Math.floor(ctx.reportedMaxBid ?? computed);
}

/**
 * The most a player is worth to us, in euros.
 *
 * Where the league pays for points, this is arithmetic: the points they add
 * over whoever they displace, for the rest of the season, at the league's own
 * rate, plus what we would get back on resale — which is most of the price in a
 * game where a player can be sold to the machine for a fixed share of value.
 *
 * Where it pays nothing per point, as here, that first term does not exist and
 * cannot be invented; `rankingMode: "flop"` is not decoded well enough to turn
 * a ranking payout into a per-point rate (OPEN-2). But the answer is not the
 * liquidation floor either. Selling to the machine at 80% is what we would take
 * if forced, not what the player is worth to us, and anchoring on it makes
 * every ceiling fall below every asking price — which silently collapses every
 * bid back to the floor and undoes the point of pricing a bid at all.
 *
 * So with no rate, the anchor is the player's own market value, plus a bounded
 * premium when he actually improves the team. That is defensible on its own
 * terms: cash here has no yield whatsoever, so the alternative to paying a
 * premium is holding money that earns nothing and scores nothing. The size of
 * the premium is a placeholder, and stated as one.
 */
export function willingnessToPay(args: {
  player: Evaluated;
  upgrade: number;
  rules: LeagueRules;
  funds: number;
  ceiling: number;
}): number {
  const { player, upgrade, rules, funds, ceiling } = args;
  const bounded = (worth: number) => Math.floor(Math.min(worth, ceiling, funds));

  if (paysForPoints(rules)) {
    const pointsWorth =
      Math.max(0, upgrade) * REMAINING_ROUNDS_ASSUMPTION * rules.pricePerPoint;
    // The direct-sell share is a floor Futmondo guarantees; without it, resale
    // is a guess, so fall back to plain value.
    const recoverable = directSellFloor(rules, player.value) ?? player.value;
    return bounded(pointsWorth + recoverable);
  }

  const premium = upgrade > 0 ? player.value * PLACEHOLDER_MARKUP : 0;
  return bounded(player.value + premium);
}

/**
 * The bid to actually place: the asking price plus a whole number of increment
 * steps, sized by how much headroom the ceiling leaves and capped by it.
 *
 * Rounded to the increment because an off-step bid may be rejected outright,
 * and never below the asking price, which is the auction's own floor.
 */
export function suggestBid(args: {
  price: number;
  ceiling: number;
  increment: number;
}): number {
  const increment = args.increment > 0 ? args.increment : DEFAULT_BID_INCREMENT;
  if (args.ceiling <= args.price) return args.price;

  const headroom = args.ceiling - args.price;
  const wanted = Math.min(headroom, args.price * PLACEHOLDER_MARKUP);
  const steps = Math.floor(wanted / increment);
  return args.price + steps * increment;
}

export function runMarket(ctx: MarketContext): MarketReport {
  const ceiling = maxOffer(ctx);
  const committed = ctx.committed ?? 0;
  // Winning every open bid has to remain affordable, so cash already held by a
  // standing bid is not cash we can offer again.
  const spendable = Math.max(0, ctx.funds - committed);

  const buys: BuyCandidate[] = ctx.listings
    .map(({ player, price, increment }) => {
      const replaces = weakestStarter(ctx.squad, ctx.starterIds, player.role);
      const upgrade = replaces
        ? player.expectedPoints - replaces.expectedPoints
        : // No starter in that role at all: the whole projection is upside,
          // because the alternative is an empty slot scoring nothing.
          player.expectedPoints;
      const weeklyReturn = paysForPoints(ctx.rules)
        ? upgrade * ctx.rules.pricePerPoint
        : null;
      const affordable = price <= ceiling && price <= spendable;
      const step = increment ?? DEFAULT_BID_INCREMENT;
      const payUpTo = willingnessToPay({
        player,
        upgrade,
        rules: ctx.rules,
        funds: spendable,
        ceiling,
      });

      return {
        player,
        price,
        upgrade,
        replaces,
        weeklyReturn,
        ceiling: payUpTo,
        suggestedBid: suggestBid({ price, ceiling: payUpTo, increment: step }),
        increment: step,
        affordable,
        reason: buyReason({
          player,
          price,
          upgrade,
          replaces,
          affordable,
          ceiling,
          funds: spendable,
          weeklyReturn,
        }),
      };
    })
    // Only surface genuine improvements. Ranking the whole market produces
    // confident-looking noise.
    .filter((c) => c.upgrade > 0);

  buys.sort(rankBuys(cashBinds(buys)));

  const sells: SellCandidate[] = ctx.squad
    .filter((p) => !ctx.starterIds.has(p.playerId))
    .map((player) => {
      const replaces = weakestStarter(ctx.squad, ctx.starterIds, player.role);
      // Selling a substitute costs nothing unless they are better than the
      // starter they sit behind — in which case the lineup, not the market,
      // is the problem.
      const cost = replaces
        ? Math.max(0, player.expectedPoints - replaces.expectedPoints)
        : player.expectedPoints;
      const floor = directSellFloor(ctx.rules, player.value);
      return {
        player,
        cost,
        directSell: floor,
        alreadyListed: player.onMarket,
        reason: sellReason(player, cost, floor),
      };
    })
    .sort((a, b) => {
      // Prefer selling players who cost us nothing and whose value is falling.
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.player.valueDelta - b.player.valueDelta;
    });

  const listings = buildOwnListings(ctx);

  return {
    buys,
    sells,
    listings,
    funds: ctx.funds,
    committed,
    maxOffer: ceiling,
    headline: headline(buys, sells, listings, ctx),
  };
}

/**
 * Whether cash is actually the binding constraint.
 *
 * Measured against the candidates in front of us rather than a fixed
 * threshold: if the biggest upgrade on the market is one we can afford, money
 * is not what limits us. Computed once over the whole list so the comparator
 * stays a total order — a per-pair test would not be transitive and the sort
 * would depend on input order.
 */
function cashBinds(buys: BuyCandidate[]): boolean {
  if (buys.length === 0) return false;
  const best = Math.max(...buys.map((b) => b.upgrade));
  const affordable = buys.filter((b) => b.affordable);
  if (affordable.length === 0) return true;
  return Math.max(...affordable.map((b) => b.upgrade)) < best;
}

/**
 * How to order buy candidates.
 *
 * Points per million is the right objective when cash is the binding
 * constraint. It is the wrong one when it is not: with 202M idle in a 210M
 * budget and no yield on cash whatsoever, efficiency ranking put a 1.0M
 * defender at the top of the list and left the money doing nothing. So the
 * default is the biggest absolute upgrade we can afford, and efficiency only
 * takes over once funds actually bind.
 */
function rankBuys(binding: boolean) {
  return (a: BuyCandidate, b: BuyCandidate): number => {
    if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;

    if (binding) {
      const aEff = a.price > 0 ? a.upgrade / millions(a.price) : a.upgrade;
      const bEff = b.price > 0 ? b.upgrade / millions(b.price) : b.upgrade;
      if (bEff !== aEff) return bEff - aEff;
    }

    if (b.upgrade !== a.upgrade) return b.upgrade - a.upgrade;
    // Same upgrade for less money is strictly better.
    return a.price - b.price;
  };
}

/**
 * Our own listings, with the bids standing against them.
 *
 * The engine was blind to these: it read the daily market and never
 * `/1/market/myplayers`, so it recommended selling a player who was already
 * listed and could not mention a 16.45M bid expiring inside the lineup window.
 * Nothing here is automated — accepting or cancelling moves money.
 */
function buildOwnListings(ctx: MarketContext): OwnListing[] {
  const now = ctx.now ?? new Date();

  return (ctx.ownListings ?? [])
    .map((listing) => {
      const bids = listing.bids ?? [];
      const topBid = bids.length
        ? Math.max(...bids.map((b) => b.price))
        : null;
      const expiresAt = listing.expiresAt ?? null;
      const hoursToExpiry = expiresAt
        ? (new Date(expiresAt).getTime() - now.getTime()) / 3_600_000
        : null;
      const floor = directSellFloor(ctx.rules, listing.value);

      return {
        playerId: listing.playerId,
        name: listing.name,
        price: listing.price,
        value: listing.value,
        expiresAt,
        hoursToExpiry: hoursToExpiry === null || Number.isNaN(hoursToExpiry)
          ? null
          : hoursToExpiry,
        topBid,
        bidCount: bids.length,
        directSell: floor,
        reason: listingReason(listing.price, topBid, hoursToExpiry, floor),
      };
    })
    // Soonest to expire first: a bid closing inside the lineup window deserves
    // more attention than a marginal buy that will still be there tomorrow.
    .sort((a, b) => {
      if (a.hoursToExpiry === null) return 1;
      if (b.hoursToExpiry === null) return -1;
      return a.hoursToExpiry - b.hoursToExpiry;
    });
}

function listingReason(
  price: number,
  topBid: number | null,
  hoursToExpiry: number | null,
  directSell: number | null,
): string {
  const when =
    hoursToExpiry === null
      ? ""
      : hoursToExpiry < 0
        ? " It has already closed."
        : ` Closes in ${formatHours(hoursToExpiry)}.`;

  const floor =
    directSell === null
      ? ""
      : ` Selling to the machine instead is a guaranteed ${fmtMoney(directSell)}.`;

  if (topBid === null) {
    return `Listed at ${fmtMoney(price)} with no bids yet.${when}${floor}`;
  }
  const gap = price - topBid;
  const versus =
    gap > 0
      ? `${fmtMoney(gap)} under the asking price`
      : `at or above the asking price`;
  return `Top bid ${fmtMoney(topBid)}, ${versus}.${when}${floor}`;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function buyReason(args: {
  player: Evaluated;
  price: number;
  upgrade: number;
  replaces: Evaluated | null;
  affordable: boolean;
  ceiling: number;
  funds: number;
  weeklyReturn: number | null;
}): string {
  const { player, price, upgrade, replaces, affordable, ceiling, funds, weeklyReturn } =
    args;

  if (!affordable) {
    const blocker = price > ceiling
      ? `over the ${fmtMoney(ceiling)} offer ceiling`
      : `more than the ${fmtMoney(funds)} available`;
    return `${fmtMoney(price)} is ${blocker}.`;
  }

  const gain = replaces
    ? `+${upgrade.toFixed(1)} pts/round over ${replaces.name}`
    : `+${upgrade.toFixed(1)} pts/round into an empty ${player.role} slot`;

  // Only stated where the league genuinely pays for points. Printing "0€ a
  // round" would be as misleading as the invented 60k/point it replaces.
  const money =
    weeklyReturn !== null && weeklyReturn > 0
      ? ` About ${fmtMoney(weeklyReturn)} a round in prize money.`
      : "";

  const trend =
    player.valueDelta > 250_000
      ? ` Value up ${fmtMoney(player.valueDelta)} lately, so it should resell well.`
      : player.valueDelta < -250_000
        ? ` Value is falling ${fmtMoney(Math.abs(player.valueDelta))}, so expect to lose on resale.`
        : "";

  return `${gain} for ${fmtMoney(price)}.${money}${trend}`;
}

function sellReason(
  player: Evaluated,
  cost: number,
  directSell: number | null,
): string {
  const floor =
    directSell === null
      ? ""
      : ` The machine would pay ${fmtMoney(directSell)} outright.`;

  if (player.onMarket) {
    const asking = player.askPrice !== null ? ` at ${fmtMoney(player.askPrice)}` : "";
    return `Already listed${asking}; nothing to do but wait for a bid.${floor}`;
  }
  // Only a certain absence is dead capital. A fitness doubt is a player who
  // will most likely be available again next week, and calling him dead capital
  // is how the engine came to recommend selling a fit 17M forward.
  if (player.availability === "out") {
    return `${player.unavailableReason} and not in the XI — ${fmtMoney(player.value)} of dead capital.${floor}`;
  }
  if (cost === 0) {
    const drift =
      player.valueDelta < -250_000
        ? ` Value down ${fmtMoney(Math.abs(player.valueDelta))}, so selling sooner is better.`
        : "";
    return `Never starts; frees ${fmtMoney(player.value)}.${drift}${floor}`;
  }
  return `Costs ${cost.toFixed(1)} pts/round to lose, so only sell if you need the cash.`;
}

function headline(
  buys: BuyCandidate[],
  sells: SellCandidate[],
  listings: OwnListing[],
  ctx: MarketContext,
): string {
  // A bid on one of our own listings is the only thing here with a clock on it.
  const closing = listings.find(
    (l) => l.topBid !== null && l.hoursToExpiry !== null && l.hoursToExpiry > 0,
  );
  if (closing) {
    return `${closing.name} has a ${fmtMoney(closing.topBid as number)} bid closing in ${formatHours(
      closing.hoursToExpiry as number,
    )}, against your ${fmtMoney(closing.price)} asking price.`;
  }

  const topBuy = buys.find((b) => b.affordable);
  if (topBuy) {
    const money =
      topBuy.weeklyReturn !== null && topBuy.weeklyReturn > 0
        ? `, worth about ${fmtMoney(topBuy.weeklyReturn)} a round in prize money`
        : "";
    return `Bid ${fmtMoney(topBuy.suggestedBid)} for ${topBuy.player.name} (asking ${fmtMoney(
      topBuy.price,
    )}): ${topBuy.upgrade.toFixed(1)} pts/round better than ${
      topBuy.replaces?.name ?? "an empty slot"
    }${money}.`;
  }
  const blocked = buys[0];
  const freeSell = sells.find((s) => s.cost === 0 && !s.alreadyListed);
  if (blocked && freeSell) {
    return `Nothing affordable in today's market. Selling ${freeSell.player.name} would free ${fmtMoney(
      freeSell.player.value,
    )} and bring ${blocked.player.name} within reach.`;
  }
  if (freeSell) {
    return `No worthwhile buys today. ${freeSell.player.name} is dead weight and could be sold for ${fmtMoney(freeSell.player.value)}.`;
  }
  return `No market action needed. ${fmtMoney(ctx.funds)} available.`;
}
