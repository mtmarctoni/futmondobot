/**
 * The one screen worth reading: what to do right now, in order.
 *
 * Ordering is by consequence, not by category. A lineup with an injured
 * starter in it costs points this week and outranks any transfer; a listing
 * bid with a clock on it outranks a marginal buy; a buy can wait. Anything
 * that needs no action is deliberately not listed.
 */
import type { ClauseReport, ClauseBet, StealCandidate } from "./clauses";
import type { DepartedPlayer } from "./departed";
import type { LineupChange, LineupPick } from "./lineup";
import type { MarketReport, OwnListing } from "./market";
import { fmtMoney, paysForPoints, type LeagueRules } from "./types";

export type ActionKind =
  | "set_lineup"
  | "steal_clause"
  | "clause_bet"
  | "buy"
  | "sell"
  /**
   * One of our own listings needs a decision: a bid standing against it, or an
   * imminent expiry with nothing on it. Never automated and never given a
   * button — accepting or cancelling moves money, and whether a machine-market
   * listing even needs acceptance is not established (OPEN-4).
   */
  | "listing"
  | "info";

export interface Action {
  id: string;
  kind: ActionKind;
  /** What to actually offer, where that differs from the asking price. */
  bid?: number;
  /** Sort key. Higher acts sooner. */
  weight: number;
  urgency: "now" | "today" | "whenever";
  title: string;
  detail: string;
  /** Points per round at stake, where the action has a points effect. */
  pointsAtStake?: number;
  /** Euros involved, where the action costs or frees money. */
  money?: number;
  playerId?: string;
  playerName?: string;
  /** Set when the app can carry the action out itself. */
  automatable?: boolean;
}

export interface TodayReport {
  actions: Action[];
  headline: string;
  deadline: string | null;
  hoursToDeadline: number | null;
  /** Points per round currently being left on the table. */
  pointsAvailable: number;
}

export interface TodayInput {
  lineup: LineupPick;
  lineupChanges: LineupChange[];
  /** True when the app already applied the lineup. */
  lineupApplied: boolean;
  market: MarketReport;
  clauses: ClauseReport;
  /** Our players who have left the competition. */
  departed: DepartedPlayer[];
  deadline: string | null;
  rules: LeagueRules;
  now?: Date;
}

export function buildToday(input: TodayInput): TodayReport {
  const now = input.now ?? new Date();
  const hoursToDeadline = input.deadline
    ? (new Date(input.deadline).getTime() - now.getTime()) / 3_600_000
    : null;

  const actions: Action[] = [];

  actions.push(...lineupActions(input, hoursToDeadline));
  actions.push(...departureActions(input.departed));
  // A bid on one of our own listings has a clock on it and outranks anything
  // that will still be there tomorrow.
  actions.push(...listingActions(input.market.listings));
  actions.push(...clauseWindowActions(input.clauses));
  actions.push(...stealActions(input.clauses.steals, input.rules));
  actions.push(...clauseBetActions(input.clauses.trendBets));
  // Departures already have their own action, and a duplicate sell for the
  // same player reads as two separate problems.
  actions.push(
    ...marketActions(
      input.market,
      new Set(input.departed.map((p) => p.playerId)),
    ),
  );

  actions.sort((a, b) => b.weight - a.weight);

  const pointsAvailable = input.lineupChanges.reduce(
    (sum, c) => sum + Math.max(0, c.gain),
    0,
  );

  return {
    actions,
    headline: buildHeadline(actions, input, hoursToDeadline),
    deadline: input.deadline,
    hoursToDeadline,
    pointsAvailable,
  };
}

function lineupActions(
  input: TodayInput,
  hoursToDeadline: number | null,
): Action[] {
  const { lineup, lineupChanges, lineupApplied } = input;

  if (lineup.starters.length === 0) {
    return [
      {
        id: "lineup-nodata",
        kind: "info",
        weight: 90,
        urgency: "today",
        title: "No squad data yet",
        detail: "Run a sync so the engine can see your players.",
      },
    ];
  }

  // Deadline pressure is what makes a lineup change urgent rather than merely
  // beneficial: after kickoff the same change is worth nothing.
  const urgent = hoursToDeadline !== null && hoursToDeadline <= 24;

  if (lineupApplied) {
    return [
      {
        id: "lineup-done",
        kind: "info",
        weight: 40,
        urgency: "whenever",
        title: `Lineup set: ${lineup.formation.label}`,
        detail: `${lineup.summary} Applied automatically.`,
        pointsAtStake: 0,
      },
    ];
  }

  if (lineupChanges.length === 0) {
    return [
      {
        id: "lineup-ok",
        kind: "info",
        weight: 30,
        urgency: "whenever",
        title: `Lineup already optimal (${lineup.formation.label})`,
        detail: lineup.summary,
        pointsAtStake: 0,
      },
    ];
  }

  const gain = lineupChanges.reduce((sum, c) => sum + Math.max(0, c.gain), 0);
  const injuredIn = lineupChanges.some((c) => c.playerOut.availability === "out");

  // An injured starter is the single most expensive mistake available, so it
  // outranks everything including a large clause bargain.
  const weight = injuredIn ? 100 : urgent ? 95 : 70 + Math.min(20, gain * 4);

  return [
    {
      id: "lineup",
      kind: "set_lineup",
      weight,
      urgency: urgent || injuredIn ? "now" : "today",
      title: injuredIn
        ? `Fix the lineup — an unavailable player is in your XI`
        : `Change ${lineupChanges.length} lineup slot${lineupChanges.length > 1 ? "s" : ""} for +${gain.toFixed(1)} pts`,
      detail: `${lineup.summary} ${lineupChanges
        .slice(0, 4)
        .map((c) => c.reason)
        .join("; ")}.`,
      pointsAtStake: gain,
      automatable: true,
    },
  ];
}

/**
 * A player who has left the competition.
 *
 * This ranks just under a broken XI and above everything else, because it is
 * the only problem on this list that gets worse every day it is ignored:
 * the player cannot score, and his value drifts down while the rest of the
 * league's does not. It is never automated -- listing a player moves real
 * money and stays a two-tap decision.
 */
function departureActions(departed: DepartedPlayer[]): Action[] {
  return departed.slice(0, 3).map((player, index) => {
    const at = player.clubName ? ` He is at ${player.clubName} now.` : "";
    const weight = 89 - index;

    if (player.onMarket) {
      const asking =
        player.askPrice !== null ? ` at ${fmtMoney(player.askPrice)}` : "";
      return {
        id: `departed-${player.playerId}`,
        // Already listed, so there is nothing left to do but wait: an action
        // button here would only offer to list him twice.
        kind: "info" as const,
        weight,
        urgency: "whenever" as const,
        title: `${player.name} has left the competition`,
        detail: `Already on the market${asking}.${at} He cannot score again, so take the best offer rather than holding out for full value.`,
        pointsAtStake: 0,
        money: player.askPrice ?? player.value,
        playerId: player.playerId,
        playerName: player.name,
      };
    }

    return {
      id: `departed-${player.playerId}`,
      kind: "sell" as const,
      weight,
      urgency: "today" as const,
      title: `Sell ${player.name} — he has left the competition`,
      detail: `${player.name} is no longer in this league, so he will score nothing for as long as you hold him.${at} ${fmtMoney(player.value)} and a squad slot are doing nothing. Put him on the market.`,
      pointsAtStake: 0,
      money: player.value,
      playerId: player.playerId,
      playerName: player.name,
    };
  });
}

function stealActions(steals: StealCandidate[], rules: LeagueRules): Action[] {
  return steals
    .filter((s) => s.affordable)
    .slice(0, 3)
    .map((steal, index) => {
      // Only stated where the league genuinely pays for points. This league
      // pays zero per point, and the sentence used to be printed regardless,
      // at an invented 60.000€ rate.
      const money = paysForPoints(rules)
        ? ` Worth roughly ${fmtMoney(steal.upgrade * rules.pricePerPoint)} a round in prize money.`
        : "";
      const owner = steal.ownerName ? ` Currently at ${steal.ownerName}.` : "";

      return {
        id: `steal-${steal.player.playerId}`,
        kind: "steal_clause" as const,
        weight: 80 - index * 2 + Math.min(10, steal.upgrade * 3),
        urgency: "today" as const,
        title: `Pay ${steal.player.name}'s clause — ${fmtMoney(steal.clausePrice)}`,
        detail: `${steal.reason}${money}${owner}`,
        pointsAtStake: steal.upgrade,
        money: -steal.clausePrice,
        playerId: steal.player.playerId,
        playerName: steal.player.name,
      };
    });
}

/**
 * Rival players whose value is rising while their clause stays pinned. Paying
 * the clause buys forward growth — the payoff is future value and depends on
 * the trend holding, so these are bets and are framed as such, never as
 * discounts. Ranked below market buys: a current, priced opportunity beats a
 * forward bet. Capped at 3.
 */
const MIN_BET_OPPORTUNITY = 5;

function clauseBetActions(trendBets: ClauseBet[]): Action[] {
  return trendBets
    .filter((c) => c.affordable && c.opportunity >= MIN_BET_OPPORTUNITY)
    .slice(0, 3)
    .map((bet, index) => ({
      id: `bet-${bet.player.playerId}`,
      kind: "clause_bet" as const,
      // Deliberately below the 60-75 band that market buys occupy.
      weight: 45 + Math.min(12, bet.opportunity * 1.5) - index,
      urgency: "today" as const,
      title: `Bet on ${bet.player.name}: clause at ${fmtMoney(bet.clausePrice)}, value rising`,
      detail: bet.reason,
      money: -bet.clausePrice,
      playerId: bet.player.playerId,
      playerName: bet.player.name,
    }));
}

/**
 * When no clause in the league is payable yet, say when that changes.
 *
 * Information only — this names a date so a deadline is not a surprise. Ranked
 * above a marginal buy because a clause that opens in two days is worth
 * planning for, and below anything urgent.
 */
function clauseWindowActions(clauses: ClauseReport): Action[] {
  if (!clauses.windowNote) return [];
  const next = clauses.pendingSteals.find((s) => s.affordable);
  const target = next
    ? ` ${next.player.name}'s clause opens then too, at ${fmtMoney(next.clausePrice)}.`
    : "";

  return [
    {
      id: "clause-window",
      kind: "info",
      weight: 55,
      urgency: "whenever",
      title: "No clause is payable yet",
      detail: `${clauses.windowNote}${target}`,
      pointsAtStake: 0,
    },
  ];
}

/**
 * Our own listings. Both cases here expire, which is what makes them urgent:
 * a bid closing inside the lineup window is worth more attention than a buy
 * that will still be available tomorrow.
 *
 * Never automated and never given a button. Accepting or cancelling moves
 * money, and it is not even established whether a machine-market listing
 * auto-sells to the highest bidder at expiry or needs acceptance (OPEN-4), so
 * the honest output is a report.
 */
function listingActions(listings: OwnListing[]): Action[] {
  const actions: Action[] = [];

  for (const [index, listing] of listings.slice(0, 3).entries()) {
    const closed = listing.hoursToExpiry !== null && listing.hoursToExpiry < 0;
    if (closed) continue;

    const soon = listing.hoursToExpiry !== null && listing.hoursToExpiry <= 24;

    if (listing.topBid !== null) {
      actions.push({
        id: `listing-bid-${listing.playerId}`,
        kind: "listing",
        // Just under a broken XI: it is money, it has a deadline, and it
        // disappears rather than waiting for the next report.
        weight: (soon ? 87 : 62) - index,
        urgency: soon ? "now" : "today",
        title: `${fmtMoney(listing.topBid)} bid on ${listing.name}`,
        detail: listing.reason,
        pointsAtStake: 0,
        money: listing.topBid,
        playerId: listing.playerId,
        playerName: listing.name,
      });
      continue;
    }

    // No bids and about to expire: re-price or withdraw, but only worth saying
    // while there is still time to do either.
    if (soon) {
      actions.push({
        id: `listing-stale-${listing.playerId}`,
        kind: "listing",
        weight: 58 - index,
        urgency: "today",
        title: `${listing.name} expires with no bids`,
        detail: `${listing.reason} Re-price or withdraw before it lapses.`,
        pointsAtStake: 0,
        money: listing.price,
        playerId: listing.playerId,
        playerName: listing.name,
      });
    }
  }

  return actions;
}

/**
 * How many buys to surface at once.
 *
 * The old limit was one, which capped the spend rate at a single player a day
 * at the asking price — the binding constraint on turning 202M of idle cash
 * into points, with two dozen listings live at any moment. Three, because
 * `buildActionButtons` caps at four rows and the other kinds need one, and
 * because `mbp`/`vmb` are both 3 and may well cap simultaneous bids (OPEN-5):
 * three is safe under either reading.
 */
const MAX_BUY_ACTIONS = 3;

function marketActions(
  market: MarketReport,
  skipPlayerIds: ReadonlySet<string>,
): Action[] {
  const actions: Action[] = [];

  // Winning every proposed bid at once must remain affordable, so each bid is
  // checked against what is left after the ones already proposed and after the
  // cash Futmondo is already withholding for standing bids.
  let remaining = Math.max(0, market.funds - market.committed);

  const affordable = market.buys.filter((b) => b.affordable);
  for (const [index, buy] of affordable.entries()) {
    if (actions.length >= MAX_BUY_ACTIONS) break;
    if (buy.suggestedBid > remaining) continue;
    remaining -= buy.suggestedBid;

    // The ceiling and the bid are stated separately: the confirmation is meant
    // to be an informed decision, not a number to trust.
    const pricing =
      buy.suggestedBid > buy.price
        ? ` Asking ${fmtMoney(buy.price)}; bidding ${fmtMoney(
            buy.suggestedBid,
          )} in ${fmtMoney(buy.increment)} steps, worth up to ${fmtMoney(buy.ceiling)} to us.`
        : ` Worth up to ${fmtMoney(buy.ceiling)} to us.`;

    actions.push({
      id: `buy-${buy.player.playerId}`,
      kind: "buy",
      weight: 60 - index + Math.min(15, buy.upgrade * 4),
      urgency: "today",
      title: `Bid ${fmtMoney(buy.suggestedBid)} for ${buy.player.name}`,
      detail: `${buy.reason}${pricing}`,
      pointsAtStake: buy.upgrade,
      money: -buy.suggestedBid,
      bid: buy.suggestedBid,
      playerId: buy.player.playerId,
      playerName: buy.player.name,
    });
  }

  if (actions.length > 1) {
    const total = actions.reduce((sum, a) => sum + Math.abs(a.money ?? 0), 0);
    actions.push({
      id: "buy-budget",
      kind: "info",
      weight: 45,
      urgency: "whenever",
      title: `${actions.length} bids total ${fmtMoney(total)}`,
      detail: `Winning all of them stays inside the ${fmtMoney(
        Math.max(0, market.funds - market.committed),
      )} not already held by a standing bid.`,
      money: -total,
    });
  }

  // Selling matters most when it is free and unlocks something better. A player
  // already on the market is skipped: the sale is in progress, and a second
  // "sell him" line reads as a second problem.
  const worthSelling = market.sells.filter(
    (s) =>
      s.cost === 0 && !s.alreadyListed && !skipPlayerIds.has(s.player.playerId),
  );
  for (const [index, sell] of worthSelling.slice(0, 2).entries()) {
    const floor =
      sell.directSell !== null
        ? ` Or ${fmtMoney(sell.directSell)} guaranteed, straight to the machine.`
        : "";
    actions.push({
      id: `sell-${sell.player.playerId}`,
      kind: "sell",
      weight: 50 - index,
      urgency: "whenever",
      title: `Sell ${sell.player.name} — ${fmtMoney(sell.player.value)}`,
      detail: `${sell.reason}${floor}`,
      pointsAtStake: 0,
      money: sell.player.value,
      playerId: sell.player.playerId,
      playerName: sell.player.name,
    });
  }

  return actions;
}

function buildHeadline(
  actions: Action[],
  input: TodayInput,
  hoursToDeadline: number | null,
): string {
  const deadlineNote =
    hoursToDeadline === null
      ? ""
      : hoursToDeadline < 0
        ? " The round has already started."
        : hoursToDeadline < 48
          ? ` Deadline in ${formatHours(hoursToDeadline)}.`
          : "";

  const top = actions.find((a) => a.kind !== "info");
  if (!top) {
    return `Nothing to do.${deadlineNote || ` ${input.lineup.summary}`}`;
  }
  return `${top.title}.${deadlineNote}`;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 24) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
