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
 *
 * Everything here is gated on `clause.date`, the instant the clause first
 * becomes payable. Ignoring it produced 55 "steal now" candidates and 15 "block
 * now" recommendations on a day when not one clause in the league could be paid
 * by anyone. The date is read from the payload and never derived: drafted
 * players get acquisition plus five days to the millisecond, bought players get
 * end of local day plus two, and inventing a formula to reconcile those would
 * be guessing about a decision that spends five million euros.
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
  /**
   * How the clause compares with Futmondo's own suggestion. Positive means the
   * owner has priced above what Futmondo considers fair, which is a clause a
   * rival is less likely to pay — and, from our side, one worth less to us.
   */
  overSuggested: number | null;
  affordable: boolean;
  /** ISO instant the clause becomes payable, when it is not payable yet. */
  availableFrom: string | null;
  /**
   * False when we have never read this player's clause date.
   *
   * An unknown date is treated as open, because the field only arrives with a
   * per-player summary and refusing to act without it would disable clause
   * advice for most of the league. That is the right default for *reporting* —
   * but this action spends money, so the uncertainty is said out loud rather
   * than hidden behind a confident recommendation.
   */
  clauseDateKnown: boolean;
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
  /** ISO instant the clause becomes payable, when it is not payable yet. */
  availableFrom: string | null;
  reason: string;
}

export interface ClauseReport {
  /** Steals that can be paid right now. */
  steals: StealCandidate[];
  /**
   * Steals whose clause has not opened yet. Planning information, not advice:
   * dropping them silently would hide a bargain unlocking in two days.
   */
  pendingSteals: StealCandidate[];
  exposed: ExposedPlayer[];
  /** Players we should lock, most urgent first. */
  toLock: ExposedPlayer[];
  /**
   * Set when nothing of ours is clausable yet, naming the date it changes, so
   * the block happens before the window opens rather than after.
   */
  windowNote: string | null;
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
  /**
   * Players we have successfully locked before, from `action_log`.
   *
   * This is a weaker signal than a reading and the difference matters: no
   * payload anywhere carries a `locked` field, so the engine cannot observe the
   * effect of its own write. A rival's clause payment or an admin recalculation
   * could clear a block without producing any evidence here, in which case we
   * would believe a player is protected who is not. It is still far better than
   * the alternative, which was re-locking the same five players every day
   * forever and never reaching the other ten. See BUG-4 / OPEN-7.
   */
  lockedPlayerIds?: ReadonlySet<string>;
  now?: Date;
}

/**
 * Efficiency threshold above which a player is considered a bargain at their
 * clause. Roughly "a point per round for every 8M paid" — tuned so that a
 * typical fairly-priced starter sits just below it.
 */
const BARGAIN_EFFICIENCY = 0.125;

/**
 * Whether a clause can be paid at the given instant.
 *
 * An unknown date is treated as payable: the field is absent from cheap roster
 * reads and only arrives with a per-player summary, so refusing to act without
 * it would silently disable clause advice for every player we have not yet
 * fetched a summary for.
 */
export function clauseOpen(
  clauseDate: string | null | undefined,
  now: Date,
): boolean {
  if (!clauseDate) return true;
  const opens = new Date(clauseDate).getTime();
  if (Number.isNaN(opens)) return true;
  return opens <= now.getTime();
}

export function runClauses(ctx: ClauseContext): ClauseReport {
  const now = ctx.now ?? new Date();
  const ceiling = ctx.funds + ctx.teamValue * ctx.rules.maxOfferTeamValueShare;

  const allSteals = findSteals(ctx, ceiling, now);
  const steals = allSteals.filter((s) => s.availableFrom === null);
  const pendingSteals = allSteals.filter((s) => s.availableFrom !== null);

  const exposed = findExposed(ctx, now);
  const toLock = exposed
    // A player nobody can take today is not exposed today. Locking him would
    // still be free, but it would also be indistinguishable from noise, and the
    // report would carry the same fifteen names every day forever.
    .filter((e) => e.availableFrom === null && !e.alreadyLocked && e.threats.length > 0)
    .sort((a, b) => b.efficiency - a.efficiency);

  return {
    steals,
    pendingSteals,
    exposed,
    toLock,
    windowNote: windowNote(exposed),
    headline: headline(steals, pendingSteals, toLock, ceiling),
  };
}

/**
 * When nothing of ours is takeable yet, say when that changes.
 *
 * Silence here would be the wrong kind of quiet: a squad that becomes clausable
 * on Sunday evening needs blocking before Sunday evening, and "no exposure"
 * reads as "nothing to plan".
 */
function windowNote(exposed: ExposedPlayer[]): string | null {
  const pending = exposed.filter((e) => e.availableFrom !== null);
  if (pending.length === 0 || pending.length < exposed.length) return null;

  const earliest = pending
    .map((e) => e.availableFrom as string)
    .sort()[0];
  return `None of your squad can be claused until ${formatWhen(earliest)}. Block before then, not after.`;
}

function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function findSteals(
  ctx: ClauseContext,
  ceiling: number,
  now: Date,
): StealCandidate[] {
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
    const availableFrom = clauseOpen(player.clauseDate, now)
      ? null
      : (player.clauseDate as string);
    const clauseDateKnown = player.clauseDate !== null;
    const overSuggested =
      player.suggestedClause !== null
        ? player.clausePrice - player.suggestedClause
        : null;

    candidates.push({
      player,
      clausePrice: player.clausePrice,
      ownerTeamId: player.ownerTeamId,
      ownerName: ctx.teamNames.get(player.ownerTeamId) ?? null,
      upgrade,
      replaces,
      efficiency,
      discount,
      overSuggested,
      affordable,
      availableFrom,
      clauseDateKnown,
      reason: stealReason({
        player,
        clausePrice: player.clausePrice,
        upgrade,
        replaces,
        discount,
        overSuggested,
        affordable,
        availableFrom,
        clauseDateKnown,
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

function findExposed(ctx: ClauseContext, now: Date): ExposedPlayer[] {
  const rivals = ctx.rivalFunds.filter((r) => r.teamId !== ctx.myTeamId);
  const locked = ctx.lockedPlayerIds ?? new Set<string>();

  return ctx.squad
    .filter((p) => p.clausePrice !== null && p.clausePrice > 0)
    .map((player) => {
      const clausePrice = player.clausePrice as number;
      const priceM = millions(clausePrice);
      const efficiency = priceM > 0 ? player.expectedPoints / priceM : 0;
      const availableFrom = clauseOpen(player.clauseDate, now)
        ? null
        : (player.clauseDate as string);

      const threats = rivals
        .filter((r) => r.estimatedFunds >= clausePrice)
        .map((r) => ({
          teamId: r.teamId,
          teamName: r.teamName,
          funds: r.estimatedFunds,
        }))
        .sort((a, b) => b.funds - a.funds);

      // No payload carries a `locked` flag, so our own successful writes are
      // the only record that a block exists. See ClauseContext.lockedPlayerIds.
      const alreadyLocked =
        player.clauseLocked === true || locked.has(player.playerId);

      return {
        player,
        clausePrice,
        efficiency,
        threats,
        alreadyLocked,
        availableFrom,
        reason: exposureReason({
          player,
          clausePrice,
          efficiency,
          threatCount: threats.length,
          alreadyLocked,
          availableFrom,
        }),
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
  overSuggested: number | null;
  affordable: boolean;
  availableFrom: string | null;
  clauseDateKnown: boolean;
  funds: number;
}): string {
  const {
    player,
    clausePrice,
    upgrade,
    replaces,
    discount,
    overSuggested,
    affordable,
    availableFrom,
    clauseDateKnown,
    funds,
  } = args;

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

  // Futmondo's own valuation of a fair clause is a free prior, and it is
  // usually well under what owners actually set.
  const suggested =
    overSuggested === null
      ? ""
      : overSuggested > 0
        ? ` ${fmtMoney(overSuggested)} above Futmondo's suggested clause.`
        : ` ${fmtMoney(-overSuggested)} below Futmondo's suggested clause.`;

  const when = availableFrom
    ? ` Not payable until ${formatWhen(availableFrom)}.`
    : clauseDateKnown
      ? ""
      : " His clause window has not been read yet, so check the date in Futmondo before paying.";

  return `${fmtMoney(clausePrice)} for ${versus}.${bargain}${suggested}${when}`;
}

function exposureReason(args: {
  player: Evaluated;
  clausePrice: number;
  efficiency: number;
  threatCount: number;
  alreadyLocked: boolean;
  availableFrom: string | null;
}): string {
  const { clausePrice, efficiency, threatCount, alreadyLocked, availableFrom } =
    args;

  if (alreadyLocked) return "Blocked, so safe.";
  if (availableFrom) {
    return `Clause ${fmtMoney(clausePrice)}, not payable by anyone until ${formatWhen(availableFrom)}.`;
  }
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
  pendingSteals: StealCandidate[],
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
  const pending = pendingSteals.find((s) => s.affordable);
  if (pending) {
    return `No clause is payable yet. ${pending.player.name} opens at ${formatWhen(
      pending.availableFrom as string,
    )} for ${fmtMoney(pending.clausePrice)}.`;
  }
  if (steals.length > 0) {
    return `Best clause target needs ${fmtMoney(steals[0].clausePrice)}, above your ${fmtMoney(ceiling)} ceiling.`;
  }
  return "No clause opportunities, and nothing of yours looks exposed.";
}

export { BARGAIN_EFFICIENCY };
