import type { RosterPlayer } from "../futmondo/types";
import { normalize } from "./types";

export interface ClauseCandidate extends RosterPlayer {
  ownerName: string;
  ownerTeamId?: string;
  unlocked: boolean;
  clause: number;
  suggestedClause: number;
  avgLastFive: number;
  avgOverall: number;
  metric1: number;
  metric2: number;
  metric3: number;
  stealScore: number; // 0-100
}

export interface ClauseReport {
  steals: ClauseCandidate[];
  recommendedAction: string;
}

export interface ClauseContext {
  players: RosterPlayer[]; // championship players incl. clause + ownership info
  myTeamId?: string;
  max?: number;
}

function isUnlocked(p: RosterPlayer): boolean {
  // Futmondo "locked" vs "unlocked" clause flag
  const lockedKey = (p as Record<string, unknown>).locked;
  if (typeof lockedKey === "boolean") return !lockedKey;
  const status = String((p as Record<string, unknown>).lockedStatus ?? "")
    .toLowerCase();
  return status !== "locked" && status !== "bloqueada";
}

export function runClauseAnalysis(ctx: ClauseContext): ClauseReport {
  const { max = 15 } = ctx;

  const candidates: ClauseCandidate[] = [];

  for (const p of ctx.players) {
    const clause = Number(p.clause ?? 0);
    const suggested = Number(p.suggestedClause ?? 0);
    const avgLast = Number(p.averageLastFive ?? p.average ?? 0);
    const avgAll = Number(p.average ?? p.averageLastFive ?? 0);

    // Only rival-owned players with a real clause matter for stealing
    const ownerName = String((p as Record<string, unknown>).ownerTeamName ?? (p as Record<string, unknown>).ownerName ?? "");
    const ownerTeamId = (p as Record<string, unknown>).ownerTeamId as string | undefined;
    const isOwn = ownerTeamId && ctx.myTeamId && ownerTeamId === ctx.myTeamId;

    if (isOwn) continue;
    if (clause <= 0 || avgLast <= 0 || avgAll <= 0) continue;

    const m1 = clause / avgLast; // lower = cheaper relative to recent form
    const m2 = suggested > 0 ? suggested / clause : 1; // higher = more upside
    const m3 = clause / avgAll; // lower = cheaper relative to overall

    candidates.push({
      ...p,
      ownerName,
      ownerTeamId,
      unlocked: isUnlocked(p),
      clause,
      suggestedClause: suggested,
      avgLastFive: avgLast,
      avgOverall: avgAll,
      metric1: m1,
      metric2: m2,
      metric3: m3,
      stealScore: 0,
    });
  }

  // Normalize metrics and combine. Lower m1 & m3 are good; higher m2 is good.
  const m1s = candidates.map((c) => c.metric1);
  const m3s = candidates.map((c) => c.metric3);
  const m2s = candidates.map((c) => c.metric2);
  const minM1 = Math.min(...m1s), maxM1 = Math.max(...m1s);
  const minM3 = Math.min(...m3s), maxM3 = Math.max(...m3s);
  const minM2 = Math.min(...m2s), maxM2 = Math.max(...m2s);

  for (const c of candidates) {
    const n1 = 1 - normalize(c.metric1, minM1, maxM1); // cheaper better
    const n2 = normalize(c.metric2, minM2, maxM2); // upside better
    const n3 = 1 - normalize(c.metric3, minM3, maxM3); // cheaper better
    const unlockedBonus = c.unlocked ? 0.15 : 0;
    // STEAL: prefer cheap relative to performance. Unlocked strongly preferred.
    c.stealScore = Math.round(
      Math.max(
        0,
        Math.min(100, (n1 * 0.45 + n3 * 0.25 + n2 * 0.15 + unlockedBonus) * 100),
      ),
    );
  }

  const steals = candidates
    .filter((c) => c.unlocked) // only actionable steals
    .sort((a, b) => b.stealScore - a.stealScore)
    .slice(0, max);

  let recommendedAction: string;
  if (steals.length === 0) {
    recommendedAction = "No rival players with unlocked, undervalued clauses right now.";
  } else {
    const top = steals[0];
    recommendedAction = `Steal opportunity: ${top.name} (${top.ownerName}) — clause ~${fmtMoney(top.clause)} for ${top.avgLastFive.toFixed(1)} avg pts last 5 (score ${top.stealScore}).`;
  }

  return { steals, recommendedAction };
}

export function fmtMoney(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M€`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k€`;
  return `${Math.round(v)}€`;
}

