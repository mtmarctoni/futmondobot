import { describe, expect, it } from "vitest";
import {
  NameMatcher,
  normalizeName,
  significantTokens,
  type Candidate,
} from "./name-match";

const SQUAD: Candidate[] = [
  { playerId: "p1", name: "Antonio Martínez", teamName: "Alavés" },
  { playerId: "p2", name: "Pablo Gavi", teamName: "Barcelona" },
  { playerId: "p3", name: "Frenkie de Jong", teamName: "Barcelona" },
  { playerId: "p4", name: "Álvaro Morata", teamName: "Atlético de Madrid" },
  // Two players sharing a surname, at different clubs.
  { playerId: "p5", name: "Carlos Soler", teamName: "Real Sociedad" },
  { playerId: "p6", name: "Ferran Soler", teamName: "Valencia" },
];

describe("normalizeName", () => {
  it("strips accents and case", () => {
    expect(normalizeName("Álvaro Morata")).toBe("alvaro morata");
    expect(normalizeName("MARTÍNEZ")).toBe("martinez");
  });

  it("collapses punctuation and whitespace", () => {
    expect(normalizeName("  N'Golo   Kanté ")).toBe("n golo kante");
  });
});

describe("NameMatcher", () => {
  it("matches an identical name exactly", () => {
    const matcher = new NameMatcher(SQUAD);
    expect(matcher.match("Pablo Gavi")).toMatchObject({
      playerId: "p2",
      strategy: "exact",
      confidence: 1,
    });
  });

  it("matches across accent differences", () => {
    const matcher = new NameMatcher(SQUAD);
    expect(matcher.match("Alvaro Morata")?.playerId).toBe("p4");
  });

  it("uses the club to separate a shared surname", () => {
    const matcher = new NameMatcher(SQUAD);
    const result = matcher.match("Soler", "Valencia");
    expect(result).toMatchObject({ playerId: "p6", strategy: "team-and-surname" });
  });

  it("tolerates differently written club names", () => {
    const matcher = new NameMatcher(SQUAD);
    // The source writes "Atlético"; the squad holds "Atlético de Madrid".
    expect(matcher.match("Morata", "Atlético")?.playerId).toBe("p4");
  });

  it("accepts a league-unique surname but marks it lower confidence", () => {
    const matcher = new NameMatcher(SQUAD);
    const result = matcher.match("Gavi");
    expect(result).toMatchObject({ playerId: "p2", strategy: "unique-surname" });
    expect(result?.confidence).toBeLessThan(1);
  });

  it("refuses an ambiguous surname with no club to disambiguate", () => {
    const matcher = new NameMatcher(SQUAD);
    expect(matcher.match("Soler")).toBeNull();
  });

  it("lets an override win over every other strategy", () => {
    const matcher = new NameMatcher(SQUAD, {
      overrides: { "Toni Martinez": "p1" },
    });
    expect(matcher.match("Toni Martinez")).toMatchObject({
      playerId: "p1",
      strategy: "override",
      confidence: 1,
    });
  });

  it("falls through to normal matching when an override names a missing player", () => {
    const matcher = new NameMatcher(SQUAD, {
      overrides: { "Toni Martinez": "does-not-exist" },
    });
    // A stale override must not disable matching altogether: the surname still
    // resolves, just at the lower confidence that strategy carries.
    expect(matcher.match("Toni Martinez")).toMatchObject({
      playerId: "p1",
      strategy: "unique-surname",
    });
  });

  it("collects unmatched names for manual overrides instead of guessing", () => {
    const matcher = new NameMatcher(SQUAD);
    matcher.match("Totally Unknown Player", "Elche");
    matcher.match("Soler");
    expect(matcher.unmatched).toEqual([
      { name: "Totally Unknown Player", teamName: "Elche" },
      { name: "Soler", teamName: null },
    ]);
  });

  it("ignores short particles when matching on tokens", () => {
    const matcher = new NameMatcher(SQUAD);
    // "de" must not match "de Jong" via a two-letter token.
    expect(matcher.match("Jong", "Barcelona")?.playerId).toBe("p3");
  });
});

/**
 * The thirty-eight names that never matched.
 *
 * `{scraped: 67, matched: 19, lowConfidenceDropped: 10}` — a 28% hit rate on
 * ordinary names, which is a matcher problem rather than a data problem. Each
 * case below is one of the real failures, with the Futmondo spelling on the
 * left and the scraped spelling on the right.
 */
describe("NameMatcher against the real failures", () => {
  const REAL: Candidate[] = [
    { playerId: "sorloth", name: "Alexander Sørloth", teamName: "Atlético de Madrid" },
    { playerId: "dejong", name: "De Jong", teamName: "Barcelona" },
    { playerId: "gavi", name: "Gavi", teamName: "Barcelona" },
    { playerId: "serrano", name: "Nico Serrano", teamName: "Athletic Club" },
    { playerId: "williams", name: "Nico Williams", teamName: "Athletic Club" },
  ];

  it("matches a name whose letter Unicode does not decompose", () => {
    // "ø" has no NFD decomposition, so stripping combining marks left it
    // intact and the punctuation filter turned it into a space: "s rloth".
    const matcher = new NameMatcher(REAL);
    expect(matcher.match("Alexander Sorloth", "Atlético")?.playerId).toBe("sorloth");
  });

  it("normalises the whole family of them", () => {
    expect(normalizeName("Sørloth")).toBe("sorloth");
    expect(normalizeName("Håland")).toBe("haland");
    expect(normalizeName("Łukasz")).toBe("lukasz");
    expect(normalizeName("Weiß")).toBe("weiss");
  });

  it("matches across a name particle", () => {
    // "de" is two letters, so it was dropped as insignificant and "Frenkie de
    // Jong" reduced to a bare "jong" — which only ever reached the weakest
    // strategy, at a confidence the 0.8 floor then discarded.
    const matcher = new NameMatcher(REAL);
    const result = matcher.match("Frenkie de Jong", "Barcelona");
    expect(result?.playerId).toBe("dejong");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("matches a full name against a mononym", () => {
    const matcher = new NameMatcher(REAL);
    const result = matcher.match("Pablo Gavi", "Barcelona");
    expect(result?.playerId).toBe("gavi");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("separates two players sharing a given name", () => {
    const matcher = new NameMatcher(REAL);
    expect(matcher.match("Nico Serrano", "Athletic Club")?.playerId).toBe("serrano");
    expect(matcher.match("Nico Williams", "Athletic Club")?.playerId).toBe("williams");
  });

  it("still refuses a bare given name that could be either of them", () => {
    // A wrong match benches a fit starter, which is worse than no match, so a
    // single token contained in one candidate stays a low-confidence guess.
    const matcher = new NameMatcher(REAL);
    const result = matcher.match("Nico", "Athletic Club");
    expect(result === null || result.confidence < 0.8).toBe(true);
  });
});

describe("significantTokens", () => {
  it("keeps a particle glued to the name it belongs to", () => {
    expect(significantTokens("Frenkie de Jong")).toContain("dejong");
    expect(significantTokens("Frenkie de Jong")).toContain("jong");
  });

  it("does not emit a bare particle as a token of its own", () => {
    expect(significantTokens("Frenkie de Jong")).not.toContain("de");
  });
});
