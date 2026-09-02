/**
 * The expected-points model.
 *
 * Every decision in the app reduces to one question — how many points will
 * this player score next round — so that number is computed once, here, and
 * everything else is arithmetic on top of it.
 *
 *     expectedPoints = startProbability x pointsPerStart x fixtureFactor
 *
 * Each factor is estimated from the most reliable source available and falls
 * back gracefully, because early in a season none of them have much data.
 */
import type { FutmondoRole } from "../futmondo/types";
import type { PlayerForm, ValueTrend } from "../db/repo";
import { clamp, millions, type Evaluated } from "./types";

/**
 * Points a starting player of each role scores in a typical round. Used only
 * as a prior when we have no per-round history yet, and blended out as
 * evidence arrives.
 */
const ROLE_PRIOR_POINTS: Record<FutmondoRole, number> = {
  POR: 4,
  DEF: 4,
  MED: 4.5,
  DEL: 5,
};

/**
 * How strongly the prior pulls. Equivalent to "we act as if we had this many
 * prior rounds of average performance", so three real rounds already dominate.
 */
const PRIOR_WEIGHT_ROUNDS = 2;

/**
 * A hard fixture is worth roughly 20% less than a neutral one, an easy fixture
 * 20% more. Deliberately mild: fixture matters, but far less than whether the
 * player is on the pitch at all.
 */
const FIXTURE_SWING = 0.2;

export function fixtureFactor(difficulty: number): number {
  // difficulty 0 (certain win) -> 1 + swing; 1 (certain loss) -> 1 - swing.
  return 1 + FIXTURE_SWING * (1 - 2 * clamp(difficulty, 0, 1));
}

/**
 * Blends observed points-per-start with the role prior, weighted by how many
 * rounds of evidence exist. A player with one huge round does not get treated
 * as a certainty.
 */
export function shrinkPointsPerStart(
  role: FutmondoRole,
  observed: number | null,
  rounds: number,
): number {
  const prior = ROLE_PRIOR_POINTS[role];
  if (observed === null || rounds <= 0) return prior;
  const weight = rounds / (rounds + PRIOR_WEIGHT_ROUNDS);
  return weight * observed + (1 - weight) * prior;
}

/**
 * Chance the player starts. A scraped probable lineup is the best signal;
 * failing that, how often they have recently played 60+ minutes; failing that,
 * a coin flip, since we genuinely do not know.
 */
export function startProbability(args: {
  scraped: number | undefined;
  startRate: number | null;
  rounds: number;
  unavailable: boolean;
}): { probability: number; basis: string } {
  if (args.unavailable) return { probability: 0, basis: "injured or suspended" };
  if (args.scraped !== undefined) {
    return {
      probability: clamp(args.scraped, 0, 1),
      basis: `probable XI ${Math.round(clamp(args.scraped, 0, 1) * 100)}%`,
    };
  }
  if (args.startRate !== null && args.rounds > 0) {
    // Shrink towards 0.5 as well: two starts out of two is not certainty.
    const weight = args.rounds / (args.rounds + PRIOR_WEIGHT_ROUNDS);
    const probability = weight * args.startRate + (1 - weight) * 0.5;
    return {
      probability: clamp(probability, 0, 1),
      basis: `started ${Math.round(args.startRate * 100)}% of last ${args.rounds}`,
    };
  }
  return { probability: 0.5, basis: "no minutes data" };
}

export interface EvaluateInput {
  playerId: string;
  name: string;
  role: FutmondoRole;
  clubName: string | null;
  clubId: string | null;
  slug: string | null;
  value: number;
  seasonPoints: number;
  ownerTeamId: string | null;
  clausePrice: number | null;
  clauseLocked: boolean | null;
}

export interface EvaluateContext {
  form: Map<string, PlayerForm>;
  trends: Map<string, ValueTrend>;
  /** Keyed by real club id. */
  difficulty: Map<
    string,
    { difficulty: number; kickoff: string | null; opponent: string | null }
  >;
  unavailable: Map<string, string>;
  startProbabilities: Map<string, number>;
}

export function evaluate(
  input: EvaluateInput,
  ctx: EvaluateContext,
): Evaluated {
  const notes: string[] = [];

  const form = ctx.form.get(input.playerId);
  const rounds = form?.rounds ?? 0;
  const pointsPerStart = shrinkPointsPerStart(
    input.role,
    form ? form.avgPoints : null,
    rounds,
  );

  const unavailableReason = ctx.unavailable.get(input.playerId) ?? null;
  const { probability, basis } = startProbability({
    scraped: ctx.startProbabilities.get(input.playerId),
    startRate: form ? form.startRate : null,
    rounds,
    unavailable: unavailableReason !== null,
  });

  const fixture = input.clubId ? ctx.difficulty.get(input.clubId) : undefined;
  const difficulty = fixture?.difficulty ?? 0.5;
  const expectedPoints = probability * pointsPerStart * fixtureFactor(difficulty);

  const trend = ctx.trends.get(input.playerId);
  const valueDelta = trend?.delta ?? 0;

  if (unavailableReason) notes.push(unavailableReason);
  else notes.push(basis);

  if (rounds === 0) notes.push("no per-round history yet");
  else notes.push(`${pointsPerStart.toFixed(1)} pts/start over ${rounds}`);

  if (fixture?.opponent) {
    const label = difficulty < 0.45 ? "favourable" : difficulty > 0.65 ? "hard" : "even";
    notes.push(`${label} vs ${fixture.opponent}`);
  }
  if (Math.abs(valueDelta) > 100_000) {
    notes.push(valueDelta > 0 ? "value rising" : "value falling");
  }

  const valueM = millions(input.value);

  return {
    playerId: input.playerId,
    name: input.name,
    role: input.role,
    clubName: input.clubName,
    clubId: input.clubId,
    slug: input.slug,
    value: input.value,
    seasonPoints: input.seasonPoints,
    pointsPerStart,
    startProbability: probability,
    fixtureDifficulty: difficulty,
    nextOpponent: fixture?.opponent ?? null,
    unavailableReason,
    valueDelta,
    sampleRounds: rounds,
    expectedPoints,
    pointsPerMillion: valueM > 0 ? expectedPoints / valueM : 0,
    ownerTeamId: input.ownerTeamId,
    clausePrice: input.clausePrice,
    clauseLocked: input.clauseLocked,
    notes,
  };
}
