/**
 * Lineup selection.
 *
 * The previous version hardcoded 4-3-3. Futmondo tells us which formations a
 * championship permits, and the best XI often needs a different shape — three
 * in-form forwards and a thin defence should produce 3-4-3, not a fixed 4-3-3
 * with two passengers.
 *
 * Because this league disallows multiposition, roles are disjoint: for any
 * fixed formation the optimum is simply the top N by expected points in each
 * role. So evaluating every legal formation and keeping the best total is
 * exactly optimal, not a heuristic.
 */
import type { FutmondoRole } from "../futmondo/types";
import type { Evaluated } from "./types";

/** Outfield counts by role. Goalkeeper is always exactly one. */
export interface Formation {
  label: string;
  DEF: number;
  MED: number;
  DEL: number;
}

/**
 * Shapes Futmondo offers. Used only when `/5/strategy/availables` is
 * unreachable; the live list always wins.
 */
export const FALLBACK_FORMATIONS: Formation[] = [
  { label: "5-4-1", DEF: 5, MED: 4, DEL: 1 },
  { label: "5-3-2", DEF: 5, MED: 3, DEL: 2 },
  { label: "4-5-1", DEF: 4, MED: 5, DEL: 1 },
  { label: "4-4-2", DEF: 4, MED: 4, DEL: 2 },
  { label: "4-3-3", DEF: 4, MED: 3, DEL: 3 },
  { label: "3-5-2", DEF: 3, MED: 5, DEL: 2 },
  { label: "3-4-3", DEF: 3, MED: 4, DEL: 3 },
];

/**
 * Turns a Futmondo strategy string into role counts. Strategies are written
 * outfield-only ("4-3-3") or with the keeper ("1-4-3-3"); both are accepted,
 * and anything that does not describe ten outfield players is rejected.
 */
export function parseFormation(label: string): Formation | null {
  const parts = label
    .trim()
    .split("-")
    .map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;

  const outfield = parts.length === 4 && parts[0] === 1 ? parts.slice(1) : parts;
  if (outfield.length !== 3) return null;

  const [DEF, MED, DEL] = outfield;
  if (DEF + MED + DEL !== 10) return null;
  if (DEF < 3 || DEL < 1) return null;

  return { label: outfield.join("-"), DEF, MED, DEL };
}

export function parseFormations(labels: string[]): Formation[] {
  const seen = new Map<string, Formation>();
  for (const label of labels) {
    const formation = parseFormation(label);
    if (formation && !seen.has(formation.label)) seen.set(formation.label, formation);
  }
  return [...seen.values()];
}

export interface LineupPick {
  formation: Formation;
  /** The chosen XI, keeper first. */
  starters: Evaluated[];
  /** Best remaining players, ordered as substitutes should be. */
  bench: Evaluated[];
  /** Sum of the starters' expected points. */
  expectedPoints: number;
  /** Players left out only because they cannot play. */
  excluded: Evaluated[];
  /** True when the squad cannot fill this shape. */
  incomplete: boolean;
  /** Missing slots by role, when incomplete. */
  shortfall: Partial<Record<FutmondoRole, number>>;
  summary: string;
}

const BENCH_SIZE = 4;

function byExpected(a: Evaluated, b: Evaluated): number {
  if (b.expectedPoints !== a.expectedPoints) {
    return b.expectedPoints - a.expectedPoints;
  }
  // Break ties towards the player with more evidence, then higher value.
  if (b.sampleRounds !== a.sampleRounds) return b.sampleRounds - a.sampleRounds;
  return b.value - a.value;
}

/**
 * Best XI over every supplied formation.
 *
 * Selection is on expected points alone. It used to partition each role into
 * "fit" and "sidelined" and only reach for the second group as filler, which
 * was right while availability was a boolean and is actively harmful now that
 * it is graded: a player carrying a fitness doubt already has that doubt priced
 * into their projection, and sorting them behind every fit player double-counts
 * it. With three doubts in a fifteen-player squad that left ten fit outfield
 * players for eleven shirts, so no shape could be filled and a 0.0 body was
 * fielded.
 *
 * `out` players still sink to the bottom on their own, because a zero start
 * probability makes their expected points zero -- and Futmondo scores an empty
 * slot as zero too, so an unavailable body is still better than a gap.
 */
export function pickLineup(
  squad: Evaluated[],
  formations: Formation[] = FALLBACK_FORMATIONS,
): LineupPick {
  const pool = formations.length > 0 ? formations : FALLBACK_FORMATIONS;

  // Without an explicit guard this would return a shape "short of 1 POR, 5
  // DEF, 4 MED, 1 DEL", which is technically true and useless to read.
  if (squad.length === 0) {
    return {
      formation: pool[0],
      starters: [],
      bench: [],
      expectedPoints: 0,
      excluded: [],
      incomplete: true,
      shortfall: {},
      summary: "No squad data available.",
    };
  }

  const byRole = new Map<FutmondoRole, Evaluated[]>();
  for (const roleName of ["POR", "DEF", "MED", "DEL"] as FutmondoRole[]) {
    byRole.set(
      roleName,
      squad.filter((p) => p.role === roleName).sort(byExpected),
    );
  }

  let best: LineupPick | null = null;

  for (const formation of pool) {
    const need: Record<FutmondoRole, number> = {
      POR: 1,
      DEF: formation.DEF,
      MED: formation.MED,
      DEL: formation.DEL,
    };

    const starters: Evaluated[] = [];
    const shortfall: Partial<Record<FutmondoRole, number>> = {};

    for (const roleName of ["POR", "DEF", "MED", "DEL"] as FutmondoRole[]) {
      const candidates = byRole.get(roleName) ?? [];
      const chosen = candidates.slice(0, need[roleName]);
      starters.push(...chosen);
      const missing = need[roleName] - chosen.length;
      if (missing > 0) shortfall[roleName] = missing;
    }

    const expectedPoints = starters.reduce((sum, p) => sum + p.expectedPoints, 0);
    const incomplete = Object.keys(shortfall).length > 0;

    // A shape we cannot fill is worse than any we can, however good its
    // occupied slots look.
    const comparable = incomplete ? expectedPoints - 1000 : expectedPoints;
    const bestComparable = best
      ? best.incomplete
        ? best.expectedPoints - 1000
        : best.expectedPoints
      : -Infinity;

    if (comparable > bestComparable) {
      const chosenIds = new Set(starters.map((p) => p.playerId));
      const rest = squad.filter((p) => !chosenIds.has(p.playerId)).sort(byExpected);

      best = {
        formation,
        starters,
        // Excluded is now a statement about availability, not about selection:
        // a player left out purely because someone projects better belongs on
        // the bench, and only an availability problem is worth reporting.
        bench: rest.filter((p) => p.availability === "fit").slice(0, BENCH_SIZE),
        expectedPoints,
        excluded: rest.filter((p) => p.availability !== "fit"),
        incomplete,
        shortfall,
        summary: "",
      };
    }
  }

  if (!best) {
    return {
      formation: FALLBACK_FORMATIONS[0],
      starters: [],
      bench: [],
      expectedPoints: 0,
      excluded: [],
      incomplete: true,
      shortfall: {},
      summary: "No squad data available.",
    };
  }

  best.summary = describe(best);
  return best;
}

function describe(pick: LineupPick): string {
  if (pick.incomplete) {
    const gaps = Object.entries(pick.shortfall)
      .map(([roleName, count]) => `${count} ${roleName}`)
      .join(", ");
    return `Best available is ${pick.formation.label} but the squad is short of ${gaps}.`;
  }
  const base = `${pick.formation.label}, ${pick.expectedPoints.toFixed(1)} expected points`;

  // Only a certain absence is worth calling out. A doubt in the XI is a normal
  // selection whose projection is already discounted, and announcing it as an
  // emergency would undo the point of grading availability at all.
  const out = pick.starters.filter((p) => p.availability === "out");
  if (out.length > 0) {
    return `${base}. ${out.length} unfit player${out.length > 1 ? "s" : ""} fielded because there is no replacement.`;
  }
  const doubtful = pick.starters.filter((p) => p.availability === "doubt");
  if (doubtful.length > 0) {
    return `${base}. ${doubtful.length} carrying a fitness doubt.`;
  }
  return `${base}.`;
}

export interface LineupChange {
  playerIn: Evaluated;
  playerOut: Evaluated;
  gain: number;
  reason: string;
}

/**
 * Differences between the lineup Futmondo currently holds and the one we would
 * pick, expressed as swaps so the reason for each is visible.
 */
export function diffLineup(
  currentStarterIds: string[],
  pick: LineupPick,
): LineupChange[] {
  const current = new Set(currentStarterIds);

  const comingIn = pick.starters.filter((p) => !current.has(p.playerId)).sort(byExpected);
  const goingOut = [...pick.bench, ...pick.excluded]
    .filter((p) => current.has(p.playerId))
    .sort((a, b) => a.expectedPoints - b.expectedPoints);

  const changes: LineupChange[] = [];
  const pairs = Math.min(comingIn.length, goingOut.length);

  for (let i = 0; i < pairs; i += 1) {
    const playerIn = comingIn[i];
    const playerOut = goingOut[i];
    const gain = playerIn.expectedPoints - playerOut.expectedPoints;
    // Only a certain absence explains a change on its own. A doubt is priced
    // into the projection, so the honest reason for that swap is the points.
    const reason =
      playerOut.availability === "out" && playerOut.unavailableReason
        ? `${playerOut.name} is ${playerOut.unavailableReason}`
        : `${playerIn.name} projects ${gain.toFixed(1)} more points`;
    changes.push({ playerIn, playerOut, gain, reason });
  }

  // Anyone wanted but unmatched still needs flagging, e.g. after a formation
  // change alters how many slots a role has.
  for (let i = pairs; i < comingIn.length; i += 1) {
    changes.push({
      playerIn: comingIn[i],
      playerOut: comingIn[i],
      gain: comingIn[i].expectedPoints,
      reason: `${comingIn[i].name} should start under ${pick.formation.label}`,
    });
  }

  return changes.sort((a, b) => b.gain - a.gain);
}
