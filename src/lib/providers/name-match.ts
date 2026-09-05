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

/**
 * Letters Unicode decomposition does not take apart.
 *
 * NFD splits "í" into "i" plus a combining accent, but "ø", "æ", "ß", "đ" and
 * "ł" are single letters with no decomposition, so stripping combining marks
 * leaves them intact and the punctuation filter then turns them into spaces.
 * That is why "Sørloth" normalised to "s rloth" and never matched the scraped
 * "Sorloth" — a whole class of Nordic and Slavic names failing silently.
 */
const TRANSLITERATIONS: Record<string, string> = {
  ø: "o",
  æ: "ae",
  å: "a",
  ß: "ss",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
  œ: "oe",
};

/** Strips accents, punctuation and case so "Martínez" and "Martinez" agree. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[øæåßđðþłıœ]/g, (ch) => TRANSLITERATIONS[ch] ?? ch)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Name particles. Too short to be surnames on their own, but they belong to the
 * surname that follows: "de Jong" is one name, and dropping the "de" left
 * "jong" as a bare token that only ever reached the weakest, lowest-confidence
 * strategy — which the 0.8 confidence floor then threw away. Ten of the
 * thirty-eight unmatched names were this.
 */
const PARTICLES = new Set([
  "de", "del", "la", "las", "los", "el", "van", "von", "der", "den", "da",
  "das", "dos", "di", "du", "al", "bin", "ben", "mc", "mac", "st",
]);

/**
 * Tokens worth matching on: every word of three letters or more, plus each
 * particle glued to the word after it, so "de jong" is indexed as "dejong"
 * as well as "jong".
 */
export function significantTokens(name: string): string[] {
  const words = normalizeName(name).split(" ").filter(Boolean);
  const tokens: string[] = [];

  for (const [index, word] of words.entries()) {
    if (word.length >= 3) tokens.push(word);
    const next = words[index + 1];
    if (PARTICLES.has(word) && next) tokens.push(word + next);
  }
  return [...new Set(tokens)];
}

export interface Candidate {
  playerId: string;
  name: string;
  teamName: string | null;
}

export type MatchStrategy =
  | "override"
  | "exact"
  | "contained"
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
  private readonly tokensById = new Map<string, string[]>();
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
      const tokens = significantTokens(candidate.name);
      this.tokensById.set(candidate.playerId, tokens);
      for (const token of tokens) {
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

    // One source writes the full name and the other writes part of it:
    // "Pablo Gavi" against "Gavi", "Frenkie de Jong" against "De Jong". If one
    // name's tokens are wholly contained in the other's and exactly one
    // candidate fits, that is a real match rather than a coincidence — and it
    // is the case the old bare-surname strategy scored at 0.6, which the 0.8
    // confidence floor then discarded.
    //
    // Only for a query of two or more tokens. A single word contained in one
    // candidate name is exactly the bare-surname guess this is not: "Nico"
    // uniquely matching "Nico Williams" is a coincidence, and a wrong match
    // benches a fit starter, which is worse than no match at all.
    const contained =
      tokens.length >= 2 ? this.containedCandidates(tokens) : [];
    if (contained.length === 1) {
      return {
        playerId: contained[0].playerId,
        candidateName: contained[0].name,
        strategy: "contained",
        confidence: 0.9,
      };
    }
    if (contained.length > 1 && teamName) {
      const sameTeam = contained.filter((c) => teamsAgree(c.teamName, teamName));
      if (sameTeam.length === 1) {
        return {
          playerId: sameTeam[0].playerId,
          candidateName: sameTeam[0].name,
          strategy: "contained",
          confidence: 0.95,
        };
      }
    }

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

  /**
   * Candidates whose token set is a subset of the query's, or the reverse.
   *
   * Only candidates sharing at least one token are considered, so this is a
   * lookup rather than a scan of the whole league.
   */
  private containedCandidates(queryTokens: string[]): Candidate[] {
    if (queryTokens.length === 0) return [];
    const query = new Set(queryTokens);
    const seen = new Set<string>();
    const out: Candidate[] = [];

    for (const token of queryTokens) {
      for (const candidate of this.bySurname.get(token) ?? []) {
        if (seen.has(candidate.playerId)) continue;
        seen.add(candidate.playerId);

        const candidateTokens = this.tokensById.get(candidate.playerId) ?? [];
        if (candidateTokens.length === 0) continue;

        const candidateInQuery = candidateTokens.every((t) => query.has(t));
        const queryInCandidate = queryTokens.every((t) =>
          candidateTokens.includes(t),
        );
        if (candidateInQuery || queryInCandidate) out.push(candidate);
      }
    }
    return out;
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
