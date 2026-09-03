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
 *
 * The evidence comes from the scoring record the roster and market payloads
 * carry under `average`, not from `round_points`: `/1/userteam/roundlineup`
 * returns an empty player list even for closed rounds, so that table never
 * fills. Waiting for it meant every player scored the bare role prior, which
 * is why the lineup page showed one identical number per position no matter
 * how differently the players had actually performed.
 */
import type { FutmondoRole, PlayerStats } from "../futmondo/types";
import type { FixtureOutlook, PlayerForm, ValueTrend } from "../db/repo";
import { clamp, millions, type Evaluated } from "./types";

/**
 * Points a starting player of each role scores in a typical round. Used only
 * as a prior when we have no history at all, and blended out as evidence
 * arrives.
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

/** Appearances that count as current form. */
const FORM_WINDOW = 3;

/**
 * How far current form may move points-per-start in either direction. Capped,
 * because one enormous week is mostly luck: a striker who scores twice from
 * three shots has not become a different player.
 */
const FORM_SWING = 0.25;

/**
 * How much of the venue-specific average to trust. It splits the same matches
 * in two, so it carries half the sample and gets half the weight.
 */
const VENUE_WEIGHT = 0.5;

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
 * The appearances behind a `fitness` array.
 *
 * A zero entry means a round the player did not feature in: Futmondo awards
 * points for the appearance itself, so someone who was actually on the pitch
 * essentially never finishes on exactly zero. That reading is only used when it
 * agrees with the `matches` count, so a scoring rule that does allow a true
 * zero degrades the form signal rather than corrupting it.
 */
export function appearances(stats: PlayerStats): number[] | null {
  if (stats.fitness.length === 0) return null;
  const played = stats.fitness.filter((points) => points !== 0);
  return played.length === stats.matches ? played : null;
}

/**
 * How much recent form moves the season average, as a multiplier bounded by
 * FORM_SWING. Above 1 for a player scoring better lately than across the
 * season, below 1 for one who has gone quiet.
 */
export function formFactor(stats: PlayerStats): number {
  const played = appearances(stats);
  // Two appearances cannot distinguish a run of form from a single good week.
  if (!played || played.length < FORM_WINDOW) return 1;

  const overall = played.reduce((a, b) => a + b, 0) / played.length;
  if (overall <= 0) return 1;

  const recent = played.slice(-FORM_WINDOW);
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return clamp(recentMean / overall, 1 - FORM_SWING, 1 + FORM_SWING);
}

/**
 * Points per appearance, from the season average, tilted towards the venue of
 * the next fixture and then towards current form.
 */
export function observedPointsPerStart(
  stats: PlayerStats,
  home: boolean | undefined,
): number | null {
  if (stats.matches <= 0) return null;

  let base = stats.average;
  const venue = home === true ? stats.homeAverage : home === false ? stats.awayAverage : undefined;
  // A zero venue average is indistinguishable from "never played that side",
  // and treating the two alike would halve a fit player's projection.
  if (venue !== undefined && venue > 0) {
    base = VENUE_WEIGHT * venue + (1 - VENUE_WEIGHT) * stats.average;
  }

  return base * formFactor(stats);
}

/**
 * Chance the player starts. A scraped probable lineup is the best signal;
 * failing that, the share of rounds they have actually appeared in; failing
 * that, a coin flip, since we genuinely do not know.
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
      basis: `played ${Math.round(args.startRate * 100)}% of ${args.rounds} rounds`,
    };
  }
  return { probability: 0.5, basis: "no appearances yet" };
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
  /** The scoring record, when the payload or a snapshot carried one. */
  stats?: PlayerStats;
}

export interface EvaluateContext {
  form: Map<string, PlayerForm>;
  trends: Map<string, ValueTrend>;
  /** Keyed by real club id. */
  difficulty: Map<string, FixtureOutlook>;
  unavailable: Map<string, string>;
  startProbabilities: Map<string, number>;
}

export function evaluate(
  input: EvaluateInput,
  ctx: EvaluateContext,
): Evaluated {
  const notes: string[] = [];

  const fixture = input.clubId ? ctx.difficulty.get(input.clubId) : undefined;
  const difficulty = fixture?.difficulty ?? 0.5;

  // Per-round rows are the better evidence when they exist, because they carry
  // real minutes. They do not exist yet, so the scoring record carries this.
  const form = ctx.form.get(input.playerId);
  const stats = input.stats;

  let observed: number | null = null;
  let rounds = 0;
  let startRate: number | null = null;

  if (form && form.rounds > 0) {
    observed = form.avgPoints;
    rounds = form.rounds;
    startRate = form.startRate;
  } else if (stats) {
    observed = observedPointsPerStart(stats, fixture?.home);
    rounds = stats.matches;
    startRate =
      stats.fitness.length > 0 ? stats.matches / stats.fitness.length : null;
  }

  const pointsPerStart = shrinkPointsPerStart(input.role, observed, rounds);

  const unavailableReason = ctx.unavailable.get(input.playerId) ?? null;
  const { probability, basis } = startProbability({
    scraped: ctx.startProbabilities.get(input.playerId),
    startRate,
    rounds: stats?.fitness.length ?? rounds,
    unavailable: unavailableReason !== null,
  });

  const expectedPoints = probability * pointsPerStart * fixtureFactor(difficulty);

  const trend = ctx.trends.get(input.playerId);
  const valueDelta = trend?.delta ?? 0;

  if (unavailableReason) notes.push(unavailableReason);
  else notes.push(basis);

  if (rounds === 0) {
    notes.push("no scoring record yet");
  } else {
    notes.push(`${pointsPerStart.toFixed(1)} pts/start over ${rounds}`);
    if (stats) {
      const factor = formFactor(stats);
      if (factor > 1.05) notes.push("in form");
      else if (factor < 0.95) notes.push("off form");
    }
  }

  if (fixture?.opponent) {
    const label =
      difficulty < 0.45 ? "favourable" : difficulty > 0.65 ? "hard" : "even";
    const where = fixture.home ? "vs" : "away at";
    notes.push(`${label} ${where} ${fixture.opponent}`);
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
