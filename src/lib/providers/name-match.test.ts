import { describe, expect, it } from "vitest";
import { NameMatcher, normalizeName, type Candidate } from "./name-match";

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
