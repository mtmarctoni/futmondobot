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

/**
 * One of ours, scored exactly as a rival scores us.
 *
 * Attack and defence are the same arithmetic on the same two numbers; the only
 * difference is who profits. So this row carries the same `ratio`,
 * `daysToValue` and `opportunity` a `ClauseBet` does, from the same function,
 * and the list is ordered the way a rival's raid list would be. Ordering it by
 * points per million — what it used to do — answered a different question:
 * which of ours is good value, rather than which of ours is about to be
 * cheap.
 */
export interface ExposedPlayer {
  player: Evaluated;
  clausePrice: number;
  /** Market value / clause price. At or above 1 he is takeable under value. */
  ratio: number;
  /**
   * Days until his own value reaches his clause. Zero when it already has,
   * null when it is not on course to inside the horizon.
   */
  daysToValue: number | null;
  /** Which tier a rival looking at him would file him under. */
  tier: ExposureTier;
  /** 0-10, the score a rival computes when looking at him. */
  opportunity: number;
  /** Expected points per million of clause — high means attractive to steal. */
  efficiency: number;
  /** Rivals who could pay the clause today. */
  threats: { teamId: string; teamName: string | null; funds: number }[];
  alreadyLocked: boolean;
  /** ISO instant the clause becomes payable, when it is not payable yet. */
  availableFrom: string | null;
  /**
   * Whether to treat him as takeable today.
   *
   * Deliberately not "some rival is estimated to afford it". Rival funds are
   * reconstructed from the ledger and `money_events` is currently empty, so
   * prize money is missing from every estimate and funds are understated — in
   * the direction that makes our squad look safer than it is. A clause at or
   * under value is a reading; affordability is a guess, and a reading outranks
   * a guess. So a player the market has already overtaken counts as at risk
   * whatever the estimate says.
   */
  atRisk: boolean;
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
  /**
   * Our own squad in the order a rival would raid it: the same countdown, the
   * same score, pointed the other way. Nothing here advises a block.
   */
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

/**
 * How far ahead a value trend is worth extrapolating, in days.
 *
 * Four rounds. Past that the projection is arithmetic rather than
 * information: Lamine Yamal's value climbs 4.6M a week and would reach his
 * 177M clause in 102 days, which is not a plan.
 *
 * One constant does two jobs on purpose. It decides which clauses are close
 * enough to qualify as a forward bet, and it sets the slope down which the
 * opportunity score decays as the crossing recedes — so "is this worth
 * listing at all" and "how high does it rank" cannot drift apart, which is
 * what a separate ratio cutoff and a separate score let them do.
 */
const CROSSOVER_HORIZON_DAYS = 28;

/**
 * Minimum value movement per day to count as a trend rather than drift.
 *
 * About 250k a week — the bar this engine already used — but applied to a
 * rate instead of a raw delta. The raw delta was a misreading waiting to
 * happen: a third of this league has a snapshot window one or two days wide,
 * so "up 250k in the last week" was sometimes a single day's move wearing a
 * week's label, and a projection built on it crossed seven times too soon.
 */
const BET_TREND_MIN_PER_DAY = 35_000;

/**
 * Trend readings this far apart carry full weight; a shorter window keeps two
 * thirds of it. A one-day rate extrapolated across four weeks is the thinnest
 * evidence this engine produces and must not rank level with a week of daily
 * readings saying the same thing.
 *
 * Two thirds rather than something harsher because the damping must not
 * invert the ranking it is correcting. A thinly-evidenced crossing two days
 * out is still more urgent than a well-evidenced one a fortnight out, and a
 * discount steep enough to reverse that would be trading one wrong order for
 * another.
 */
const FULL_TREND_DAYS = 3;
const THIN_TREND_FLOOR = 0.5;

/** Halves of the opportunity score: how cheap it is, and whether he is worth having. */
const GAP_MAX = 5;
const WORTH_MAX = 5;

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

/**
 * The tiers, plus the one a rival's player can never be in: `priced` means the
 * clause sits above value with no crossing in view. Only our own squad gets
 * it, because a rival's player in that state is simply not listed.
 */
export type ExposureTier = ClauseTier | "priced";

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
  /**
   * Days until his value reaches his clause, at the rate it is moving now.
   * Zero when it already has, null when it is not on course to at all.
   *
   * This is the spine of the ranking below the golden line. Golden is not a
   * category so much as day zero of a countdown, and every other clause in
   * the league has a position on it.
   */
  daysToValue: number | null;
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

/**
 * The arithmetic both halves of this file run, on a rival's player and on our
 * own alike.
 *
 * Kept as one exported function rather than two similar blocks because the
 * moment attack and defence compute "how cheap is he" differently, one of the
 * two is wrong and nothing says which. A rival looking at our squad runs this;
 * so do we, looking at theirs.
 */
export interface ClauseMath {
  /** Market value / clause price. */
  ratio: number;
  /** Value minus clause, in euros. Negative while the clause is still ahead. */
  discount: number;
  /** Euros of value added per day, or null when no rate can be computed. */
  valuePerDay: number | null;
  /**
   * Days until value reaches the clause. Zero when it already has; null when
   * the value is flat, falling, or drifting too slowly to call a trend.
   */
  daysToValue: number | null;
  /** 0-10. Half how soon it is cheap, half whether he is worth having. */
  opportunity: number;
}

export function clauseMath(player: Evaluated, clausePrice: number): ClauseMath {
  const ratio = clausePrice > 0 ? player.value / clausePrice : 0;
  const discount = player.value - clausePrice;

  // A delta is not a rate until it is divided by the time it took, and the
  // time it took varies across this league by a factor of seven.
  const valuePerDay =
    player.valueTrendDays > 0
      ? player.valueDelta / player.valueTrendDays
      : null;

  const daysToValue =
    discount >= 0
      ? 0
      : valuePerDay === null || valuePerDay < BET_TREND_MIN_PER_DAY
        ? null
        : -discount / valuePerDay;

  return {
    ratio,
    discount,
    valuePerDay,
    daysToValue,
    opportunity: opportunityScore(player, daysToValue),
  };
}

/**
 * Two halves, five points each, because a clause opportunity is two questions
 * and the old score only asked one of them.
 *
 * `gap` is how soon the clause stops costing more than the player is worth.
 * `worth` is whether the player is worth owning at all — which the previous
 * score ignored entirely, and so ranked a 2.5M defender on 6.8 season points
 * above Pedri for the crime of appreciating quickly. Expected points already
 * carry availability, start probability and fixture, so an injured player
 * scores nothing here without a special case.
 *
 * Absolute points, not points per million: with 202M idle in a 210M budget
 * and no yield on cash, efficiency is the wrong regime — the same argument
 * `runMarket` already makes about ranking buys.
 */
function opportunityScore(player: Evaluated, daysToValue: number | null): number {
  const gap =
    daysToValue === null
      ? 0
      : daysToValue === 0
        ? // Already crossed. This is a reading off two published numbers, not
          // a projection, so no confidence discount applies to it.
          GAP_MAX
        : GAP_MAX *
          clamp(1 - daysToValue / CROSSOVER_HORIZON_DAYS, 0, 1) *
          trendConfidence(player);

  const worth = clamp(player.expectedPoints, 0, WORTH_MAX);
  return clamp(gap + worth, 0, 10);
}

/** How much to believe a rate measured across this few days. */
function trendConfidence(player: Evaluated): number {
  if (player.valueTrendDays <= 0) return 0;
  const settled = clamp(player.valueTrendDays / FULL_TREND_DAYS, 0, 1);
  return THIN_TREND_FLOOR + (1 - THIN_TREND_FLOOR) * settled;
}

/**
 * The countdown in words. Empty when there is nothing to count down to, so
 * callers can drop it from a sentence rather than print "in null days".
 */
function describeCountdown(daysToValue: number | null): string {
  if (daysToValue === null || daysToValue === 0) return "";
  if (daysToValue < 1.5) return "reaches it inside a day";
  return `reaches it in about ${Math.round(daysToValue)} days`;
}

/**
 * The value move with the window it was measured over, always both.
 *
 * "Up 1.8M in the last week" was printed for players whose window was a
 * single day. Naming the window is the whole fix: the reader can then see
 * that a big move over one reading is a big move over one reading.
 */
function describeTrend(player: Evaluated): string {
  if (player.valueTrendDays <= 0 || player.valueDelta === 0) return "";
  const window =
    player.valueTrendDays === 1 ? "a day" : `${player.valueTrendDays} days`;
  const direction = player.valueDelta > 0 ? "up" : "down";
  return `Value ${direction} ${fmtMoney(Math.abs(player.valueDelta))} over ${window} of readings`;
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
    const math = clauseMath(player, clausePrice);
    const isGolden = math.ratio >= GOLDEN_RATIO_MIN;

    // A clause the market has already overtaken is not a bet, so the trend
    // has no say in whether it qualifies — only in how it is explained.
    //
    // Below that line the question stops being "how cheap is it" and becomes
    // "how soon is it cheap". One test answers it: a clause whose value is
    // not on course to reach it inside the horizon is not an opportunity at
    // any ranking, and one that is belongs in the list however far off it
    // still looks today. This replaced a pair of cutoffs on the ratio and the
    // raw weekly delta, which were two proxies for this question that could
    // disagree with it and with each other.
    if (!isGolden) {
      if (math.daysToValue === null) continue;
      if (math.daysToValue > CROSSOVER_HORIZON_DAYS) continue;
    }

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
      ratio: math.ratio,
      discount: math.discount,
      daysToValue: math.daysToValue,
      opportunity: math.opportunity,
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
    // By opportunity, which is the countdown weighted by whether the player
    // is worth having when it runs out. Affordable first, as everywhere.
    trendBets: trendBets.sort((a, b) => {
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      if (b.opportunity !== a.opportunity) return b.opportunity - a.opportunity;
      return (a.daysToValue ?? Infinity) - (b.daysToValue ?? Infinity);
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
      ? `${describeTrend(player)} while the clause stayed where the owner left it, so the gap is still opening.`
      : "";

  const when = availableFrom
    ? `Not payable until ${formatWhen(availableFrom)}.`
    : clauseDateKnown
      ? ""
      : "Clause window has not been read yet — check the date in Futmondo before paying.";

  return [standing, trend, when].filter(Boolean).join(" ");
}

/**
 * Why a clause below the golden line is worth watching, led by the countdown.
 *
 * The countdown comes first because it is the decision. "0.83x ratio" tells a
 * reader where a player stands; "his value reaches the clause in about three
 * days" tells them when to act, which is the entire point of ranking these
 * ahead of the rivals who own them.
 */
function clauseBetReason(args: {
  player: Evaluated;
  clausePrice: number;
  ratio: number;
  discount: number;
  daysToValue: number | null;
  affordable: boolean;
  availableFrom: string | null;
  clauseDateKnown: boolean;
  funds: number;
}): string {
  const {
    player,
    clausePrice,
    discount,
    daysToValue,
    affordable,
    availableFrom,
    clauseDateKnown,
    funds,
  } = args;

  if (!affordable) {
    return `Clause is ${fmtMoney(clausePrice)}, beyond the ${fmtMoney(funds)} available.`;
  }

  const countdown = describeCountdown(daysToValue);
  const lead = countdown
    ? `Clause ${fmtMoney(clausePrice)} is ${fmtMoney(-discount)} above a ${fmtMoney(player.value)} value, and ${countdown} at the rate it is moving.`
    : `Clause ${fmtMoney(clausePrice)} against a ${fmtMoney(player.value)} value.`;

  const evidence = describeTrend(player);
  const trend = evidence ? `${evidence}.` : "";

  const when = availableFrom
    ? `Not payable until ${formatWhen(availableFrom)}.`
    : clauseDateKnown
      ? ""
      : "Clause window has not been read yet — check the date in Futmondo before paying.";

  return [
    lead,
    trend,
    "Paying now buys the crossing early; the bet pays only if value keeps rising.",
    when,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Our own squad, scored from the other side of the table.
 *
 * Same `clauseMath`, same countdown, same score — so the order this returns is
 * the order a rival running our own engine against us would raid in. That is
 * the only ordering that answers "which of mine goes first", and it is not the
 * one this list used to have.
 */
function findExposed(ctx: ClauseContext, now: Date): ExposedPlayer[] {
  const rivals = ctx.rivalFunds.filter((r) => r.teamId !== ctx.myTeamId);
  const locked = ctx.lockedPlayerIds ?? new Set<string>();

  return ctx.squad
    .filter((p) => p.clausePrice !== null && p.clausePrice > 0)
    .map((player) => {
      const clausePrice = player.clausePrice as number;
      const math = clauseMath(player, clausePrice);
      const priceM = millions(clausePrice);
      const efficiency = priceM > 0 ? player.expectedPoints / priceM : 0;
      const availableFrom = clauseOpen(player.clauseDate, now)
        ? null
        : (player.clauseDate as string);

      const tier: ExposureTier =
        math.ratio >= GOLDEN_RATIO_MIN
          ? "golden"
          : math.daysToValue !== null &&
              math.daysToValue <= CROSSOVER_HORIZON_DAYS
            ? "trend"
            : "priced";

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

      // See ExposedPlayer.atRisk: a reading beats an estimate, so a clause the
      // market has overtaken counts even where no rival is thought to afford
      // it. Every other case still defers to the funds estimate.
      const atRisk =
        availableFrom === null &&
        !alreadyLocked &&
        (threats.length > 0 || tier === "golden");

      return {
        player,
        clausePrice,
        ratio: math.ratio,
        daysToValue: math.daysToValue,
        tier,
        opportunity: math.opportunity,
        efficiency,
        threats,
        alreadyLocked,
        availableFrom,
        atRisk,
        reason: exposureReason({
          player,
          clausePrice,
          discount: math.discount,
          daysToValue: math.daysToValue,
          tier,
          threatCount: threats.length,
          alreadyLocked,
          availableFrom,
        }),
      };
    })
    .sort((a, b) => {
      // Nobody can take a player whose clause has not opened, however cheap
      // he looks, so those sort below everything that is takeable today.
      const aOpen = a.availableFrom === null;
      const bOpen = b.availableFrom === null;
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      if (b.opportunity !== a.opportunity) return b.opportunity - a.opportunity;
      return (a.daysToValue ?? Infinity) - (b.daysToValue ?? Infinity);
    });
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

/**
 * What a rival sees when they look at one of ours, in the same words we use
 * looking at theirs. Nothing here recommends a block: blocking costs 200
 * mondos a player a week and the budget is held, so this reports and stops.
 */
function exposureReason(args: {
  player: Evaluated;
  clausePrice: number;
  discount: number;
  daysToValue: number | null;
  tier: ExposureTier;
  threatCount: number;
  alreadyLocked: boolean;
  availableFrom: string | null;
}): string {
  const {
    player,
    clausePrice,
    discount,
    daysToValue,
    tier,
    threatCount,
    alreadyLocked,
    availableFrom,
  } = args;

  if (alreadyLocked) return "Blocked, so safe.";
  if (availableFrom) {
    return `Clause ${fmtMoney(clausePrice)}, not payable by anyone until ${formatWhen(availableFrom)}.`;
  }

  const takers =
    threatCount === 0
      ? "No rival is estimated to have that much, though funds are reconstructed from a ledger that is missing prize money, so treat that as the weakest claim here."
      : `${threatCount} rival${threatCount > 1 ? "s" : ""} could pay it.`;

  if (tier === "golden") {
    return [
      discount >= 0
        ? `Clause ${fmtMoney(clausePrice)} is ${fmtMoney(discount)} under his own ${fmtMoney(player.value)} value — anyone can take him for less than he is worth, today.`
        : `Clause ${fmtMoney(clausePrice)} is level with his ${fmtMoney(player.value)} value — he is takeable at market price, today.`,
      takers,
    ].join(" ");
  }

  if (tier === "trend") {
    const countdown = describeCountdown(daysToValue);
    return [
      `Clause ${fmtMoney(clausePrice)} against a ${fmtMoney(player.value)} value, and ${countdown} at the rate it is moving.`,
      describeTrend(player) ? `${describeTrend(player)}.` : "",
      takers,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return `Clause ${fmtMoney(clausePrice)}, ${fmtMoney(-discount)} above his ${fmtMoney(player.value)} value and not closing. ${takers}`;
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
  // A player nobody can take today is not exposed today. The unaffordable and
  // not-yet-open cases are surfaced in the full list; the headline names only
  // the immediately takeable risk, and as information, never as an instruction.
  // `exposed` is already sorted the way a rival would read it, so the first
  // at-risk row is the one to name.
  const topRisk = exposed.find((e) => e.atRisk);
  // The symmetric loss deserves a clause of its own when it is the same kind
  // of thing: one of ours the market has already overtaken is free value to
  // nine other people, and no amount of attacking changes that.
  const crossed =
    topRisk && topRisk.tier === "golden"
      ? ` ${topRisk.player.name} is in the same position on your side, at ${fmtMoney(topRisk.clausePrice)} against a ${fmtMoney(topRisk.player.value)} value.`
      : "";

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
    )}, ${gap}. Free value while the owner leaves the clause where it is.${crossed}`;
  }

  const topSteal = steals.find((s) => s.affordable);

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

export { CROSSOVER_HORIZON_DAYS, GOLDEN_RATIO_MIN };
