/**
 * Write actions.
 *
 * Two things are automated, chosen because both are cheap to get wrong and
 * trivial to undo:
 *
 *   - Setting the lineup. Costs nothing, and a wrong XI can be changed again
 *     before kickoff.
 *   - Blocking a clause on our own player. Costs nothing and is reversible
 *     with /5/userteam/unlockplayer.
 *
 * Everything that spends money — bids, clause payments, sales — stays manual
 * by design. Those are irreversible, and a bug in a price calculation would
 * spend real budget with no way back.
 *
 * One deliberate limitation: the automated writer never changes formation.
 * Futmondo's formation-change payload could not be established with certainty
 * from the client bundle, and guessing a write shape risks corrupting a
 * lineup. So automation optimises within whatever formation is already set,
 * and a better shape is reported as something for you to switch by hand.
 */
import * as repo from "../db/repo";
import type { FutmondoClient, Scope } from "../futmondo/client";
import { FutmondoError } from "../futmondo/errors";
import type { CurrentLineup } from "../futmondo/types";
import type { ExposedPlayer } from "./clauses";
import { parseFormation, pickLineup, type Formation, type LineupPick } from "./lineup";
import type { Evaluated } from "./types";

export interface ApplyLineupResult {
  applied: boolean;
  /** Swaps actually written to Futmondo. */
  moves: { inName: string; outName: string; gain: number }[];
  /** Set when a different formation would score better than the current one. */
  betterFormation: { label: string; gain: number } | null;
  skippedReason: string | null;
  errors: string[];
}

/**
 * Rewrites the XI to the best selection available inside the current
 * formation, then commits it.
 *
 * Swaps are performed as pitch-slot to bench-slot moves via
 * /2/userteam/moveplayer, which has a shape we could verify, rather than the
 * bulk /5/userteam/multichanges call, which does not.
 */
export async function applyLineup(args: {
  client: FutmondoClient;
  scope: Scope;
  squad: Evaluated[];
  currentLineup: CurrentLineup;
  availableFormations: Formation[];
  /** Only write when the gain clears this many expected points. */
  minGain?: number;
  dryRun?: boolean;
}): Promise<ApplyLineupResult> {
  const {
    client,
    scope,
    squad,
    currentLineup,
    availableFormations,
    minGain = 0.5,
    dryRun = false,
  } = args;

  const errors: string[] = [];
  const result: ApplyLineupResult = {
    applied: false,
    moves: [],
    betterFormation: null,
    skippedReason: null,
    errors,
  };

  const currentFormation = currentLineup.strategy
    ? parseFormation(currentLineup.strategy)
    : null;

  if (!currentFormation) {
    result.skippedReason = currentLineup.strategy
      ? `Could not interpret the current formation "${currentLineup.strategy}".`
      : "Futmondo did not report a current formation.";
    return result;
  }

  // What we would do without touching the shape, and what a free choice of
  // shape would give us, so the difference can be reported.
  const inShape = pickLineup(squad, [currentFormation]);
  const unconstrained = pickLineup(squad, availableFormations);
  if (
    unconstrained.formation.label !== currentFormation.label &&
    unconstrained.expectedPoints > inShape.expectedPoints + minGain
  ) {
    result.betterFormation = {
      label: unconstrained.formation.label,
      gain: unconstrained.expectedPoints - inShape.expectedPoints,
    };
  }

  const moves = planMoves(currentLineup, inShape);
  if (moves.length === 0) {
    result.skippedReason = "The lineup already matches the best selection.";
    return result;
  }

  const totalGain = moves.reduce((sum, m) => sum + m.gain, 0);
  if (totalGain < minGain) {
    result.skippedReason = `Best available change is worth only ${totalGain.toFixed(
      2,
    )} expected points, below the ${minGain} threshold.`;
    return result;
  }

  if (dryRun) {
    result.moves = moves.map((m) => ({
      inName: m.inName,
      outName: m.outName,
      gain: m.gain,
    }));
    result.skippedReason = "Dry run — nothing was written.";
    return result;
  }

  for (const move of moves) {
    try {
      await client.movePlayer(
        scope,
        { position: move.fromPosition, bench: false },
        { position: move.toPosition, bench: true },
      );
      result.moves.push({
        inName: move.inName,
        outName: move.outName,
        gain: move.gain,
      });
    } catch (err) {
      errors.push(
        `Could not swap ${move.outName} for ${move.inName}: ${message(err)}`,
      );
    }
  }

  if (result.moves.length === 0) {
    result.skippedReason = "Every swap failed, so nothing was saved.";
    await log("lineup", scope, { moves: 0 }, false, errors.join("; "));
    return result;
  }

  // Moves are staged until this call; without it nothing persists.
  try {
    await client.saveLineup(scope);
    result.applied = true;
  } catch (err) {
    errors.push(`Lineup changes were staged but the save failed: ${message(err)}`);
    await log("lineup", scope, { moves: result.moves.length }, false, message(err));
    return result;
  }

  await log(
    "lineup",
    scope,
    { formation: currentFormation.label, moves: result.moves, gain: totalGain },
    true,
  );
  return result;
}

interface PlannedMove {
  fromPosition: number;
  toPosition: number;
  inName: string;
  outName: string;
  gain: number;
}

/**
 * Pairs each starter who should drop out with the substitute who should
 * replace them, best gain first, matching by role so a swap is always legal.
 */
function planMoves(current: CurrentLineup, pick: LineupPick): PlannedMove[] {
  const wanted = new Map(pick.starters.map((p) => [p.playerId, p]));
  const byId = new Map(
    [...pick.starters, ...pick.bench, ...pick.excluded].map((p) => [p.playerId, p]),
  );

  // Starters Futmondo has that we do not want, worst first.
  const dropping = current.players
    .filter((slot) => !wanted.has(slot.playerId) && slot.position !== undefined)
    .map((slot) => ({ slot, player: byId.get(slot.playerId) }))
    .sort(
      (a, b) =>
        (a.player?.expectedPoints ?? 0) - (b.player?.expectedPoints ?? 0),
    );

  // Players we want who are currently on the bench, best first.
  const promoting = current.bench
    .filter((slot) => wanted.has(slot.playerId) && slot.position !== undefined)
    .map((slot) => ({ slot, player: wanted.get(slot.playerId) }))
    .sort(
      (a, b) =>
        (b.player?.expectedPoints ?? 0) - (a.player?.expectedPoints ?? 0),
    );

  const moves: PlannedMove[] = [];
  const usedBench = new Set<string>();

  for (const out of dropping) {
    // Roles are disjoint in this league, so only a same-role swap is legal.
    const match = promoting.find(
      (candidate) =>
        !usedBench.has(candidate.slot.playerId) &&
        candidate.player?.role === out.player?.role,
    );
    if (!match || !match.player || !out.player) continue;

    usedBench.add(match.slot.playerId);
    moves.push({
      fromPosition: out.slot.position as number,
      toPosition: match.slot.position as number,
      inName: match.player.name,
      outName: out.player.name,
      gain: match.player.expectedPoints - out.player.expectedPoints,
    });
  }

  return moves.sort((a, b) => b.gain - a.gain);
}

export interface LockResult {
  locked: { playerId: string; name: string; reason: string }[];
  errors: string[];
}

/**
 * Blocks clauses on the players most worth protecting. Free, reversible, and
 * unlimited in this league, so the only judgement is which players are
 * genuinely exposed.
 */
export async function applyLocks(args: {
  client: FutmondoClient;
  scope: Scope;
  exposed: ExposedPlayer[];
  max?: number;
  dryRun?: boolean;
}): Promise<LockResult> {
  const { client, scope, exposed, max = 5, dryRun = false } = args;
  const result: LockResult = { locked: [], errors: [] };

  const targets = exposed
    .filter((e) => !e.alreadyLocked && e.threats.length > 0)
    .slice(0, max);

  for (const target of targets) {
    if (dryRun) {
      result.locked.push({
        playerId: target.player.playerId,
        name: target.player.name,
        reason: target.reason,
      });
      continue;
    }
    try {
      await client.lockPlayer(scope.championshipId, target.player.playerId);
      result.locked.push({
        playerId: target.player.playerId,
        name: target.player.name,
        reason: target.reason,
      });
      await log("lock", scope, { playerId: target.player.playerId, name: target.player.name }, true);
    } catch (err) {
      result.errors.push(`Could not block ${target.player.name}: ${message(err)}`);
      await log(
        "lock",
        scope,
        { playerId: target.player.playerId },
        false,
        message(err),
      );
    }
  }

  return result;
}

function message(err: unknown): string {
  if (err instanceof FutmondoError) return err.code ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Audit every write, so an automated change is always traceable. */
async function log(
  action: string,
  scope: Scope,
  detail: unknown,
  ok: boolean,
  error?: string,
): Promise<void> {
  try {
    await repo.logAction({ action, target: scope.userteamId, detail, ok, error });
  } catch {
    // An unwritable audit log must not fail the action it describes.
  }
}
