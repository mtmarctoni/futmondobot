/**
 * Market decisions.
 *
 * Two things earn money here, and they are not the same thing:
 *
 *   - Points. Prize money is 60.000€ per point, so a player who scores more is
 *     worth paying for even at a poor price per million.
 *   - Value drift. Futmondo revalues players daily. Buying a rising player and
 *     selling a falling one compounds, and it is invisible without history —
 *     which is exactly what the snapshot table provides.
 *
 * Recommendations therefore compare a candidate against the player they would
 * actually replace, rather than ranking the market in isolation. A brilliant
 * forward is not a buy if your forwards are already better.
 */
import type { FutmondoRole } from "../futmondo/types";
import { fmtMoney, millions, type Evaluated, type LeagueRules } from "./types";

export interface BuyCandidate {
  player: Evaluated;
  /** What the purchase would cost: asking price, or value if none quoted. */
  price: number;
  /** Expected points gained per round by replacing the weakest starter. */
  upgrade: number;
  /** The player they would displace, when they would displace anyone. */
  replaces: Evaluated | null;
  /** Prize money per round the upgrade is worth, at the league's rate. */
  weeklyReturn: number;
  affordable: boolean;
  reason: string;
}

export interface SellCandidate {
  player: Evaluated;
  /** Expected points lost per round by selling. Zero for a spare part. */
  cost: number;
  reason: string;
}

export interface MarketReport {
  buys: BuyCandidate[];
  sells: SellCandidate[];
  funds: number;
  /** Most Futmondo will let us offer for one player. */
  maxOffer: number;
  headline: string;
}

export interface MarketContext {
  /** Players listed today, machine-owned or from rivals. */
  listings: { player: Evaluated; price: number }[];
  squad: Evaluated[];
  /** Who we would field right now, so a buy is judged against real starters. */
  starterIds: Set<string>;
  funds: number;
  teamValue: number;
  rules: LeagueRules;
  /** From /1/userteam/information when Futmondo reports it. */
  reportedMaxBid?: number;
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

export function runMarket(ctx: MarketContext): MarketReport {
  const ceiling = maxOffer(ctx);

  const buys: BuyCandidate[] = ctx.listings
    .map(({ player, price }) => {
      const replaces = weakestStarter(ctx.squad, ctx.starterIds, player.role);
      const upgrade = replaces
        ? player.expectedPoints - replaces.expectedPoints
        : // No starter in that role at all: the whole projection is upside,
          // because the alternative is an empty slot scoring nothing.
          player.expectedPoints;
      const weeklyReturn = upgrade * ctx.rules.pricePerPoint;
      const affordable = price <= ceiling && price <= ctx.funds;

      return {
        player,
        price,
        upgrade,
        replaces,
        weeklyReturn,
        affordable,
        reason: buyReason({ player, price, upgrade, replaces, affordable, ceiling, funds: ctx.funds }),
      };
    })
    // Only surface genuine improvements. Ranking the whole market produces
    // confident-looking noise.
    .filter((c) => c.upgrade > 0)
    .sort((a, b) => {
      // Affordable upgrades first, then by points gained per million spent.
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      const aEff = a.price > 0 ? a.upgrade / millions(a.price) : a.upgrade;
      const bEff = b.price > 0 ? b.upgrade / millions(b.price) : b.upgrade;
      return bEff - aEff;
    });

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
      return { player, cost, reason: sellReason(player, cost) };
    })
    .sort((a, b) => {
      // Prefer selling players who cost us nothing and whose value is falling.
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.player.valueDelta - b.player.valueDelta;
    });

  return {
    buys,
    sells,
    funds: ctx.funds,
    maxOffer: ceiling,
    headline: headline(buys, sells, ctx),
  };
}

function buyReason(args: {
  player: Evaluated;
  price: number;
  upgrade: number;
  replaces: Evaluated | null;
  affordable: boolean;
  ceiling: number;
  funds: number;
}): string {
  const { player, price, upgrade, replaces, affordable, ceiling, funds } = args;

  if (!affordable) {
    const blocker = price > ceiling
      ? `over the ${fmtMoney(ceiling)} offer ceiling`
      : `more than the ${fmtMoney(funds)} available`;
    return `${fmtMoney(price)} is ${blocker}.`;
  }

  const gain = replaces
    ? `+${upgrade.toFixed(1)} pts/round over ${replaces.name}`
    : `+${upgrade.toFixed(1)} pts/round into an empty ${player.role} slot`;

  const trend =
    player.valueDelta > 250_000
      ? ` Value up ${fmtMoney(player.valueDelta)} lately, so it should resell well.`
      : player.valueDelta < -250_000
        ? ` Value is falling ${fmtMoney(Math.abs(player.valueDelta))}, so expect to lose on resale.`
        : "";

  return `${gain} for ${fmtMoney(price)}.${trend}`;
}

function sellReason(player: Evaluated, cost: number): string {
  if (player.unavailableReason) {
    return `${player.unavailableReason} and not in the XI — ${fmtMoney(player.value)} of dead capital.`;
  }
  if (cost === 0) {
    const drift =
      player.valueDelta < -250_000
        ? ` Value down ${fmtMoney(Math.abs(player.valueDelta))}, so selling sooner is better.`
        : "";
    return `Never starts; frees ${fmtMoney(player.value)}.${drift}`;
  }
  return `Costs ${cost.toFixed(1)} pts/round to lose, so only sell if you need the cash.`;
}

function headline(
  buys: BuyCandidate[],
  sells: SellCandidate[],
  ctx: MarketContext,
): string {
  const topBuy = buys.find((b) => b.affordable);
  if (topBuy) {
    return `Buy ${topBuy.player.name} for ${fmtMoney(topBuy.price)}: ${topBuy.upgrade.toFixed(1)} pts/round better than ${
      topBuy.replaces?.name ?? "an empty slot"
    }, worth about ${fmtMoney(topBuy.weeklyReturn)} a round in prize money.`;
  }
  const blocked = buys[0];
  const freeSell = sells.find((s) => s.cost === 0);
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
