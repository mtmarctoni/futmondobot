/**
 * Clauses — attack and defence.
 *
 * This league runs manual clauses with no weekly cap and unlimited blocking,
 * which makes clauses the sharpest tool available in both directions:
 *
 *   Attack.  A rival's player can be taken outright for their clause price,
 *            no negotiation and no bidding war. When that price is below what
 *            the player is worth in points, it is simply free value.
 *   Defence. Blocking a player costs nothing and removes them from every
 *            rival's list. Not using it is leaving the door open.
 *
 * Rival funds matter for both: a rival who cannot afford your best player is
 * not a threat, and a target owned by a rival is only worth chasing if we can
 * pay. Funds are estimated from the ledger — see getRivalFunds for why that is
 * an estimate rather than a reading.
 */
import type { RivalFunds } from "../db/repo";
import { fmtMoney, millions, type Evaluated, type LeagueRules } from "./types";

export interface StealCandidate {
  player: Evaluated;
  clausePrice: number;
  ownerTeamId: string;
  ownerName: string | null;
  /** Expected points gained per round over the starter they would replace. */
  upgrade: number;
  replaces: Evaluated | null;
  /** Expected points per million of clause price. */
  efficiency: number;
  /** How much cheaper the clause is than the player's own market value. */
  discount: number;
  affordable: boolean;
  reason: string;
}

export interface ExposedPlayer {
  player: Evaluated;
  clausePrice: number;
  /** Expected points per million of clause — high means attractive to steal. */
  efficiency: number;
  /** Rivals who could pay the clause today. */
  threats: { teamId: string; teamName: string | null; funds: number }[];
  alreadyLocked: boolean;
  reason: string;
}

export interface ClauseReport {
  steals: StealCandidate[];
  exposed: ExposedPlayer[];
  /** Players we should lock, most urgent first. */
  toLock: ExposedPlayer[];
  headline: string;
}

export interface ClauseContext {
  /** Every player we know about, with latest clause price and ownership. */
  allPlayers: Evaluated[];
  squad: Evaluated[];
  starterIds: Set<string>;
  myTeamId: string;
  funds: number;
  teamValue: number;
  rules: LeagueRules;
  rivalFunds: RivalFunds[];
  teamNames: Map<string, string | null>;
}

/**
 * Efficiency threshold above which a player is considered a bargain at their
 * clause. Roughly "a point per round for every 8M paid" — tuned so that a
 * typical fairly-priced starter sits just below it.
 */
const BARGAIN_EFFICIENCY = 0.125;

export function runClauses(ctx: ClauseContext): ClauseReport {
  const ceiling = ctx.funds + ctx.teamValue * ctx.rules.maxOfferTeamValueShare;

  const steals = findSteals(ctx, ceiling);
  const exposed = findExposed(ctx);
  const toLock = exposed
    .filter((e) => !e.alreadyLocked && e.threats.length > 0)
    .sort((a, b) => b.efficiency - a.efficiency);

  return {
    steals,
    exposed,
    toLock,
    headline: headline(steals, toLock, ceiling),
  };
}

function findSteals(ctx: ClauseContext, ceiling: number): StealCandidate[] {
  const myStartersByRole = new Map<string, Evaluated[]>();
  for (const p of ctx.squad) {
    if (!ctx.starterIds.has(p.playerId)) continue;
    const list = myStartersByRole.get(p.role) ?? [];
    list.push(p);
    myStartersByRole.set(p.role, list);
  }

  const candidates: StealCandidate[] = [];

  for (const player of ctx.allPlayers) {
    // Only a rival's player, with a known clause, that is not blocked.
    if (!player.ownerTeamId || player.ownerTeamId === ctx.myTeamId) continue;
    if (player.clauseLocked === true) continue;
    if (player.clausePrice === null || player.clausePrice <= 0) continue;

    const starters = (myStartersByRole.get(player.role) ?? []).sort(
      (a, b) => a.expectedPoints - b.expectedPoints,
    );
    const replaces = starters[0] ?? null;
    const upgrade = replaces
      ? player.expectedPoints - replaces.expectedPoints
      : player.expectedPoints;

    if (upgrade <= 0) continue;

    const priceM = millions(player.clausePrice);
    const efficiency = priceM > 0 ? player.expectedPoints / priceM : 0;
    const discount = player.value - player.clausePrice;
    const affordable = player.clausePrice <= Math.min(ceiling, ctx.funds);

    candidates.push({
      player,
      clausePrice: player.clausePrice,
      ownerTeamId: player.ownerTeamId,
      ownerName: ctx.teamNames.get(player.ownerTeamId) ?? null,
      upgrade,
      replaces,
      efficiency,
      discount,
      affordable,
      reason: stealReason({
        player,
        clausePrice: player.clausePrice,
        upgrade,
        replaces,
        discount,
        affordable,
        ceiling,
        funds: ctx.funds,
      }),
    });
  }

  return candidates.sort((a, b) => {
    if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
    // Among affordable steals, the biggest lineup upgrade per euro wins.
    const aScore = a.upgrade * a.efficiency;
    const bScore = b.upgrade * b.efficiency;
    return bScore - aScore;
  });
}

function findExposed(ctx: ClauseContext): ExposedPlayer[] {
  const rivals = ctx.rivalFunds.filter((r) => r.teamId !== ctx.myTeamId);

  return ctx.squad
    .filter((p) => p.clausePrice !== null && p.clausePrice > 0)
    .map((player) => {
      const clausePrice = player.clausePrice as number;
      const priceM = millions(clausePrice);
      const efficiency = priceM > 0 ? player.expectedPoints / priceM : 0;

      const threats = rivals
        .filter((r) => r.estimatedFunds >= clausePrice)
        .map((r) => ({
          teamId: r.teamId,
          teamName: r.teamName,
          funds: r.estimatedFunds,
        }))
        .sort((a, b) => b.funds - a.funds);

      return {
        player,
        clausePrice,
        efficiency,
        threats,
        alreadyLocked: player.clauseLocked === true,
        reason: exposureReason(player, clausePrice, efficiency, threats.length),
      };
    })
    .sort((a, b) => b.efficiency - a.efficiency);
}

function stealReason(args: {
  player: Evaluated;
  clausePrice: number;
  upgrade: number;
  replaces: Evaluated | null;
  discount: number;
  affordable: boolean;
  ceiling: number;
  funds: number;
}): string {
  const { player, clausePrice, upgrade, replaces, discount, affordable, funds } = args;

  if (!affordable) {
    return `Clause is ${fmtMoney(clausePrice)}, beyond the ${fmtMoney(funds)} available.`;
  }

  const versus = replaces
    ? `${upgrade.toFixed(1)} pts/round better than ${replaces.name}`
    : `fills an empty ${player.role} slot at ${player.expectedPoints.toFixed(1)} pts/round`;

  const bargain =
    discount > 0
      ? ` Clause sits ${fmtMoney(discount)} under their own market value.`
      : "";

  return `${fmtMoney(clausePrice)} for ${versus}.${bargain}`;
}

function exposureReason(
  player: Evaluated,
  clausePrice: number,
  efficiency: number,
  threatCount: number,
): string {
  if (player.clauseLocked === true) return "Blocked, so safe.";
  if (threatCount === 0) {
    return `Clause ${fmtMoney(clausePrice)} — no rival is estimated to have that much.`;
  }
  const attractiveness =
    efficiency >= BARGAIN_EFFICIENCY
      ? "a bargain at that price"
      : "fairly priced";
  return `Clause ${fmtMoney(clausePrice)}, ${attractiveness}; ${threatCount} rival${
    threatCount > 1 ? "s" : ""
  } could pay it.`;
}

function headline(
  steals: StealCandidate[],
  toLock: ExposedPlayer[],
  ceiling: number,
): string {
  const topSteal = steals.find((s) => s.affordable);
  const topRisk = toLock[0];

  if (topSteal && topRisk) {
    return `Take ${topSteal.player.name} for ${fmtMoney(topSteal.clausePrice)} (+${topSteal.upgrade.toFixed(
      1,
    )} pts/round), and block ${topRisk.player.name} before someone does the same to you.`;
  }
  if (topSteal) {
    return `Take ${topSteal.player.name} for ${fmtMoney(topSteal.clausePrice)}: ${topSteal.upgrade.toFixed(
      1,
    )} pts/round better than your weakest starter in that role.`;
  }
  if (topRisk) {
    return `No steal worth making. Block ${topRisk.player.name} — ${topRisk.reason.toLowerCase()}`;
  }
  if (steals.length > 0) {
    return `Best clause target needs ${fmtMoney(steals[0].clausePrice)}, above your ${fmtMoney(ceiling)} ceiling.`;
  }
  return "No clause opportunities, and nothing of yours looks exposed.";
}

export { BARGAIN_EFFICIENCY };
