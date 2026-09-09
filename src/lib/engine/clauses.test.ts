/**
 * The clause window, and the fact that lock state cannot be read.
 *
 * Both of these produced advice that was confidently wrong rather than
 * missing: 55 "take this clause now" candidates and 15 "block this now"
 * recommendations, on a day when no clause in the league could be paid by
 * anybody, and with an audit log containing no lock row in the app's history.
 */
import { describe, expect, it } from "vitest";
import type { RivalFunds } from "../db/repo";
import { clauseOpen, runClauses, type ClauseContext } from "./clauses";
import { DEFAULT_RULES, type Evaluated } from "./types";

const NOW = new Date("2026-09-04T12:00:00.000Z");
/** Our whole squad shares this date: the draft instant plus five days. */
const OPENS_LATER = "2026-09-07T18:05:10.923Z";
const OPENED_ALREADY = "2026-09-02T18:05:10.923Z";

function player(over: Partial<Evaluated> = {}): Evaluated {
  return {
    playerId: "p1",
    name: "Player",
    role: "DEF",
    clubName: "Club",
    clubId: "c1",
    slug: null,
    value: 10_000_000,
    seasonPoints: 0,
    pointsPerStart: 5,
    startProbability: 1,
    fixtureDifficulty: 0.5,
    nextOpponent: null,
    unavailableReason: null,
    availability: "fit",
    valueDelta: 0,
    sampleRounds: 3,
    expectedPoints: 5,
    pointsPerMillion: 0.5,
    ownerTeamId: "me",
    clausePrice: null,
    clauseLocked: null,
    clauseDate: null,
    suggestedClause: null,
    onMarket: false,
    askPrice: null,
    notes: [],
    ...over,
  };
}

function rival(estimatedFunds: number): RivalFunds {
  return {
    teamId: "rival",
    teamName: "Rival FC",
    estimatedFunds,
    spent: 0,
    received: 0,
    prizes: 0,
    ledgerRows: 0,
  };
}

function context(over: Partial<ClauseContext> = {}): ClauseContext {
  const mine = player({ playerId: "mine", clausePrice: 5_000_000 });
  return {
    allPlayers: [mine],
    squad: [mine],
    starterIds: new Set(["mine"]),
    myTeamId: "me",
    funds: 200_000_000,
    teamValue: 100_000_000,
    rules: DEFAULT_RULES,
    rivalFunds: [rival(50_000_000)],
    teamNames: new Map([["rival", "Rival FC"]]),
    now: NOW,
    ...over,
  };
}

describe("clauseOpen", () => {
  it("is false while the clause date is in the future", () => {
    expect(clauseOpen(OPENS_LATER, NOW)).toBe(false);
  });

  it("is true once the date has passed", () => {
    expect(clauseOpen(OPENED_ALREADY, NOW)).toBe(true);
  });

  it("treats an unknown date as open", () => {
    // The field only arrives with a per-player summary. Refusing to act without
    // it would silently disable clause advice for most of the league.
    expect(clauseOpen(null, NOW)).toBe(true);
    expect(clauseOpen(undefined, NOW)).toBe(true);
    expect(clauseOpen("not a date", NOW)).toBe(true);
  });
});

describe("runClauses and the clause window", () => {
  it("does not offer a steal whose clause is not payable yet", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      clausePrice: 5_000_000,
      clauseDate: OPENS_LATER,
      expectedPoints: 9,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals).toHaveLength(0);
    expect(report.pendingSteals).toHaveLength(1);
    // Reported rather than dropped: a bargain unlocking in three days is
    // planning information.
    expect(report.pendingSteals[0].availableFrom).toBe(OPENS_LATER);
    expect(report.pendingSteals[0].reason).toMatch(/Not payable until/);
  });

  it("offers the same steal once the window has opened", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      clausePrice: 5_000_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 9,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals).toHaveLength(1);
    expect(report.pendingSteals).toHaveLength(0);
  });

  it("does not recommend blocking a player nobody can take today", () => {
    const mine = player({
      playerId: "mine",
      clausePrice: 5_000_000,
      clauseDate: OPENS_LATER,
    });
    const report = runClauses(
      context({ allPlayers: [mine], squad: [mine], starterIds: new Set(["mine"]) }),
    );

    expect(report.toLock).toHaveLength(0);
    // But it must say when that changes, so the block happens before the
    // window opens rather than after.
    expect(report.windowNote).toMatch(/None of your squad can be claused until/);
    expect(report.windowNote).toContain("2026-09-07");
  });

  it("recommends blocking once the window is open and a rival can pay", () => {
    const mine = player({
      playerId: "mine",
      clausePrice: 5_000_000,
      clauseDate: OPENED_ALREADY,
    });
    const report = runClauses(
      context({ allPlayers: [mine], squad: [mine], starterIds: new Set(["mine"]) }),
    );

    expect(report.toLock.map((e) => e.player.playerId)).toEqual(["mine"]);
    expect(report.windowNote).toBeNull();
  });

  it("does not recommend blocking a player no rival can afford", () => {
    const mine = player({
      playerId: "mine",
      clausePrice: 90_000_000,
      clauseDate: OPENED_ALREADY,
    });
    const report = runClauses(
      context({ allPlayers: [mine], squad: [mine], starterIds: new Set(["mine"]) }),
    );
    expect(report.toLock).toHaveLength(0);
    expect(report.exposed[0].reason).toMatch(/no rival is estimated/);
  });
});

describe("runClauses and lock observability", () => {
  const mine = player({
    playerId: "mine",
    clausePrice: 5_000_000,
    clauseDate: OPENED_ALREADY,
  });

  it("treats a player we have already blocked as blocked", () => {
    // No payload carries lock state, so our own audit log is the only record.
    // Without this the same top targets are re-locked every single day.
    const report = runClauses(
      context({
        allPlayers: [mine],
        squad: [mine],
        starterIds: new Set(["mine"]),
        lockedPlayerIds: new Set(["mine"]),
      }),
    );

    expect(report.toLock).toHaveLength(0);
    expect(report.exposed[0].alreadyLocked).toBe(true);
    expect(report.exposed[0].reason).toBe("Blocked, so safe.");
  });

  it("still blocks a player with no lock row", () => {
    const report = runClauses(
      context({
        allPlayers: [mine],
        squad: [mine],
        starterIds: new Set(["mine"]),
        lockedPlayerIds: new Set(["somebody-else"]),
      }),
    );
    expect(report.toLock.map((e) => e.player.playerId)).toEqual(["mine"]);
  });
});

describe("runClauses and the suggested clause", () => {
  it("compares the asking clause against Futmondo's own valuation", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      clausePrice: 9_627_619,
      suggestedClause: 5_000_341,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 9,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals[0].overSuggested).toBe(9_627_619 - 5_000_341);
    expect(report.steals[0].reason).toMatch(/above Futmondo's suggested clause/);
  });

  it("says nothing about it when Futmondo has not suggested one", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      clausePrice: 5_000_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 9,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals[0].overSuggested).toBeNull();
    expect(report.steals[0].reason).not.toMatch(/suggested clause/);
  });
});

describe("a steal whose clause window has never been read", () => {
  it("is still offered, but says the window is unread", () => {
    // Treating an unknown date as closed would disable clause advice for every
    // player we have not yet fetched a summary for -- which is most of the
    // league. Treating it as open silently would tee up a payment that
    // Futmondo may simply refuse. So it is offered, with the gap stated.
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      clausePrice: 5_000_000,
      clauseDate: null,
      expectedPoints: 9,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals).toHaveLength(1);
    expect(report.steals[0].clauseDateKnown).toBe(false);
    expect(report.steals[0].reason).toMatch(/has not been read yet/);
  });

  it("says nothing of the sort once the date is known", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      clausePrice: 5_000_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 9,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals[0].clauseDateKnown).toBe(true);
    expect(report.steals[0].reason).not.toMatch(/has not been read yet/);
  });
});

describe("findClauseBets", () => {
  it("detects a rising-value player whose clause stays pinned", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 18_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_320_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(1);
    const bet = report.trendBets[0];
    expect(bet.player.playerId).toBe("target");
    expect(bet.ratio).toBeCloseTo(0.83, 2);
    expect(bet.discount).toBe(-3_000_000);
    // trendScore 3.32 + ratioScore 1.75
    expect(bet.opportunity).toBeCloseTo(5.07, 2);
    expect(bet.reason).toContain("above today's value");
    expect(bet.reason).toContain("Value up 3.32M€ in the last week");
    expect(bet.reason).not.toMatch(/free money|giveaway|discount by any standard/i);
  });

  it("states plainly when the clause already sits under value", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 12_500_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 4_310_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(1);
    expect(report.trendBets[0].ratio).toBeGreaterThanOrEqual(1);
    expect(report.trendBets[0].discount).toBe(2_500_000);
    expect(report.trendBets[0].reason).toContain("under today's value");
  });

  it("excludes players whose value is not rising", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 0,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(0);
  });

  it("excludes a clause so far above value that no trend justifies it", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 10_000_000,
      clausePrice: 25_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_000_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    // ratio 0.4 is below BET_RATIO_MIN (0.7)
    expect(report.trendBets).toHaveLength(0);
  });

  it("excludes locked players", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseLocked: true,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_000_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(0);
  });

  it("excludes own players", () => {
    const mine = player({
      playerId: "mine",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_000_000,
    });
    const report = runClauses(context({ allPlayers: [mine] }));

    expect(report.trendBets).toHaveLength(0);
  });

  it("excludes players without a clause", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: null,
      valueDelta: 3_000_000,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(0);
  });

  it("never ranks a rising bet as a current discount", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 18_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_320_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    const bet = report.trendBets[0];
    expect(bet.discount).toBeLessThan(0);
    // The honest signal is the trend, never a claim that the clause is cheap
    // today.
    expect(bet.reason).toMatch(/payoff is future value/);
    expect(bet.reason).toMatch(/pays only if value keeps rising/);
  });

  it("marks expensive clauses as not affordable", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 18_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_320_000,
      expectedPoints: 5,
    });
    // funds of 5M < 18M clause
    const report = runClauses(
      context({
        allPlayers: [target],
        funds: 5_000_000,
        teamValue: 0,
      }),
    );

    expect(report.trendBets).toHaveLength(1);
    expect(report.trendBets[0].affordable).toBe(false);
    expect(report.trendBets[0].reason).toMatch(/beyond the/);
  });

  it("gates on clause.date for pending bets", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENS_LATER,
      valueDelta: 3_000_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(1);
    expect(report.trendBets[0].availableFrom).toBe(OPENS_LATER);
    expect(report.trendBets[0].reason).toMatch(/Not payable until/);
  });

  it("sorts by opportunity descending", () => {
    // B: strong trend and clause already below value -> high score
    const strong = player({
      playerId: "strong",
      ownerTeamId: "rival",
      value: 12_500_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 4_310_000,
      expectedPoints: 5,
    });
    // A: same-scale trend but clause 20% above value -> lower score
    const weakerGap = player({
      playerId: "weakerGap",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 18_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_320_000,
      expectedPoints: 5,
    });
    const report = runClauses(
      context({ allPlayers: [strong, weakerGap] }),
    );

    expect(report.trendBets).toHaveLength(2);
    expect(report.trendBets[0].opportunity).toBeGreaterThanOrEqual(
      report.trendBets[1].opportunity,
    );
    expect(report.trendBets[0].player.playerId).toBe("strong");
  });

  it("treats the trend minimum as exclusive, so noise never sneaks in", () => {
    // valueDelta exactly at BET_TREND_MIN_DELTA (250k) must not qualify.
    const boundary = player({
      playerId: "boundary",
      ownerTeamId: "rival",
      value: 14_000_000,
      clausePrice: 20_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 250_000,
      expectedPoints: 5,
    });
    const atLimit = runClauses(context({ allPlayers: [boundary] }));
    expect(atLimit.trendBets).toHaveLength(0);

    // One euro more qualifies.
    const justOver = runClauses(
      context({
        allPlayers: [
          player({ ...boundary, playerId: "justOver", valueDelta: 251_000 }),
        ],
      }),
    );
    expect(justOver.trendBets).toHaveLength(1);
    expect(justOver.trendBets[0].player.playerId).toBe("justOver");
  });

  it("treats the ratio minimum as inclusive, and any hair below it misses", () => {
    // value/clause = 14/20 = 0.70 exactly -> BET_RATIO_MIN qualifies.
    const atMin = player({
      playerId: "atMin",
      ownerTeamId: "rival",
      value: 14_000_000,
      clausePrice: 20_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 1_000_000,
      expectedPoints: 5,
    });
    const reportAt = runClauses(context({ allPlayers: [atMin] }));
    expect(reportAt.trendBets).toHaveLength(1);

    const justBelow = runClauses(
      context({
        allPlayers: [
          player({
            ...atMin,
            playerId: "justBelow",
            value: 13_990_000,
          }),
        ],
      }),
    );
    expect(justBelow.trendBets).toHaveLength(0);
  });

  it("caps opportunity so a huge trend cannot inflate a bet forever", () => {
    // ratio 3 (>= 1 -> ratioScore 3) and valueDelta 9M (clamped to 4).
    const huge = player({
      playerId: "huge",
      ownerTeamId: "rival",
      value: 30_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 9_000_000,
      expectedPoints: 5,
    });
    // Same ratio, valueDelta only just over the 4M clamp point.
    const justAtCap = player({
      ...huge,
      playerId: "justAtCap",
      valueDelta: 4_000_000,
    });
    const report = runClauses(
      context({ allPlayers: [huge, justAtCap] }),
    );

    const h = report.trendBets.find((b) => b.player.playerId === "huge");
    const c = report.trendBets.find((b) => b.player.playerId === "justAtCap");
    expect(h).toBeDefined();
    expect(c).toBeDefined();
    expect(h!.opportunity).toBe(7);
    expect(c!.opportunity).toBe(7);
  });

  it("gives a floor score to a qualifying bet, never zero and never inflated", () => {
    // Just past both minimums: delta 251k (0.251 score) + ratio 0.7 (0.75).
    const floor = player({
      playerId: "floor",
      ownerTeamId: "rival",
      value: 14_000_000,
      clausePrice: 20_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 251_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [floor] }));

    expect(report.trendBets).toHaveLength(1);
    expect(report.trendBets[0].opportunity).toBeCloseTo(1.0, 2);
    expect(report.trendBets[0].opportunity).toBeLessThanOrEqual(2);
  });

  it("flags an unread clause window instead of guessing it is open", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 18_000_000,
      clauseDate: null,
      valueDelta: 3_320_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.trendBets).toHaveLength(1);
    expect(report.trendBets[0].clauseDateKnown).toBe(false);
    expect(report.trendBets[0].availableFrom).toBeNull();
    expect(report.trendBets[0].reason).toMatch(
      /Clause window has not been read yet.*check the date in Futmondo before paying/,
    );
  });

  it("treats funds exactly equal to the clause as affordable", () => {
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_320_000,
      expectedPoints: 5,
    });
    const report = runClauses(
      context({
        allPlayers: [target],
        funds: 10_000_000,
        teamValue: 0,
      }),
    );

    expect(report.trendBets).toHaveLength(1);
    expect(report.trendBets[0].affordable).toBe(true);
    expect(report.trendBets[0].reason).not.toMatch(/beyond the/);
  });
});
