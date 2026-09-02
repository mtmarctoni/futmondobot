import { describe, expect, it } from "vitest";
import type { PlayerForm, ValueTrend } from "../db/repo";
import {
  evaluate,
  fixtureFactor,
  shrinkPointsPerStart,
  startProbability,
  type EvaluateContext,
} from "./expected";

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
    expect(result.basis).toMatch(/started 100% of last 2/);
  });

  it("admits ignorance when there is no data at all", () => {
    const result = startProbability({
      scraped: undefined,
      startRate: null,
      rounds: 0,
      unavailable: false,
    });
    expect(result.probability).toBe(0.5);
    expect(result.basis).toMatch(/no minutes data/);
  });
});

describe("evaluate", () => {
  it("multiplies start chance, points per start and fixture factor", () => {
    const player = evaluate(
      BASE,
      context({
        form: new Map([["p1", form()]]),
        startProbabilities: new Map([["p1", 1]]),
        difficulty: new Map([["c1", { difficulty: 0.5, kickoff: null, opponent: "Rival" }]]),
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
        difficulty: new Map([["c1", { difficulty, kickoff: null, opponent: "Rival" }]]),
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
    expect(player.notes.join(" ")).toMatch(/no per-round history/);
    // Still produces a usable projection from the role prior.
    expect(player.expectedPoints).toBeGreaterThan(0);
  });
});
