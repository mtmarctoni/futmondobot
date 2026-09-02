import type { FutmondoRole, MarketPlayer, RosterPlayer } from "../futmondo/types";
import { normalize } from "./types";
import type { ScoredPlayer } from "./types";

export interface RoleWeight {
  form: number;
  fixture: number;
  value: number;
  consistency: number;
}

// Mixto-mode weighting by role. Lineup-relevant weights emphasize form &
// fixtures; value matters more for market decisions (handled separately).
export const LINEUP_WEIGHTS: Record<FutmondoRole, RoleWeight> = {
  POR: { form: 0.4, fixture: 0.35, value: 0.1, consistency: 0.15 },
  DEF: { form: 0.35, fixture: 0.35, value: 0.15, consistency: 0.15 },
  MED: { form: 0.35, fixture: 0.3, value: 0.2, consistency: 0.15 },
  DEL: { form: 0.4, fixture: 0.25, value: 0.2, consistency: 0.15 },
};

export const MARKET_WEIGHTS = {
  value: 0.5,
  form: 0.25,
  fixture: 0.15,
  consistency: 0.1,
};

export interface ScoreInput {
  id: string;
  name: string;
  role: FutmondoRole;
  team: string;
  value: number;
  points: number;
  average: number;
  form: number; // 0..1 normalized recent form
  fixtureDifficulty: number; // 0..1, lower is easier
  injuryRisk: number; // 0..1
  valueScore: number; // 0..1 pts-per-million normalized within role
}

const ROLE_ORDER: Record<FutmondoRole, number> = {
  POR: 0,
  DEF: 1,
  MED: 2,
  DEL: 3,
};

export function roleRank(role: FutmondoRole): number {
  return ROLE_ORDER[role] ?? 0;
}

/** Normalize points-per-million within the same role across a player pool. */
export function computeRoleValueScores(
  players: { role: FutmondoRole; value: number; points: number }[],
): Map<string, number> {
  const byRole: Record<FutmondoRole, { ppm: number; key: string }[]> = {
    POR: [],
    DEF: [],
    MED: [],
    DEL: [],
  };
  for (const p of players) {
    if (!p.value || p.value <= 0) continue;
    byRole[p.role].push({ ppm: p.points / (p.value / 1_000_000), key: `${p.role}:${p.value}` });
  }
  const out = new Map<string, number>();
  for (const role of Object.keys(byRole) as FutmondoRole[]) {
    const group = byRole[role];
    if (group.length === 0) continue;
    const ppts = group.map((g) => g.ppm);
    const min = Math.min(...ppts);
    const max = Math.max(...ppts);
    for (const g of group) {
      out.set(g.key, normalize(g.ppm, min, max));
    }
  }
  // Store normalized value per unique player by value; callers re-key by player id.
  return out;
}

export function computeValueScore(
  player: Pick<ScoredPlayer, "role" | "points" | "value">,
  poolMin: number,
  poolMax: number,
): number {
  if (!player.value || player.value <= 0) return 0;
  const ppm = player.points / (player.value / 1_000_000);
  return normalize(ppm, poolMin, poolMax);
}

export function computeFixtureScore(fixtureDifficulty: number): number {
  // difficulty 0..1 (lower easier) -> score 1..0
  return 1 - Math.min(1, Math.max(0, fixtureDifficulty));
}

export function scorePlayer(
  input: ScoreInput,
  weights: RoleWeight = LINEUP_WEIGHTS[input.role],
  byRoleMinMax?: Record<FutmondoRole, { min: number; max: number }>,
): ScoredPlayer {
  const formScore = input.form;
  const fixtureScore = computeFixtureScore(input.fixtureDifficulty);
  const consistencyScore = normalize(input.average, 2, 10);
  const valueScore =
    byRoleMinMax && byRoleMinMax[input.role]
      ? computeValueScore(
          { role: input.role, points: input.points, value: input.value },
          byRoleMinMax[input.role].min,
          byRoleMinMax[input.role].max,
        )
      : input.valueScore;
  const injuryPenalty = input.injuryRisk * 0.8;

  const raw =
    weights.form * formScore +
    weights.fixture * fixtureScore +
    weights.value * valueScore +
    weights.consistency * consistencyScore -
    injuryPenalty;

  const score = Math.max(0, Math.min(100, raw * 100 / (weights.form + weights.fixture + weights.value + weights.consistency)));

  return {
    id: input.id,
    name: input.name,
    role: input.role,
    team: input.team,
    value: input.value,
    points: input.points,
    average: input.average,
    form: input.form,
    fixtureDifficulty: input.fixtureDifficulty,
    injuryRisk: input.injuryRisk,
    valueScore,
    score,
  };
}

export function playerFromRoster(p: RosterPlayer): ScoreInput {
  const form = normalize(p.averageLastFive ?? p.average ?? 0, 1, 10);
  const injuryRisk = p.injury ? 1 : p.status === "injured" ? 1 : 0;
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    team: p.team,
    value: p.value,
    points: p.points ?? 0,
    average: p.average ?? p.averageLastFive ?? 0,
    form,
    fixtureDifficulty: 0.5, // filled by engine with real data when available
    injuryRisk,
    valueScore: 0,
  };
}

export function playerFromMarket(p: MarketPlayer): ScoreInput {
  const form = normalize(p.averageLastFive ?? p.average ?? 0, 1, 10);
  const injuryRisk = p.injury ? 1 : p.status === "injured" ? 1 : 0;
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    team: p.team,
    value: p.price ?? p.value ?? 0,
    points: p.points ?? 0,
    average: p.average ?? p.averageLastFive ?? 0,
    form,
    fixtureDifficulty: 0.5,
    injuryRisk,
    valueScore: 0,
  };
}
