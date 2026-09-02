import type { RosterPlayer } from "../futmondo/types";
import { LINEUP_WEIGHTS, playerFromRoster, scorePlayer } from "./scoring";
import type { ScoredPlayer } from "./types";

export type Formation = [number, number, number, number]; // GK, DEF, MED, DEL

export const DEFAULT_FORMATION: Formation = [1, 4, 3, 3];

export interface LineupResult {
  formation: Formation;
  players: ScoredPlayer[];
  bench: ScoredPlayer[];
  injuredExcluded: ScoredPlayer[];
  lineupMessage: string;
}

export interface LineupContext {
  roster: RosterPlayer[];
  formation?: Formation;
  fixtureDifficulty?: Record<string, { difficulty: number }>;
  requireFullIfPossible?: boolean;
}

export function runLineup(ctx: LineupContext): LineupResult {
  const formation = ctx.formation ?? DEFAULT_FORMATION;
  const { fixtureDifficulty = {} } = ctx;
  const [gkN, defN, medN, delN] = formation;

  const scored = ctx.roster.map((p) => {
    const input = playerFromRoster(p);
    const fd = fixtureDifficulty[p.team]?.difficulty ?? 0.5;
    input.fixtureDifficulty = fd;
    return scorePlayer(input, LINEUP_WEIGHTS[p.role]);
  });

  const byRole = (role: string) =>
    scored
      .filter((p) => p.role === role)
      .sort((a, b) => b.score - a.score);

  const pick = (role: string, n: number): ScoredPlayer[] => {
    const pool = byRole(role);
    const healthy = pool.filter((p) => p.injuryRisk < 0.5);
    const chosen = healthy.slice(0, n);
    if (chosen.length < n) {
      chosen.push(...pool.filter((p) => p.injuryRisk >= 0.5).slice(0, n - chosen.length));
    }
    return chosen;
  };

  const gk = pick("POR", gkN);
  const def = pick("DEF", defN);
  const med = pick("MED", medN);
  const del = pick("DEL", delN);

  const players = [...gk, ...def, ...med, ...del];
  const chosenIds = new Set(players.map((p) => p.id));
  const bench = scored.filter((p) => !chosenIds.has(p.id)).slice(0, 4);
  const injuredExcluded = scored
    .filter((p) => p.injuryRisk >= 0.5 && !chosenIds.has(p.id))
    .map((p) => p);

  const formationStr = formation.join("-");
  let lineupMessage: string;
  if (players.length < gkN + defN + medN + delN) {
    lineupMessage = `Insufficient players for ${formationStr}; fielding the best available.`;
  } else {
    const injuredCount = injuredExcluded.length;
    lineupMessage = injuredCount
      ? `Suggested ${formationStr} — ${injuredCount} injured player${injuredCount > 1 ? "s" : ""} excluded from the XI.`
      : `Suggested ${formationStr} based on form, fixtures and injuries.`;
  }

  return {
    formation,
    players,
    bench,
    injuredExcluded,
    lineupMessage,
  };
}
