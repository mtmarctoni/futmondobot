/**
 * Clauses — attack and defence.
 *
 * This league runs manual clauses with no weekly cap. Blocking used to be free
 * and a full defence half ran off that assumption; blocking now costs 200
 * mondos a player a week, so defence is reported as information and the budget
 * is held, not spent:
 *
 *   Attack.  A rival's player can be taken outright for their clause price,
 *            no negotiation and no bidding war. When that price is below what
 *            the player is worth in points, it is simply free value — and when
 *            it is below what he is worth in euros, it is free value that needs
 *            no judgement at all. That second case is the golden tier, kept in
 *            its own list so it is never read as one more speculative bet.
 *   Defence. Who could take your players today is surfaced on the clauses page
 *            and in today's headline, but no block is recommended, automated or
 *            offered as a button. Every block is 200 mondos a week and nothing
 *            is spent before the end of the season.
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
import { clamp, fmtMoney, millions, type Evaluated, type LeagueRules } from "./types";

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
  /**
   * Rival players whose clause the market has already overtaken: the clause
   * costs at most a hair more than the player is worth today. Nothing has to
   * be believed about the future for these to be worth paying, which is why
   * they are their own list rather than the top of `trendBets`. Sorted by how
   * far the clause lags value, affordable first.
   */
  golden: ClauseBet[];
  /**
   * Rival players whose value is rising while their clause stays pinned, and
   * whose clause is still above value. A bet on forward value, not a current
   * discount — see the threshold block. Sorted by opportunity score
   * descending, affordable first. Never contains a golden clause.
   */
  trendBets: ClauseBet[];
  /**
   * Set when none of our squad is clausable yet, naming the date it changes.
   * Informational: blocking costs 200 mondos a player a week, so nothing is
   * advised or pending from this state.
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
   * Players we have ever locked, from `action_log`.
   *
   * The engine no longer writes locks — blocking costs 200 mondos a player a
   * week — so this is history for the "blocked" badge on the clauses page. It
   * is a weaker signal than a reading and the difference matters: no payload
   * anywhere carries a `locked` field, so the engine could never observe the
   * effect of its own write. A rival's clause payment or an admin
   * recalculation could clear a block without producing any evidence here, in
   * which case we would believe a player is protected who is not. See BUG-4 /
   * OPEN-7.
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

// ---------------------------------------------------------------------------
// Clauses worth paying, in two tiers that must not be confused with each other.
//
// The first version of this feature called every cheap-looking clause a
// discount. It was wrong: most "underpriced" candidates were a clause 20-80%
// ABOVE value, ranked as if they were free money, with a one-tap money button
// on them. The correction was to reframe all of them as bets on a rising value
// trend, which was honest but over-corrected — it put the cases where nothing
// has to be believed about the future in the same list, under the same
// hedged wording, as the ones where everything does.
//
// So there are two tiers, and the difference between them is whether the
// payoff needs the future:
//
//   golden  The market has already overtaken the clause. Owners set a clause
//           once and rarely revisit it, so a player whose value has run up
//           can end up clausable at or below what he is worth. Paying it is
//           an arbitrage that is complete on the day. Live data on 2026-09-14
//           had four of these in 174 owned players — value/clause of 1.11 for
//           Unai López, 1.06 Iván Martín, 0.99 Olasagasti, 0.98 Luismi Cruz —
//           and then a cliff to 0.85. A small nameable set, not a gradient.
//
//   trend   The clause is still above value, but value is climbing towards
//           it. Paying it buys forward growth: the payoff is future value and
//           requires the trend to hold. This is a bet and is stated as one,
//           never as a discount.
// ---------------------------------------------------------------------------

/** Minimum 7-day value rise (euros) to count as a rising trend. */
const BET_TREND_MIN_DELTA = 250_000;
/**
 * Loosest value/clause ratio worth betting on. Clause 43% or more above value
 * is an overpay no trend justifies.
 */
const BET_RATIO_MIN = 0.7;
/**
 * Tightest value/clause ratio that still counts as buying at market price, so
 * the clause is free value rather than a bet on the trend.
 *
 * 0.95 admits a clause up to ~5.3% over value. That is deliberately a shade
 * looser than "at or below value": the two clearest cases in the live league,
 * Olasagasti and Luismi Cruz, sit 0.8% and 2.2% over, and calling those a
 * forward bet while their value climbs 4-5M a week is a distinction without a
 * difference. The next candidate below them is at 0.85, so the band does not
 * leak into ordinary overpriced clauses.
 */
const GOLDEN_RATIO_MIN = 0.95;

/**
 * Which of the two tiers a clause opportunity belongs to. Kept on the row
 * rather than implied by which array it came from, so a consumer that merges
 * the lists cannot lose the distinction between free value and a bet.
 */
export type ClauseTier = "golden" | "trend";

export interface ClauseBet {
  tier: ClauseTier;
  player: Evaluated;
  clausePrice: number;
  ownerTeamId: string;
  ownerName: string | null;
  /** market value / clause price. */
  ratio: number;
  /** Market value minus clause price, in euros. Negative when clause > value. */
  discount: number;
  /** 0-10 composite opportunity score. */
  opportunity: number;
  affordable: boolean;
  /** ISO instant the clause becomes payable, when it is not payable yet. */
  availableFrom: string | null;
  clauseDateKnown: boolean;
  reason: string;
}

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

  const { golden, trendBets } = findClauseOpportunities(ctx, ceiling, now);

  return {
    steals,
    pendingSteals,
    exposed,
    golden,
    trendBets,
    windowNote: windowNote(exposed),
    headline: headline(golden, steals, pendingSteals, exposed, ceiling),
  };
}

/**
 * When none of ours is takeable yet, say when that changes.
 *
 * This is information only: blocking is no longer advised or automated, so the
 * sentence simply names the date the window opens.
 */
function windowNote(exposed: ExposedPlayer[]): string | null {
  const pending = exposed.filter((e) => e.availableFrom !== null);
  if (pending.length === 0 || pending.length < exposed.length) return null;

  const earliest = pending
    .map((e) => e.availableFrom as string)
    .sort()[0];
  return `None of your squad can be claused until ${formatWhen(earliest)}.`;
}

function formatWhen(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  return `${iso.replace("T", " ").slice(0, 16)}Z`;
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

/**
 * Rival players worth paying a clause for on price alone, split into the two
 * tiers above. Deliberately distinct from findSteals, which asks whether a
 * player improves the XI: free value is worth taking from a squad filler, and
 * the golden tier has no points test at all.
 *
 * A player lands in exactly one list. Rendering him under both "free value"
 * and "bet on the trend" would be two different claims about one clause.
 */
function findClauseOpportunities(
  ctx: ClauseContext,
  ceiling: number,
  now: Date,
): { golden: ClauseBet[]; trendBets: ClauseBet[] } {
  const golden: ClauseBet[] = [];
  const trendBets: ClauseBet[] = [];

  for (const player of ctx.allPlayers) {
    if (!player.ownerTeamId || player.ownerTeamId === ctx.myTeamId) continue;
    if (player.clauseLocked === true) continue;
    if (player.clausePrice === null || player.clausePrice <= 0) continue;
    if (player.value <= 0) continue;

    const clausePrice = player.clausePrice;
    const ratio = player.value / clausePrice;
    const isGolden = ratio >= GOLDEN_RATIO_MIN;

    // The trend minimum exists to stop noise being sold as a bet. A clause the
    // market has already overtaken is not a bet, so the trend has no say in
    // whether it qualifies — only in how it is explained.
    if (!isGolden) {
      if (player.valueDelta <= BET_TREND_MIN_DELTA) continue;
      if (ratio < BET_RATIO_MIN) continue;
    }

    const discount = player.value - clausePrice;
    const affordable = clausePrice <= Math.min(ceiling, ctx.funds);
    const availableFrom = clauseOpen(player.clauseDate, now)
      ? null
      : (player.clauseDate as string);
    const clauseDateKnown = player.clauseDate !== null;
    const shared = {
      player,
      clausePrice,
      ownerTeamId: player.ownerTeamId,
      ownerName: ctx.teamNames.get(player.ownerTeamId) ?? null,
      ratio,
      discount,
      opportunity: clauseBetOpportunity(ratio, player.valueDelta),
      affordable,
      availableFrom,
      clauseDateKnown,
    };

    if (isGolden) {
      golden.push({
        ...shared,
        tier: "golden",
        reason: goldenReason({ ...shared, funds: ctx.funds }),
      });
    } else {
      trendBets.push({
        ...shared,
        tier: "trend",
        reason: clauseBetReason({ ...shared, funds: ctx.funds }),
      });
    }
  }

  return {
    // How far the clause lags value, not the trend: the gap is the whole
    // point of this tier, and ranking by trend would put a player who is
    // barely level above one already under value.
    golden: golden.sort((a, b) => {
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      return b.discount - a.discount;
    }),
    trendBets: trendBets.sort((a, b) => {
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      return b.opportunity - a.opportunity;
    }),
  };
}

/**
 * Why a golden clause is worth paying, said without the hedging a forward bet
 * needs — and without overclaiming when the clause is a shade over value
 * rather than under it. The distinction is a sentence apart in the output and
 * millions apart in the decision.
 */
function goldenReason(args: {
  player: Evaluated;
  clausePrice: number;
  discount: number;
  affordable: boolean;
  availableFrom: string | null;
  clauseDateKnown: boolean;
  funds: number;
}): string {
  const {
    player,
    clausePrice,
    discount,
    affordable,
    availableFrom,
    clauseDateKnown,
    funds,
  } = args;

  if (!affordable) {
    return `Clause is ${fmtMoney(clausePrice)}, beyond the ${fmtMoney(funds)} available.`;
  }

  const standing =
    discount >= 0
      ? `Clause ${fmtMoney(clausePrice)} is ${fmtMoney(discount)} under his own market value of ${fmtMoney(player.value)} — you pay less than he is worth today.`
      : `Clause ${fmtMoney(clausePrice)} sits ${fmtMoney(-discount)} over a ${fmtMoney(player.value)} value — market price, not a premium.`;

  // Supporting evidence, not the payoff: the gap above is already banked.
  const trend =
    player.valueDelta > 0
      ? `Value up ${fmtMoney(player.valueDelta)} in the last week while the clause stayed where the owner left it, so the gap is still opening.`
      : "";

  const when = availableFrom
    ? `Not payable until ${formatWhen(availableFrom)}.`
    : clauseDateKnown
      ? ""
      : "Clause window has not been read yet — check the date in Futmondo before paying.";

  return [standing, trend, when].filter(Boolean).join(" ");
}

function clauseBetOpportunity(ratio: number, valueDelta: number): number {
  // Mostly the trend: how much value is adding every week. The ratio adds up
  // to three points for being at or below current value, less the further the
  // clause sits above it.
  const trendScore = clamp(valueDelta / 1_000_000, 0, 4);
  const ratioScore = ratio >= 1 ? 3 : clamp((ratio - 0.6) * 7.5, 0, 3);
  return clamp(trendScore + ratioScore, 0, 10);
}

function clauseBetReason(args: {
  player: Evaluated;
  clausePrice: number;
  ratio: number;
  discount: number;
  affordable: boolean;
  availableFrom: string | null;
  clauseDateKnown: boolean;
  funds: number;
}): string {
  const {
    player,
    clausePrice,
    ratio,
    discount,
    affordable,
    availableFrom,
    clauseDateKnown,
    funds,
  } = args;

  if (!affordable) {
    return `Clause is ${fmtMoney(clausePrice)}, beyond the ${fmtMoney(funds)} available.`;
  }

  const gap =
    discount >= 0
      ? `It already sits ${fmtMoney(discount)} under today's value. `
      : `It is ${fmtMoney(-discount)} above today's value — the payoff is future value, not today's. `;

  const when = availableFrom
    ? `Not payable until ${formatWhen(availableFrom)}. `
    : clauseDateKnown
      ? ""
      : "Clause window has not been read yet — check the date in Futmondo before paying. ";

  return [
    `${ratio.toFixed(1)}x ratio — clause ${fmtMoney(clausePrice)} vs value ${fmtMoney(player.value)}.`,
    gap,
    `Value up ${fmtMoney(player.valueDelta)} in the last week; if the trend holds, this clause is the cheap way in before the owner raises it. Bet pays only if value keeps rising.`,
    when.trim(),
  ]
    .filter(Boolean)
    .join(" ");
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
  golden: ClauseBet[],
  steals: StealCandidate[],
  pendingSteals: StealCandidate[],
  exposed: ExposedPlayer[],
  ceiling: number,
): string {
  // A clause the market has already overtaken leads, because it is the one
  // clause decision that needs nothing believed about the future and the one
  // that disappears the moment the owner notices. Pending and unaffordable
  // ones are left to the full list: neither is something to do today.
  const topGolden = golden.find(
    (g) => g.affordable && g.availableFrom === null,
  );
  if (topGolden) {
    const gap =
      topGolden.discount >= 0
        ? `${fmtMoney(topGolden.discount)} under his ${fmtMoney(topGolden.player.value)} value`
        : `level with his ${fmtMoney(topGolden.player.value)} value`;
    return `${topGolden.player.name} is clausable at ${fmtMoney(
      topGolden.clausePrice,
    )}, ${gap}. Free value while the owner leaves the clause where it is.`;
  }

  const topSteal = steals.find((s) => s.affordable);
  // A player nobody can take today is not exposed today. The unaffordable and
  // not-yet-open cases are surfaced in the full list; the headline names only
  // the immediately takeable risk, and as information, never as an instruction.
  const topRisk = exposed.find(
    (e) => e.availableFrom === null && !e.alreadyLocked && e.threats.length > 0,
  );

  if (topSteal && topRisk) {
    return `Take ${topSteal.player.name} for ${fmtMoney(topSteal.clausePrice)} (+${topSteal.upgrade.toFixed(
      1,
    )} pts/round). ${topRisk.player.name} is exposed at ${fmtMoney(
      topRisk.clausePrice,
    )} — blocking costs 200 mondos a player a week, so the budget is held, not spent.`;
  }
  if (topSteal) {
    return `Take ${topSteal.player.name} for ${fmtMoney(topSteal.clausePrice)}: ${topSteal.upgrade.toFixed(
      1,
    )} pts/round better than your weakest starter in that role.`;
  }
  if (topRisk) {
    return `No steal worth making. ${topRisk.player.name} is exposed at ${fmtMoney(
      topRisk.clausePrice,
    )}; blocking costs 200 mondos a week and nothing is spent before the end of the season.`;
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

export { BARGAIN_EFFICIENCY, GOLDEN_RATIO_MIN };
