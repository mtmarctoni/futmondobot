import type { MarketPlayer, RosterPlayer } from "../futmondo/types";
import { MARKET_WEIGHTS, playerFromMarket, playerFromRoster, scorePlayer } from "./scoring";
import type { ScoredPlayer } from "./types";

export interface MarketDecision {
  type: "BUY" | "SELL";
  reason: string;
  player: ScoredPlayer;
}

export interface MarketReport {
  buys: MarketDecision[];
  sells: MarketDecision[];
  recommendedAction: string;
}

export interface MarketContext {
  market: MarketPlayer[];
  roster: RosterPlayer[];
  funds: number;
  teamValue: number;
  maxBuys?: number;
  maxSells?: number;
  fixtureDifficulty?: Record<string, { difficulty: number }>;
}

export function runMarketAnalysis(ctx: MarketContext): MarketReport {
  const { market, roster, funds, teamValue, fixtureDifficulty = {} } = ctx;

  // ---------- BUY ----------
  const buyPool: ScoredPlayer[] = market
    .filter((p) => p.price > 0) // has a price, purchasable
    .map((p) => {
      const input = playerFromMarket(p);
      const fd = fixtureDifficulty[p.team]?.difficulty ?? 0.5;
      input.fixtureDifficulty = fd;
      const scored = scorePlayer(input, MARKET_WEIGHTS);
      return scored;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, (ctx.maxBuys ?? 10) * 4);

  const buys: MarketDecision[] = buyPool.slice(0, ctx.maxBuys ?? 10).map((p) => {
    const affordable = p.value <= funds + teamValue * 0.5;
    const reason = affordable
      ? `High value pick: ${p.form.toFixed(0)}% form, ${p.valueScore.toFixed(0)}% value score`
      : "High potential but exceeds max offer (funds + 50% team value)";
    return { type: "BUY", reason, player: p };
  });

  // ---------- SELL ----------
  const rosterScored: ScoredPlayer[] = roster.map((p) => {
    const input = playerFromRoster(p);
    const fd = fixtureDifficulty[p.team]?.difficulty ?? 0.5;
    input.fixtureDifficulty = fd;
    return scorePlayer(input, MARKET_WEIGHTS);
  });

  const sells: MarketDecision[] = rosterScored
    .sort((a, b) => a.score - b.score)
    .slice(0, ctx.maxSells ?? 5)
    .map((p) => ({
      type: "SELL",
      reason: `Underperforming vs value: ${p.form.toFixed(0)}% form, score ${p.score.toFixed(0)}`,
      player: p,
    }));

  const buyHead = buys[0];
  const sellHead = sells[0];
  let recommendedAction: string;
  if (!buyHead && !sellHead) {
    recommendedAction = "No clear market moves right now.";
  } else if (buyHead && (!sellHead || buyHead.player.score > sellHead.player.score)) {
    recommendedAction = `Buy ${buyHead.player.name} (${buyHead.player.role}). ${buyHead.reason}`;
  } else {
    recommendedAction = `Consider selling ${sellHead.player.name} (${sellHead.player.role}). ${sellHead.reason}`;
  }

  return { buys, sells, recommendedAction };
}
