/**
 * The club ids and payload shapes here are captured from the live league, not
 * invented: the reference set is the twenty clubs the stored calendar actually
 * contains, and the departed player is the real case that prompted the check
 * -- Carlos Álvarez, still on the championship roster at 18.5M, with his club
 * pointing at América.
 */
import { describe, expect, it } from "vitest";
import { MIN_CLUBS, scanDepartures, type DepartureInput } from "./departed";

/** A slice of the real calendar, enough clubs to clear MIN_CLUBS. */
const LA_LIGA = new Map<string, string>([
  ["504e581e4d8bec9a670000c6", "Real Madrid"],
  ["504e581e4d8bec9a670000c7", "Barcelona"],
  ["504e581e4d8bec9a670000c8", "Atlético de Madrid"],
  ["504e581e4d8bec9a670000c9", "Athletic de Bilbao"],
  ["504e581e4d8bec9a670000ca", "Rayo Vallecano"],
  ["504e581e4d8bec9a670000cb", "Valencia"],
  ["504e581e4d8bec9a670000cc", "Betis"],
  ["504e581e4d8bec9a670000cd", "Getafe"],
  ["504e581e4d8bec9a670000ce", "Real Sociedad"],
  ["504e581e4d8bec9a670000cf", "Levante"],
  ["504e581e4d8bec9a670000d0", "Espanyol"],
  ["504e581e4d8bec9a670000d1", "Osasuna"],
  ["504e581e4d8bec9a670000d5", "Sevilla"],
  ["504e581e4d8bec9a670000d6", "Málaga"],
  ["504e581e4d8bec9a670000d8", "Deportivo de la Coruña"],
  ["504e581e4d8bec9a670000d9", "Celta de Vigo"],
  ["51b889b1e401a15f2c0000f0", "Elche"],
  ["51b890f5b986415a2c000012", "Villarreal"],
  ["52038563b8d07d930b00008a", "Alavés"],
  ["520e4ee4a776cc826b00004b", "Racing"],
]);

const CARLOS_ALVAREZ: DepartureInput = {
  playerId: "63a8cd87bfb65a271f11db10",
  name: "Carlos Álvarez",
  role: "MED",
  clubId: "5200250711398189070000b4",
  clubName: "América",
  value: 18_526_493,
  mine: true,
  onMarket: false,
  askPrice: null,
};

const UGRINIC: DepartureInput = {
  playerId: "68966a3623f462042dbe3298",
  name: "Ugrinic",
  role: "MED",
  clubId: "504e581e4d8bec9a670000cb",
  clubName: "Valencia",
  value: 2_712_052,
  mine: true,
};

function filler(count: number): DepartureInput[] {
  return Array.from({ length: count }, (_, i) => ({
    playerId: `filler-${i}`,
    name: `Filler ${i}`,
    role: "DEF" as const,
    clubId: "504e581e4d8bec9a670000c6",
    clubName: "Real Madrid",
    value: 1_000_000,
  }));
}

describe("scanDepartures", () => {
  it("flags a player whose club has no fixtures", () => {
    const scan = scanDepartures([CARLOS_ALVAREZ, UGRINIC], LA_LIGA);

    expect(scan.mine.map((p) => p.name)).toEqual(["Carlos Álvarez"]);
    expect(scan.reasons.get(CARLOS_ALVAREZ.playerId)).toBe(
      "no longer in the competition (now at América)",
    );
    expect(scan.warnings).toEqual([]);
  });

  it("leaves a player at a club that is still in the competition alone", () => {
    const scan = scanDepartures([UGRINIC], LA_LIGA);
    expect(scan.mine).toEqual([]);
    expect(scan.reasons.size).toBe(0);
  });

  it("names the new club in the reason, and copes when it is unknown", () => {
    const scan = scanDepartures(
      [{ ...CARLOS_ALVAREZ, clubName: null }],
      LA_LIGA,
    );
    expect(scan.reasons.get(CARLOS_ALVAREZ.playerId)).toBe(
      "no longer in the competition",
    );
  });

  it("reports departures for rivals' players too, but only ours as actionable", () => {
    const rival: DepartureInput = {
      playerId: "affengruber",
      name: "Affengruber",
      role: "DEF",
      clubId: "51cc11e501d64ad470000144",
      clubName: "Sturm Graz",
      value: 15_895_357,
    };
    const scan = scanDepartures([CARLOS_ALVAREZ, rival], LA_LIGA);

    // Both are known to have gone, which is what keeps the rival's player out
    // of the clause-steal candidates.
    expect([...scan.reasons.keys()].sort()).toEqual(
      ["63a8cd87bfb65a271f11db10", "affengruber"].sort(),
    );
    // Only ours can be sold.
    expect(scan.mine.map((p) => p.name)).toEqual(["Carlos Álvarez"]);
  });

  it("carries the listing state through, so it does not tell you to list twice", () => {
    const scan = scanDepartures(
      [{ ...CARLOS_ALVAREZ, onMarket: true, askPrice: 18_931_044 }],
      LA_LIGA,
    );
    expect(scan.mine[0].onMarket).toBe(true);
    expect(scan.mine[0].askPrice).toBe(18_931_044);
  });

  it("puts the most valuable departure first, because that is the bigger loss", () => {
    const cheap: DepartureInput = {
      ...CARLOS_ALVAREZ,
      playerId: "cheap",
      name: "Cheap",
      value: 1_000_000,
    };
    const scan = scanDepartures([cheap, CARLOS_ALVAREZ], LA_LIGA);
    expect(scan.mine.map((p) => p.name)).toEqual(["Carlos Álvarez", "Cheap"]);
  });

  it("flags nobody when the calendar is empty, and says why", () => {
    const scan = scanDepartures([CARLOS_ALVAREZ], new Map());
    expect(scan.mine).toEqual([]);
    expect(scan.reasons.size).toBe(0);
    expect(scan.warnings[0]).toMatch(/No fixtures stored/);
  });

  it("refuses to judge on a partial calendar", () => {
    const partial = new Map([...LA_LIGA].slice(0, MIN_CLUBS - 1));
    const scan = scanDepartures([CARLOS_ALVAREZ, UGRINIC], partial);
    expect(scan.mine).toEqual([]);
    expect(scan.warnings[0]).toMatch(/clubs in the stored calendar/);
  });

  it("refuses to fire when it would flag an implausible share of the league", () => {
    // A calendar synced for the wrong competition: every id is outside it.
    const wrongCompetition = new Map(
      Array.from({ length: 20 }, (_, i) => [`other-${i}`, `Other ${i}`]),
    );
    const scan = scanDepartures([...filler(30), CARLOS_ALVAREZ], wrongCompetition);

    expect(scan.mine).toEqual([]);
    expect(scan.reasons.size).toBe(0);
    expect(scan.warnings[0]).toMatch(/different competition/);
  });

  it("still fires on a handful of real departures in a full league", () => {
    // The live proportion: 7 departed out of 526.
    const scan = scanDepartures([...filler(519), CARLOS_ALVAREZ], LA_LIGA);
    expect(scan.mine.map((p) => p.name)).toEqual(["Carlos Álvarez"]);
  });

  it("treats a player with no club at all as unknown, not departed", () => {
    const scan = scanDepartures(
      [{ ...CARLOS_ALVAREZ, clubId: null, clubName: null }],
      LA_LIGA,
    );
    expect(scan.mine).toEqual([]);
    expect(scan.reasons.size).toBe(0);
    expect(scan.warnings).toEqual([]);
  });
});
