/**
 * The one screen worth reading: what to do right now, in order.
 *
 * Ordering is by consequence, not by category. A lineup with an injured
 * starter in it costs points this week and outranks any transfer; a clause
 * block costs nothing and is therefore always worth doing; a marginal buy can
 * wait. Anything that needs no action is deliberately not listed.
 */
import type { ClauseReport, ExposedPlayer, StealCandidate } from "./clauses";
import type { DepartedPlayer } from "./departed";
import type { LineupChange, LineupPick } from "./lineup";
import type { MarketReport } from "./market";
import { fmtMoney, type LeagueRules } from "./types";

export type ActionKind =
  | "set_lineup"
  | "lock_player"
  | "steal_clause"
  | "buy"
  | "sell"
  | "info";

export interface Action {
  id: string;
  kind: ActionKind;
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
  actions.push(...lockActions(input.clauses.toLock));
  actions.push(...stealActions(input.clauses.steals, input.rules));
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
  const injuredIn = lineupChanges.some((c) => c.playerOut.unavailableReason);

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
 * This ranks just under a broken XI and just over a clause block, because it
 * is the only problem on this list that gets worse every day it is ignored:
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

/**
 * Blocking is free and irreversible only in the sense that it can be undone at
 * will, so anything genuinely exposed is worth doing immediately.
 */
function lockActions(toLock: ExposedPlayer[]): Action[] {
  return toLock.slice(0, 3).map((risk, index) => ({
    id: `lock-${risk.player.playerId}`,
    kind: "lock_player" as const,
    // Just below a broken lineup: costs nothing, prevents losing a starter.
    weight: 88 - index,
    urgency: "now" as const,
    title: `Block ${risk.player.name}'s clause`,
    detail: `${risk.reason} Blocking costs nothing and this league allows unlimited blocks.`,
    money: 0,
    playerId: risk.player.playerId,
    playerName: risk.player.name,
    automatable: true,
  }));
}

function stealActions(steals: StealCandidate[], rules: LeagueRules): Action[] {
  return steals
    .filter((s) => s.affordable)
    .slice(0, 3)
    .map((steal, index) => {
      const weeklyReturn = steal.upgrade * rules.pricePerPoint;
      return {
        id: `steal-${steal.player.playerId}`,
        kind: "steal_clause" as const,
        weight: 80 - index * 2 + Math.min(10, steal.upgrade * 3),
        urgency: "today" as const,
        title: `Pay ${steal.player.name}'s clause — ${fmtMoney(steal.clausePrice)}`,
        detail: `${steal.reason} Worth roughly ${fmtMoney(weeklyReturn)} a round in prize money${
          steal.ownerName ? `. Currently at ${steal.ownerName}` : ""
        }.`,
        pointsAtStake: steal.upgrade,
        money: -steal.clausePrice,
        playerId: steal.player.playerId,
        playerName: steal.player.name,
      };
    });
}

function marketActions(
  market: MarketReport,
  skipPlayerIds: ReadonlySet<string>,
): Action[] {
  const actions: Action[] = [];

  const topBuy = market.buys.find((b) => b.affordable);
  if (topBuy) {
    actions.push({
      id: `buy-${topBuy.player.playerId}`,
      kind: "buy",
      weight: 60 + Math.min(15, topBuy.upgrade * 4),
      urgency: "today",
      title: `Bid on ${topBuy.player.name} — ${fmtMoney(topBuy.price)}`,
      detail: topBuy.reason,
      pointsAtStake: topBuy.upgrade,
      money: -topBuy.price,
      playerId: topBuy.player.playerId,
      playerName: topBuy.player.name,
    });
  }

  // Selling matters most when it is free and unlocks something better.
  const worthSelling = market.sells.filter(
    (s) => s.cost === 0 && !skipPlayerIds.has(s.player.playerId),
  );
  for (const [index, sell] of worthSelling.slice(0, 2).entries()) {
    actions.push({
      id: `sell-${sell.player.playerId}`,
      kind: "sell",
      weight: 50 - index,
      urgency: "whenever",
      title: `Sell ${sell.player.name} — ${fmtMoney(sell.player.value)}`,
      detail: sell.reason,
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
