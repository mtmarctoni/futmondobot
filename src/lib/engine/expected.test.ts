import { describe, expect, it } from "vitest";
import type { PlayerForm, ValueTrend } from "../db/repo";
import type { PlayerStats } from "../futmondo/types";
import {
  appearances,
  evaluate,
  fixtureFactor,
  formFactor,
  observedPointsPerStart,
  shrinkPointsPerStart,
  startProbability,
  type EvaluateContext,
} from "./expected";

function stats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return { average: 5, matches: 3, fitness: [5, 5, 5], ...overrides };
}

function fixture(overrides: Partial<import("../db/repo").FixtureOutlook> = {}) {
  return {
    difficulty: 0.5,
    kickoff: null,
    opponent: "Rival",
    home: true,
    basis: "odds" as const,
    ...overrides,
  };
}

function context(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return {
    form: new Map(),
    trends: new Map(),
    difficulty: new Map(),
    unavailable: new Map(),
    startProbabilities: new Map(),
    ...overrides,
  };
}

const BASE = {
  playerId: "p1",
  name: "Player",
  role: "DEL" as const,
  clubName: "Club",
  clubId: "c1",
  slug: null,
  value: 20_000_000,
  seasonPoints: 40,
  ownerTeamId: "me",
  clausePrice: null,
  clauseLocked: null,
};

function form(overrides: Partial<PlayerForm> = {}): PlayerForm {
  return {
    playerId: "p1",
    avgPoints: 8,
    avgMinutes: 90,
    rounds: 5,
    measuredRounds: 0,
    startRate: 1,
    ...overrides,
  };
}

describe("fixtureFactor", () => {
  it("is neutral for an even fixture", () => {
    expect(fixtureFactor(0.5)).toBeCloseTo(1, 10);
  });

  it("rewards an easy fixture and penalises a hard one, symmetrically", () => {
    expect(fixtureFactor(0)).toBeCloseTo(1.2, 10);
    expect(fixtureFactor(1)).toBeCloseTo(0.8, 10);
  });

  it("clamps input outside 0..1", () => {
    expect(fixtureFactor(-5)).toBeCloseTo(1.2, 10);
    expect(fixtureFactor(5)).toBeCloseTo(0.8, 10);
  });
});

describe("shrinkPointsPerStart", () => {
  it("uses the role prior when there is no history", () => {
    expect(shrinkPointsPerStart("DEL", null, 0)).toBe(5);
    expect(shrinkPointsPerStart("POR", null, 0)).toBe(4);
  });

  it("discounts a single spectacular round towards the prior", () => {
    const oneRound = shrinkPointsPerStart("DEL", 20, 1);
    expect(oneRound).toBeLessThan(20);
    expect(oneRound).toBeGreaterThan(5);
  });

  it("trusts the observation more as evidence accumulates", () => {
    const few = shrinkPointsPerStart("DEL", 20, 1);
    const many = shrinkPointsPerStart("DEL", 20, 10);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThan(20);
  });

  it("never exceeds the observed value", () => {
    expect(shrinkPointsPerStart("DEL", 20, 100)).toBeLessThanOrEqual(20);
  });
});

describe("startProbability", () => {
  it("is zero for an unavailable player, whatever else is known", () => {
    const result = startProbability({
      scraped: 0.9,
      startRate: 1,
      rounds: 10,
      unavailable: true,
    });
    expect(result.probability).toBe(0);
    expect(result.basis).toMatch(/injured or suspended/);
  });

  it("prefers a scraped probable-XI figure", () => {
    const result = startProbability({
      scraped: 0.3,
      startRate: 1,
      rounds: 10,
      unavailable: false,
    });
    expect(result.probability).toBeCloseTo(0.3, 10);
    expect(result.basis).toMatch(/probable XI 30%/);
  });

  it("falls back to recent minutes, shrunk towards even odds", () => {
    const result = startProbability({
      scraped: undefined,
      startRate: 1,
      rounds: 2,
      unavailable: false,
    });
    // Two starts from two is suggestive, not certain.
    expect(result.probability).toBeGreaterThan(0.5);
    expect(result.probability).toBeLessThan(1);
    expect(result.basis).toMatch(/played 100% of 2 rounds/);
  });

  it("admits ignorance when there is no data at all", () => {
    const result = startProbability({
      scraped: undefined,
      startRate: null,
      rounds: 0,
      unavailable: false,
    });
    expect(result.probability).toBe(0.5);
    expect(result.basis).toMatch(/no appearances yet/);
  });
});

describe("evaluate", () => {
  it("multiplies start chance, points per start and fixture factor", () => {
    const player = evaluate(
      BASE,
      context({
        form: new Map([["p1", form()]]),
        startProbabilities: new Map([["p1", 1]]),
        difficulty: new Map([["c1", { difficulty: 0.5, kickoff: null, opponent: "Rival", home: true, basis: "odds" as const }]]),
      }),
    );
    // 5 rounds of 8 points shrinks to 8*5/7 + 5*2/7, times 1.0 fixture factor.
    const expectedPps = (8 * 5) / 7 + (5 * 2) / 7;
    expect(player.pointsPerStart).toBeCloseTo(expectedPps, 6);
    expect(player.expectedPoints).toBeCloseTo(expectedPps, 6);
  });

  it("gives an unavailable player zero expected points", () => {
    const player = evaluate(
      BASE,
      context({
        form: new Map([["p1", form()]]),
        unavailable: new Map([["p1", "injured"]]),
      }),
    );
    expect(player.expectedPoints).toBe(0);
    expect(player.unavailableReason).toBe("injured");
    expect(player.notes).toContain("injured");
  });

  it("scales expected points down for a hard fixture", () => {
    const ctx = (difficulty: number) =>
      context({
        form: new Map([["p1", form()]]),
        startProbabilities: new Map([["p1", 1]]),
        difficulty: new Map([["c1", { difficulty, kickoff: null, opponent: "Rival", home: true, basis: "odds" as const }]]),
      });
    const easy = evaluate(BASE, ctx(0.1)).expectedPoints;
    const hard = evaluate(BASE, ctx(0.9)).expectedPoints;
    expect(easy).toBeGreaterThan(hard);
  });

  it("assumes an even fixture when the club has no scheduled match", () => {
    const player = evaluate(BASE, context({ form: new Map([["p1", form()]]) }));
    expect(player.fixtureDifficulty).toBe(0.5);
  });

  it("computes points per million from value", () => {
    const player = evaluate(
      { ...BASE, value: 20_000_000 },
      context({
        form: new Map([["p1", form({ avgPoints: 7, rounds: 100 })]]),
        startProbabilities: new Map([["p1", 1]]),
      }),
    );
    expect(player.pointsPerMillion).toBeCloseTo(player.expectedPoints / 20, 6);
  });

  it("does not divide by zero for a valueless player", () => {
    const player = evaluate({ ...BASE, value: 0 }, context());
    expect(player.pointsPerMillion).toBe(0);
    expect(Number.isFinite(player.expectedPoints)).toBe(true);
  });

  it("notes a rising or falling value", () => {
    const rising: ValueTrend = {
      playerId: "p1",
      currentValue: 21_000_000,
      delta: 1_000_000,
      days: 7,
    };
    const player = evaluate(BASE, context({ trends: new Map([["p1", rising]]) }));
    expect(player.valueDelta).toBe(1_000_000);
    expect(player.notes.join(" ")).toMatch(/value rising/);
  });

  it("says so when there is no per-round history", () => {
    const player = evaluate(BASE, context());
    expect(player.sampleRounds).toBe(0);
    expect(player.notes.join(" ")).toMatch(/no scoring record yet/);
    // Still produces a usable projection from the role prior.
    expect(player.expectedPoints).toBeGreaterThan(0);
  });
});

describe("appearances", () => {
  it("treats a zero as a round missed, since an appearance always scores", () => {
    // Carles Aleñá, round 3: two appearances, one round out.
    expect(appearances(stats({ average: 4.1, matches: 2, fitness: [6, 2.2, 0] }))).toEqual([
      6, 2.2,
    ]);
  });

  it("refuses the reading when it disagrees with the match count", () => {
    // If a real zero is possible, the zero-means-absent inference is unsafe,
    // so form degrades to flat rather than reporting a wrong sample.
    expect(appearances(stats({ matches: 3, fitness: [5, 5, 0] }))).toBeNull();
  });

  it("has nothing to say before a round has been played", () => {
    expect(appearances(stats({ matches: 0, fitness: [] }))).toBeNull();
  });
});

describe("formFactor", () => {
  it("is neutral for a player scoring at their season rate", () => {
    expect(formFactor(stats({ matches: 4, fitness: [5, 5, 5, 5] }))).toBeCloseTo(1, 10);
  });

  it("lifts a player scoring better lately", () => {
    const f = formFactor(stats({ matches: 6, fitness: [2, 2, 2, 8, 8, 8] }));
    expect(f).toBeGreaterThan(1);
  });

  it("drops a player who has gone quiet", () => {
    const f = formFactor(stats({ matches: 6, fitness: [8, 8, 8, 2, 2, 2] }));
    expect(f).toBeLessThan(1);
  });

  it("caps the swing, because one big week is mostly luck", () => {
    const hot = formFactor(stats({ matches: 4, fitness: [1, 1, 1, 40] }));
    expect(hot).toBeLessThanOrEqual(1.25);
    const cold = formFactor(stats({ matches: 4, fitness: [20, 20, 20, 0.1] }));
    expect(cold).toBeGreaterThanOrEqual(0.75);
  });

  it("stays neutral on too thin a sample to tell form from noise", () => {
    expect(formFactor(stats({ matches: 2, fitness: [1, 9] }))).toBe(1);
  });
});

describe("observedPointsPerStart", () => {
  it("has nothing to say about a player who has not played", () => {
    expect(observedPointsPerStart(stats({ matches: 0, fitness: [] }), true)).toBeNull();
  });

  it("tilts towards the venue of the next fixture", () => {
    const s = stats({ average: 7.5, homeAverage: 7.15, awayAverage: 8.2, matches: 3 });
    const away = observedPointsPerStart(s, false)!;
    const home = observedPointsPerStart(s, true)!;
    expect(away).toBeGreaterThan(home);
    // Half weight on the split, which carries half the sample.
    expect(away).toBeCloseTo(0.5 * 8.2 + 0.5 * 7.5, 6);
  });

  it("ignores a venue average of zero, which means never played that side", () => {
    const s = stats({ average: 6, homeAverage: 0, matches: 3 });
    expect(observedPointsPerStart(s, true)).toBeCloseTo(6, 6);
  });

  it("falls back to the overall average when the venue is unknown", () => {
    const s = stats({ average: 6, homeAverage: 2, awayAverage: 10, matches: 3 });
    expect(observedPointsPerStart(s, undefined)).toBeCloseTo(6, 6);
  });
});

describe("evaluate with a live scoring record", () => {
  /**
   * The regression this whole model change exists for. `round_points` is empty
   * because /1/userteam/roundlineup returns no players even for closed rounds,
   * so form was always null and every player of a role scored the identical
   * role prior -- which is exactly what the lineup page showed.
   */
  it("separates two players of the same role on their actual scoring", () => {
    const ctx = context({ startProbabilities: new Map([["p1", 1]]) });
    const good = evaluate(
      { ...BASE, stats: stats({ average: 8.2, matches: 3, fitness: [10.4, 1.6, 11.5] }) },
      ctx,
    );
    const poor = evaluate(
      { ...BASE, stats: stats({ average: 1.7, matches: 1, fitness: [1.7] }) },
      ctx,
    );
    expect(good.expectedPoints).toBeGreaterThan(poor.expectedPoints);
    expect(good.sampleRounds).toBe(3);
    expect(good.notes.join(" ")).not.toMatch(/no scoring record/);
  });

  it("prefers per-round rows over the record when they ever arrive", () => {
    const player = evaluate(
      { ...BASE, stats: stats({ average: 1, matches: 5, fitness: [1, 1, 1, 1, 1] }) },
      context({
        form: new Map([["p1", form({ avgPoints: 9, rounds: 5 })]]),
        startProbabilities: new Map([["p1", 1]]),
      }),
    );
    // 9, not 1: real minutes beat a season average when both exist.
    expect(player.pointsPerStart).toBeGreaterThan(5);
  });

  it("reads the start rate off rounds missed", () => {
    const player = evaluate(
      { ...BASE, stats: stats({ average: 6, matches: 1, fitness: [6, 0, 0, 0] }) },
      context(),
    );
    // One appearance in four rounds is a substitute, not a starter.
    expect(player.startProbability).toBeLessThan(0.5);
  });

  it("still zeroes an injured player however well they were scoring", () => {
    const player = evaluate(
      { ...BASE, stats: stats({ average: 12, matches: 5, fitness: [12, 12, 12, 12, 12] }) },
      context({ unavailable: new Map([["p1", "injured"]]) }),
    );
    expect(player.expectedPoints).toBe(0);
  });

  it("penalises the same player for a harder opponent", () => {
    const s = stats({ average: 7, matches: 4, fitness: [7, 7, 7, 7] });
    const at = (difficulty: number) =>
      evaluate(
        { ...BASE, stats: s },
        context({
          startProbabilities: new Map([["p1", 1]]),
          difficulty: new Map([["c1", fixture({ difficulty })]]),
        }),
      );
    // Facing the league leaders must not look like facing the bottom club.
    expect(at(0.85).expectedPoints).toBeLessThan(at(0.2).expectedPoints);
  });

  it("names the opponent and says whether it is away", () => {
    const player = evaluate(
      { ...BASE, stats: stats() },
      context({
        difficulty: new Map([
          ["c1", fixture({ difficulty: 0.8, opponent: "Barcelona", home: false })],
        ]),
      }),
    );
    expect(player.notes.join(" ")).toMatch(/hard away at Barcelona/);
    expect(player.nextOpponent).toBe("Barcelona");
  });
});
