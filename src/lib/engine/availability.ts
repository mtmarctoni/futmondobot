/**
 * How available a player is, graded rather than binary.
 *
 * Futmondo reports several different absences under one field and they do not
 * mean the same thing. `injured` and `redcard` are certainties: the player
 * will not appear. `doubt` is a fitness question that most often resolves into
 * the player starting anyway. Treating the two alike forced three of a fifteen
 * player squad to zero expected points, which left ten fit outfield players for
 * eleven shirts -- so no formation could be filled, `pickLineup` took the least
 * bad incomplete shape, and the market advice offered to sell a fit 17M forward
 * as "dead capital".
 *
 * So the model carries a severity and a multiplier applied to whatever start
 * probability the player would otherwise have had. A doubtful player who starts
 * 90% of the time is a better bet than a fit player who starts 30% of the time,
 * and a boolean cannot express that.
 *
 * One rule matters more than the mapping: **an unrecognised reason degrades a
 * projection, it never deletes a player.** A new Futmondo wording must not be
 * able to silently empty a position, which is the failure this file exists to
 * prevent.
 */

export type Availability = "out" | "doubt" | "fit";

export interface Unavailability {
  /** Futmondo's own wording, or ours for a departure. Shown to the user. */
  reason: string;
  severity: Availability;
  /** Multiplies the start probability. 0 for out, 1 for fit. */
  multiplier: number;
}

/**
 * How much of their normal start chance a doubtful player keeps.
 *
 * A guess. Nothing in the data supports a specific number yet -- it wants the
 * share of `doubt` players who actually started, measured over several rounds
 * from `points[].initialLineUp`, and that record only started being collected
 * with IMP-1. Named and kept next to FORM_SWING so it can be tuned once that
 * evidence exists rather than being buried in an expression.
 */
export const DOUBT_MULTIPLIER = 0.45;

/**
 * Reasons that mean a certain absence. Matched as substrings on the lowercased
 * reason, because Futmondo mixes `injured` and `injured2`, and the departure
 * check writes a sentence rather than a keyword.
 */
const OUT_MARKERS = [
  "injured",
  "injury",
  "lesion",
  "redcard",
  "red_card",
  "sanction",
  "suspend",
  "sancion",
  "no longer in the competition",
];

/** Reasons that mean a fitness question rather than an absence. */
const DOUBT_MARKERS = ["doubt", "duda", "questionable"];

/**
 * Values of the roster/market `status` field that are positive markers rather
 * than absences. `"ok"` appears on a player returning to fitness, and reading
 * it as unavailable would bench exactly the players who have just recovered.
 */
const FIT_MARKERS = ["ok", "fit", "available", "none"];

const FIT: Unavailability = { reason: "", severity: "fit", multiplier: 1 };

/**
 * Grades one reason string. Returns null when the player is fit, so callers can
 * keep using "is there an entry for this player" as the availability test.
 */
export function classify(reason: string | null | undefined): Unavailability | null {
  const raw = reason?.trim();
  if (!raw) return null;

  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (FIT_MARKERS.includes(norm)) return null;
  if (OUT_MARKERS.some((m) => norm.includes(m))) {
    return { reason: raw, severity: "out", multiplier: 0 };
  }
  if (DOUBT_MARKERS.some((m) => norm.includes(m))) {
    return { reason: raw, severity: "doubt", multiplier: DOUBT_MULTIPLIER };
  }

  // Deliberately not `out`. An unknown wording is a wording we have not seen,
  // not a certainty about a player -- see the header.
  return { reason: raw, severity: "doubt", multiplier: DOUBT_MULTIPLIER };
}

/** Convenience for the many callers that only hold a reason string. */
export function severityOf(reason: string | null | undefined): Availability {
  return classify(reason)?.severity ?? "fit";
}

export function multiplierOf(reason: string | null | undefined): number {
  return classify(reason)?.multiplier ?? FIT.multiplier;
}

/**
 * Grades a whole map of reasons at once, dropping the entries that turn out to
 * be positive markers. `getCurrentUnavailability` and the `status` field both
 * arrive in this shape.
 */
export function classifyAll(
  reasons: ReadonlyMap<string, string>,
): Map<string, Unavailability> {
  const out = new Map<string, Unavailability>();
  for (const [playerId, reason] of reasons) {
    const graded = classify(reason);
    if (graded) out.set(playerId, graded);
  }
  return out;
}

/**
 * Merges a second opinion into a graded map, keeping the more severe reading.
 *
 * The roster `status` field and the per-club injury endpoint disagree in both
 * directions: `status` covers market listings the club endpoint never reaches,
 * while the club endpoint names the reason more precisely. Neither is a
 * superset, so the cautious answer wins and the more specific wording is kept
 * when the severities tie.
 */
export function mergeAvailability(
  base: ReadonlyMap<string, Unavailability>,
  extra: ReadonlyMap<string, Unavailability>,
): Map<string, Unavailability> {
  const RANK: Record<Availability, number> = { fit: 0, doubt: 1, out: 2 };
  const out = new Map(base);
  for (const [playerId, graded] of extra) {
    const prev = out.get(playerId);
    if (!prev || RANK[graded.severity] > RANK[prev.severity]) {
      out.set(playerId, graded);
    }
  }
  return out;
}

/** Wording for the user: "doubtful" reads better than the raw `doubt`. */
export function describeAvailability(entry: Unavailability): string {
  if (entry.severity === "doubt") {
    const reason = entry.reason.toLowerCase();
    return DOUBT_MARKERS.some((m) => reason.includes(m))
      ? "doubtful"
      : `doubtful (${entry.reason})`;
  }
  return entry.reason;
}
