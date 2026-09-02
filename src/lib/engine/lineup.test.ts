import { describe, expect, it } from "vitest";
import type { FutmondoRole } from "../futmondo/types";
import {
  diffLineup,
  parseFormation,
  parseFormations,
  pickLineup,
  FALLBACK_FORMATIONS,
} from "./lineup";
import type { Evaluated } from "./types";

function player(
  id: string,
  role: FutmondoRole,
  expectedPoints: number,
  overrides: Partial<Evaluated> = {},
): Evaluated {
  return {
    playerId: id,
    name: id,
    role,
    clubName: "Club",
    clubId: "c1",
    slug: null,
    value: 10_000_000,
    seasonPoints: 0,
    pointsPerStart: expectedPoints,
    startProbability: 1,
    fixtureDifficulty: 0.5,
    nextOpponent: null,
    unavailableReason: null,
    valueDelta: 0,
    sampleRounds: 5,
    expectedPoints,
    pointsPerMillion: expectedPoints / 10,
    ownerTeamId: "me",
    clausePrice: null,
    clauseLocked: null,
    notes: [],
    ...overrides,
  };
}

/** A squad deep enough to fill any legal shape. */
function fullSquad(): Evaluated[] {
  return [
    player("gk1", "POR", 5),
    player("gk2", "POR", 2),
    ...Array.from({ length: 5 }, (_, i) => player(`d${i}`, "DEF", 5 - i * 0.5)),
    ...Array.from({ length: 5 }, (_, i) => player(`m${i}`, "MED", 4 - i * 0.5)),
    ...Array.from({ length: 5 }, (_, i) => player(`f${i}`, "DEL", 8 - i * 0.5)),
  ];
}

describe("parseFormation", () => {
  it("reads an outfield-only label", () => {
    expect(parseFormation("4-3-3")).toEqual({
      label: "4-3-3",
      DEF: 4,
      MED: 3,
      DEL: 3,
    });
  });

  it("reads a label that includes the goalkeeper", () => {
    expect(parseFormation("1-4-4-2")).toEqual({
      label: "4-4-2",
      DEF: 4,
      MED: 4,
      DEL: 2,
    });
  });

  it("rejects anything that is not ten outfield players", () => {
    expect(parseFormation("4-4-4")).toBeNull();
    expect(parseFormation("4-3")).toBeNull();
    expect(parseFormation("nonsense")).toBeNull();
  });

  it("rejects shapes football does not allow", () => {
    expect(parseFormation("2-5-3")).toBeNull(); // too few defenders
    expect(parseFormation("5-5-0")).toBeNull(); // no forward
  });

  it("de-duplicates equivalent labels", () => {
    expect(parseFormations(["4-3-3", "1-4-3-3", "bogus"])).toEqual([
      { label: "4-3-3", DEF: 4, MED: 3, DEL: 3 },
    ]);
  });
});

describe("pickLineup", () => {
  it("selects the formation with the highest total, not a fixed default", () => {
    const squad = fullSquad();
    const pick = pickLineup(squad, FALLBACK_FORMATIONS);

    // Verify optimality directly: no other legal shape can score more.
    const bestPossible = Math.max(
      ...FALLBACK_FORMATIONS.map(
        (f) => pickLineup(squad, [f]).expectedPoints,
      ),
    );
    expect(pick.expectedPoints).toBeCloseTo(bestPossible, 10);
    expect(pick.incomplete).toBe(false);

    // Forwards dominate this squad, so the optimum fields all three.
    expect(pick.formation.DEL).toBe(3);
  });

  it("changes shape when the balance of the squad changes", () => {
    const midfieldHeavy = [
      player("gk1", "POR", 5),
      ...Array.from({ length: 5 }, (_, i) => player(`d${i}`, "DEF", 2 - i * 0.1)),
      ...Array.from({ length: 5 }, (_, i) => player(`m${i}`, "MED", 9 - i * 0.1)),
      ...Array.from({ length: 5 }, (_, i) => player(`f${i}`, "DEL", 2 - i * 0.1)),
    ];
    const pick = pickLineup(midfieldHeavy, FALLBACK_FORMATIONS);
    // The five best midfielders should all play, which only 4-5-1 allows here.
    expect(pick.formation.MED).toBe(5);
  });

  it("is exactly optimal for a fixed formation", () => {
    const pick = pickLineup(fullSquad(), [
      { label: "4-4-2", DEF: 4, MED: 4, DEL: 2 },
    ]);
    // Best keeper, best four defenders, best four midfielders, best two forwards.
    const expected = 5 + (5 + 4.5 + 4 + 3.5) + (4 + 3.5 + 3 + 2.5) + (8 + 7.5);
    expect(pick.expectedPoints).toBeCloseTo(expected, 5);
  });

  it("plays exactly one goalkeeper", () => {
    const pick = pickLineup(fullSquad());
    expect(pick.starters.filter((p) => p.role === "POR")).toHaveLength(1);
    expect(pick.starters).toHaveLength(11);
  });

  it("prefers a fit player over an injured one with a better projection", () => {
    const squad = [
      player("gk1", "POR", 5),
      ...Array.from({ length: 3 }, (_, i) => player(`d${i}`, "DEF", 4)),
      ...Array.from({ length: 4 }, (_, i) => player(`m${i}`, "MED", 4)),
      player("star", "DEL", 9, { unavailableReason: "injured" }),
      player("fit1", "DEL", 3),
      player("fit2", "DEL", 3),
      player("fit3", "DEL", 3),
    ];
    const pick = pickLineup(squad, [{ label: "3-4-3", DEF: 3, MED: 4, DEL: 3 }]);
    expect(pick.starters.map((p) => p.playerId)).not.toContain("star");
    expect(pick.excluded.map((p) => p.playerId)).toContain("star");
  });

  it("fields an injured player rather than leaving a slot empty", () => {
    // Only two fit forwards exist, so 3-4-3 must use the injured one: an empty
    // slot scores zero, an unfit body might not.
    const squad = [
      player("gk1", "POR", 5),
      ...Array.from({ length: 3 }, (_, i) => player(`d${i}`, "DEF", 4)),
      ...Array.from({ length: 4 }, (_, i) => player(`m${i}`, "MED", 4)),
      player("hurt", "DEL", 2, { unavailableReason: "injured" }),
      player("fit1", "DEL", 3),
      player("fit2", "DEL", 3),
    ];
    const pick = pickLineup(squad, [{ label: "3-4-3", DEF: 3, MED: 4, DEL: 3 }]);
    expect(pick.starters.map((p) => p.playerId)).toContain("hurt");
    expect(pick.incomplete).toBe(false);
    expect(pick.summary).toMatch(/no replacement/);
  });

  it("prefers a fillable shape over an unfillable one with better slots", () => {
    // No forwards at all: 4-5-1 cannot be filled, so a shape needing fewer
    // must win even though its occupied slots score less.
    const squad = [
      player("gk1", "POR", 5),
      ...Array.from({ length: 5 }, (_, i) => player(`d${i}`, "DEF", 6)),
      ...Array.from({ length: 5 }, (_, i) => player(`m${i}`, "MED", 6)),
    ];
    const pick = pickLineup(squad, [
      { label: "5-4-1", DEF: 5, MED: 4, DEL: 1 },
      { label: "5-3-2", DEF: 5, MED: 3, DEL: 2 },
    ]);
    // Both are unfillable, but the one needing only a single forward is least bad.
    expect(pick.formation.label).toBe("5-4-1");
    expect(pick.incomplete).toBe(true);
    expect(pick.shortfall.DEL).toBe(1);
    expect(pick.summary).toMatch(/short of 1 DEL/);
  });

  it("reports no lineup for an empty squad instead of throwing", () => {
    const pick = pickLineup([]);
    expect(pick.starters).toEqual([]);
    expect(pick.incomplete).toBe(true);
    expect(pick.summary).toMatch(/No squad data/);
  });

  it("falls back to the standard shapes when given none", () => {
    const pick = pickLineup(fullSquad(), []);
    expect(pick.starters).toHaveLength(11);
  });

  it("benches the best players left over, excluding the unfit", () => {
    const squad = [...fullSquad(), player("hurt", "MED", 9, { unavailableReason: "injured" })];
    const pick = pickLineup(squad, [{ label: "4-4-2", DEF: 4, MED: 4, DEL: 2 }]);
    expect(pick.bench.every((p) => !p.unavailableReason)).toBe(true);
    expect(pick.excluded.map((p) => p.playerId)).toContain("hurt");
  });
});

describe("diffLineup", () => {
  it("returns nothing when the current XI is already the best one", () => {
    const pick = pickLineup(fullSquad());
    const ids = pick.starters.map((p) => p.playerId);
    expect(diffLineup(ids, pick)).toEqual([]);
  });

  it("pairs each player coming in with the one going out", () => {
    const pick = pickLineup(fullSquad(), [
      { label: "4-4-2", DEF: 4, MED: 4, DEL: 2 },
    ]);
    // Swap the weakest chosen midfielder for a benched one.
    const current = pick.starters.map((p) => p.playerId);
    const benched = pick.bench[0];
    current[current.length - 1] = benched.playerId;

    const changes = diffLineup(current, pick);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].playerIn.playerId).not.toBe(changes[0].playerOut.playerId);
  });

  it("explains a change caused by an injury in the injured player's terms", () => {
    const squad = [
      player("gk1", "POR", 5),
      ...Array.from({ length: 4 }, (_, i) => player(`d${i}`, "DEF", 4)),
      ...Array.from({ length: 4 }, (_, i) => player(`m${i}`, "MED", 4)),
      player("hurt", "DEL", 6, { unavailableReason: "injured" }),
      player("fit1", "DEL", 3),
      player("fit2", "DEL", 3),
    ];
    const pick = pickLineup(squad, [{ label: "4-4-2", DEF: 4, MED: 4, DEL: 2 }]);
    const current = [
      ...pick.starters.filter((p) => p.role !== "DEL").map((p) => p.playerId),
      "hurt",
      "fit1",
    ];

    const changes = diffLineup(current, pick);
    expect(changes.some((c) => c.reason.includes("injured"))).toBe(true);
  });

  it("orders changes by how much they gain", () => {
    const pick = pickLineup(fullSquad(), [
      { label: "4-4-2", DEF: 4, MED: 4, DEL: 2 },
    ]);
    const current = pick.starters.map((p) => p.playerId);
    current[current.length - 1] = pick.bench[0].playerId;
    current[current.length - 2] = pick.bench[1].playerId;

    const changes = diffLineup(current, pick);
    for (let i = 1; i < changes.length; i += 1) {
      expect(changes[i - 1].gain).toBeGreaterThanOrEqual(changes[i].gain);
    }
  });
});
