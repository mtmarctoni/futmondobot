/**
 * Matching third-party player names onto Futmondo player ids.
 *
 * This is the fragile seam in any external data source: FútbolFantasy writes
 * "Toni Martinez", Futmondo may hold "Antonio Martínez", and neither is wrong.
 * Rather than one clever fuzzy score, matching goes through ordered strategies
 * from most to least certain and reports which one fired, so a questionable
 * match is visible instead of silently trusted.
 *
 * Anything still unmatched is listed for a manual override rather than guessed.
 */

/** Strips accents, punctuation and case so "Martínez" and "Martinez" agree. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens long enough to be a surname rather than a particle like "de" or "la". */
function significantTokens(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .filter((t) => t.length >= 3);
}

export interface Candidate {
  playerId: string;
  name: string;
  teamName: string | null;
}

export type MatchStrategy =
  | "override"
  | "exact"
  | "team-and-surname"
  | "unique-surname";

export interface MatchResult {
  playerId: string;
  candidateName: string;
  strategy: MatchStrategy;
  /** How much to trust it: an override is certain, a bare surname is not. */
  confidence: number;
}

export interface MatcherOptions {
  /** Manual fixes, keyed by the external name. Always wins. */
  overrides?: Record<string, string>;
}

export class NameMatcher {
  private readonly byNormalized = new Map<string, Candidate[]>();
  private readonly bySurname = new Map<string, Candidate[]>();
  private readonly overrides: Map<string, string>;
  private readonly candidatesById = new Map<string, Candidate>();

  readonly unmatched: { name: string; teamName: string | null }[] = [];

  constructor(candidates: Candidate[], options: MatcherOptions = {}) {
    this.overrides = new Map(
      Object.entries(options.overrides ?? {}).map(([from, to]) => [
        normalizeName(from),
        to,
      ]),
    );

    for (const candidate of candidates) {
      this.candidatesById.set(candidate.playerId, candidate);

      const normalized = normalizeName(candidate.name);
      push(this.byNormalized, normalized, candidate);

      // Index every significant token, since sources disagree about which
      // part of a Spanish name is the "surname".
      for (const token of significantTokens(candidate.name)) {
        push(this.bySurname, token, candidate);
      }
    }
  }

  match(name: string, teamName?: string | null): MatchResult | null {
    const normalized = normalizeName(name);

    const overridden = this.overrides.get(normalized);
    if (overridden) {
      const candidate = this.candidatesById.get(overridden);
      if (candidate) {
        return {
          playerId: candidate.playerId,
          candidateName: candidate.name,
          strategy: "override",
          confidence: 1,
        };
      }
    }

    const exact = this.byNormalized.get(normalized);
    if (exact?.length === 1) {
      return {
        playerId: exact[0].playerId,
        candidateName: exact[0].name,
        strategy: "exact",
        confidence: 1,
      };
    }
    // Two players sharing a name are separable by club.
    if (exact && exact.length > 1 && teamName) {
      const sameTeam = exact.filter((c) => teamsAgree(c.teamName, teamName));
      if (sameTeam.length === 1) {
        return {
          playerId: sameTeam[0].playerId,
          candidateName: sameTeam[0].name,
          strategy: "exact",
          confidence: 0.95,
        };
      }
    }

    const tokens = significantTokens(name);

    // A shared surname plus the same club is strong evidence.
    if (teamName) {
      for (const token of tokens) {
        const bucket = this.bySurname.get(token) ?? [];
        const sameTeam = bucket.filter((c) => teamsAgree(c.teamName, teamName));
        if (sameTeam.length === 1) {
          return {
            playerId: sameTeam[0].playerId,
            candidateName: sameTeam[0].name,
            strategy: "team-and-surname",
            confidence: 0.85,
          };
        }
      }
    }

    // A surname unique across the whole league is usable, but flagged lower:
    // this is the strategy most likely to be wrong.
    for (const token of tokens) {
      const bucket = this.bySurname.get(token) ?? [];
      if (bucket.length === 1) {
        return {
          playerId: bucket[0].playerId,
          candidateName: bucket[0].name,
          strategy: "unique-surname",
          confidence: 0.6,
        };
      }
    }

    this.unmatched.push({ name, teamName: teamName ?? null });
    return null;
  }
}

/**
 * Club names differ between sources ("Atlético de Madrid" vs "Atlético"), so
 * agreement means one contains the other once normalised.
 */
function teamsAgree(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
