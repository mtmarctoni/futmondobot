import { isFixtureDifficult } from "../stats/apiFootball";
import { fmtMoney } from "./clauses";
import type { ClauseReport } from "./clauses";
import type { LineupResult } from "./lineup";
import type { MarketReport } from "./market";

export interface Action {
  id: string;
  kind: "set_lineup" | "buy" | "sell" | "steal" | "info";
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  playerId?: string;
  playerName?: string;
  ref?: string;
}

export interface TodayReport {
  actions: Action[];
  headline: string;
  deadline?: string;
}

export interface TodayInput {
  lineup: LineupResult;
  market: MarketReport;
  clauses: ClauseReport;
  deadline?: string;
  fixtureWindow?: number;
  fixtureDifficulty?: Record<string, { difficulty: number }>;
}

export function buildTodayActions(input: TodayInput): TodayReport {
  const actions: Action[] = [];

  // 1. Set lineup (highest priority)
  const readyCount = input.lineup.players.length;
  const need = input.lineup.formation.reduce((a, b) => a + b, 0);
  if (readyCount < need) {
    actions.push({
      id: "lineup",
      kind: "set_lineup",
      priority: "high",
      title: `Set your lineup — ${readyCount}/${need} slots ready`,
      detail: input.lineup.lineupMessage,
    });
  } else {
    actions.push({
      id: "lineup",
      kind: "set_lineup",
      priority: "high",
      title: `Set lineup (${input.lineup.formation.join("-")})`,
      detail: input.lineup.lineupMessage,
    });
  }

  // 2. Clause steal (high) — rivals
  const topSteal = input.clauses.steals[0];
  if (topSteal) {
    actions.push({
      id: "steal",
      kind: "steal",
      priority: topSteal.stealScore >= 70 ? "high" : "medium",
      title: `Steal ${topSteal.name} from ${topSteal.ownerName}`,
      detail: `Clause ${fmtMoney(topSteal.clause)} for ${topSteal.avgLastFive.toFixed(1)} avg pts last 5 — score ${topSteal.stealScore}.`,
      playerId: topSteal.id,
      playerName: topSteal.name,
    });
  }

  // 3. Market buy (medium/high)
  const topBuy = input.market.buys[0];
  if (topBuy) {
    actions.push({
      id: "buy",
      kind: "buy",
      priority: "medium",
      title: `Buy ${topBuy.player.name} (${topBuy.player.role})`,
      detail: topBuy.reason,
      playerId: topBuy.player.id,
      playerName: topBuy.player.name,
    });
  }

  // 4. Market sell (medium)
  const topSell = input.market.sells[0];
  if (topSell) {
    actions.push({
      id: "sell",
      kind: "sell",
      priority: "medium",
      title: `Sell ${topSell.player.name} (${topSell.player.role})`,
      detail: topSell.reason,
      playerId: topSell.player.id,
      playerName: topSell.player.name,
    });
  }

  // 5. Hard-fixture warning (info)
  const difficultTeams = Object.entries(input.fixtureDifficulty ?? {}).filter(
    ([, v]) => isFixtureDifficult({ teamId: 0, teamName: "", difficulty: v.difficulty, homeNext: 0, awayNext: 0 }, 1.6),
  );
  if (difficultTeams.length > 0 && input.lineup.players.length > 0) {
    const affected = input.lineup.players
      .filter((p) => difficultTeams.some(([t]) => t === p.team))
      .slice(0, 3)
      .map((p) => p.name);
    if (affected.length > 0) {
      actions.push({
        id: "hard_fixtures",
        kind: "info",
        priority: "low",
        title: "Tough upcoming fixtures",
        detail: `Consider benching: ${affected.join(", ")}.`,
      });
    }
  }

  const priorityOrder = { high: 0, medium: 1, low: 2 } as const;
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const headline = [
    `Lineup: ${input.lineup.formation.join("-")}`,
    topSteal ? `Steal ${topSteal.name}` : "No steals",
    topBuy ? `Buy ${topBuy.player.name}` : "No buys",
  ].join(" · ");

  return { actions, headline, deadline: input.deadline };
}
