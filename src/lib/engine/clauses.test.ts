/**
 * The clause window, and the fact that lock state cannot be read.
 *
 * Both of these produced advice that was confidently wrong rather than
 * missing: 55 "take this clause now" candidates and 15 "block this now"
 * recommendations, on a day when no clause in the league could be paid by
 * anybody, and with an audit log containing no lock row in the app's history.
 * Blocking now costs 200 mondos a player a week, so defence is exposure
 * information only and there is no "recommended block" in the report to test.
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

  it("keeps a player whose window has not opened as exposure information, not a target", () => {
    const mine = player({
      playerId: "mine",
      clausePrice: 5_000_000,
      clauseDate: OPENS_LATER,
    });
    const report = runClauses(
      context({ allPlayers: [mine], squad: [mine], starterIds: new Set(["mine"]) }),
    );

    expect(report.exposed[0].availableFrom).toBe(OPENS_LATER);
    // The window note must say when the date changes, so a deadline is not a
    // surprise — but it does not say "block before then".
    expect(report.windowNote).toMatch(/None of your squad can be claused until/);
    expect(report.windowNote).toContain("2026-09-07");
  });

  it("lists an open, affordable player as exposed once the window has opened", () => {
    const mine = player({
      playerId: "mine",
      clausePrice: 5_000_000,
      clauseDate: OPENED_ALREADY,
    });
    const report = runClauses(
      context({ allPlayers: [mine], squad: [mine], starterIds: new Set(["mine"]) }),
    );

    const exposed = report.exposed.find((e) => e.player.playerId === "mine");
    expect(exposed).toBeDefined();
    expect(exposed?.availableFrom).toBeNull();
    expect(exposed?.threats.length).toBeGreaterThan(0);
    expect(report.windowNote).toBeNull();
  });

  it("does not list a player no rival can afford as exposed", () => {
    const mine = player({
      playerId: "mine",
      clausePrice: 90_000_000,
      clauseDate: OPENED_ALREADY,
    });
    const report = runClauses(
      context({ allPlayers: [mine], squad: [mine], starterIds: new Set(["mine"]) }),
    );
    expect(report.exposed[0].threats).toHaveLength(0);
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
    // No payload carries lock state, so our own audit log is the only record
    // that a block ever existed. It now feeds the blocked badge only: the
    // engine no longer writes locks, so there is no re-locking to guard.
    const report = runClauses(
      context({
        allPlayers: [mine],
        squad: [mine],
        starterIds: new Set(["mine"]),
        lockedPlayerIds: new Set(["mine"]),
      }),
    );

    expect(report.exposed[0].alreadyLocked).toBe(true);
    expect(report.exposed[0].reason).toBe("Blocked, so safe.");
  });

  it("is not treated as blocked in the absence of a lock row", () => {
    const report = runClauses(
      context({
        allPlayers: [mine],
        squad: [mine],
        starterIds: new Set(["mine"]),
        lockedPlayerIds: new Set(["somebody-else"]),
      }),
    );
    expect(report.exposed[0].alreadyLocked).toBe(false);
    expect(report.exposed[0].threats.length).toBeGreaterThan(0);
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

  it("excludes players whose value is not rising", () => {
    // Above the golden band, where the trend is the entire case for paying.
    const target = player({
      playerId: "target",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 18_000_000,
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
      clausePrice: 18_000_000,
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
    // B: strong trend and the smaller gap to close -> high score
    const strong = player({
      playerId: "strong",
      ownerTeamId: "rival",
      value: 12_500_000,
      clausePrice: 14_000_000,
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

  it("caps opportunity so a huge trend cannot inflate a score forever", () => {
    // ratio 3 (>= 1 -> ratioScore 3) and valueDelta 9M (clamped to 4). A ratio
    // that high is golden, so the capped score is read from that list.
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

    const h = report.golden.find((b) => b.player.playerId === "huge");
    const c = report.golden.find((b) => b.player.playerId === "justAtCap");
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
      value: 8_500_000,
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

/**
 * The golden tier: a clause the market has already overtaken.
 *
 * Live data on 2026-09-14 had 174 owned players with both a clause and a
 * value. Two sat strictly under value and two more within 2% of it, then the
 * field fell away to 0.85 — so this is a small, nameable set, not a gradient.
 * Every one of them was golden for the same reason: the owner priced the
 * clause once and the market repriced the player since. They were previously
 * scored by the same formula as a clause 30% above value, which weights the
 * trend above the gap, so the one case where nothing has to be believed about
 * the future ranked alongside the ones where everything does.
 */
describe("golden clauses", () => {
  it("classifies a clause under value as golden rather than a forward bet", () => {
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

    expect(report.golden).toHaveLength(1);
    expect(report.golden[0].player.playerId).toBe("target");
    expect(report.golden[0].tier).toBe("golden");
    expect(report.golden[0].discount).toBe(2_500_000);
    // Never in both lists: the page would render him twice, under two
    // different claims about the same clause.
    expect(report.trendBets).toHaveLength(0);
  });

  it("surfaces a golden clause with no rising trend behind it", () => {
    // The trend minimum exists to stop noise being sold as a bet. A clause
    // under value is not a bet, so the trend has nothing to say about it.
    const target = player({
      playerId: "flat",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 0,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.golden).toHaveLength(1);
    expect(report.golden[0].player.playerId).toBe("flat");
  });

  it("surfaces a golden clause on a player who would not improve the XI", () => {
    // findSteals needs an upgrade over a starter. Free value does not.
    const target = player({
      playerId: "bench",
      ownerTeamId: "rival",
      role: "DEF",
      value: 12_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 0,
      expectedPoints: 0.5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.steals).toHaveLength(0);
    expect(report.golden).toHaveLength(1);
  });

  it("treats the golden ratio as inclusive at 0.95, and a hair below stays a bet", () => {
    const atMin = player({
      playerId: "atMin",
      ownerTeamId: "rival",
      value: 9_500_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_000_000,
      expectedPoints: 5,
    });
    const reportAt = runClauses(context({ allPlayers: [atMin] }));
    expect(reportAt.golden).toHaveLength(1);
    expect(reportAt.trendBets).toHaveLength(0);

    const justBelow = runClauses(
      context({
        allPlayers: [
          player({ ...atMin, playerId: "justBelow", value: 9_490_000 }),
        ],
      }),
    );
    expect(justBelow.golden).toHaveLength(0);
    expect(justBelow.trendBets).toHaveLength(1);
    expect(justBelow.trendBets[0].tier).toBe("trend");
  });

  it("orders golden by how far the clause lags value, best first", () => {
    const lagging = player({
      playerId: "lagging",
      ownerTeamId: "rival",
      value: 10_920_000,
      clausePrice: 9_870_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 5,
    });
    const level = player({
      playerId: "level",
      ownerTeamId: "rival",
      value: 20_330_000,
      clausePrice: 20_780_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [level, lagging] }));

    expect(report.golden.map((g) => g.player.playerId)).toEqual([
      "lagging",
      "level",
    ]);
  });

  it("puts a golden clause you can pay ahead of one you cannot", () => {
    const rich = player({
      playerId: "rich",
      ownerTeamId: "rival",
      value: 60_000_000,
      clausePrice: 50_000_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 5,
    });
    const cheap = player({
      playerId: "cheap",
      ownerTeamId: "rival",
      value: 10_400_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
      expectedPoints: 5,
    });
    const report = runClauses(
      context({ allPlayers: [rich, cheap], funds: 20_000_000, teamValue: 0 }),
    );

    expect(report.golden.map((g) => g.player.playerId)).toEqual([
      "cheap",
      "rich",
    ]);
    expect(report.golden[0].affordable).toBe(true);
    expect(report.golden[1].affordable).toBe(false);
  });

  it("says the clause is under value when it is", () => {
    const target = player({
      playerId: "under",
      ownerTeamId: "rival",
      value: 10_920_000,
      clausePrice: 9_870_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 3_380_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.golden[0].reason).toContain("under his own market value");
    expect(report.golden[0].reason).toContain("Value up 3.38M€");
    // The payoff is here today, so the bet wording must not follow it around.
    expect(report.golden[0].reason).not.toMatch(/pays only if value keeps rising/);
  });

  it("does not claim a discount on a clause that is level with value", () => {
    const target = player({
      playerId: "level",
      ownerTeamId: "rival",
      value: 20_330_000,
      clausePrice: 20_780_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 5_000_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.golden[0].discount).toBe(-450_000);
    expect(report.golden[0].reason).not.toContain("under his own market value");
    expect(report.golden[0].reason).toMatch(/over a 20.3M€ value/);
  });

  it("gates a golden clause on its date like any other", () => {
    const target = player({
      playerId: "pending",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENS_LATER,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.golden).toHaveLength(1);
    expect(report.golden[0].availableFrom).toBe(OPENS_LATER);
    expect(report.golden[0].reason).toMatch(/Not payable until/);
  });

  it("flags an unread clause window on a golden clause too", () => {
    const target = player({
      playerId: "unread",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: null,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.golden[0].clauseDateKnown).toBe(false);
    expect(report.golden[0].reason).toMatch(
      /Clause window has not been read yet.*check the date in Futmondo before paying/,
    );
  });

  it("excludes a blocked rival player", () => {
    const target = player({
      playerId: "locked",
      ownerTeamId: "rival",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseLocked: true,
      clauseDate: OPENED_ALREADY,
    });
    expect(runClauses(context({ allPlayers: [target] })).golden).toHaveLength(0);
  });

  it("excludes our own players, however badly we priced them", () => {
    const mine = player({
      playerId: "mine",
      value: 15_000_000,
      clausePrice: 10_000_000,
      clauseDate: OPENED_ALREADY,
    });
    expect(runClauses(context({ allPlayers: [mine] })).golden).toHaveLength(0);
  });

  it("leads the headline with the best affordable golden clause", () => {
    const target = player({
      playerId: "target",
      name: "Luismi Cruz",
      ownerTeamId: "rival",
      value: 20_330_000,
      clausePrice: 20_780_000,
      clauseDate: OPENED_ALREADY,
      valueDelta: 5_000_000,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.headline).toContain("Luismi Cruz");
    expect(report.headline).toContain("20.8M€");
  });

  it("does not lead the headline with a golden clause nobody can pay yet", () => {
    const target = player({
      playerId: "target",
      name: "Luismi Cruz",
      ownerTeamId: "rival",
      value: 20_330_000,
      clausePrice: 20_780_000,
      clauseDate: OPENS_LATER,
      expectedPoints: 5,
    });
    const report = runClauses(context({ allPlayers: [target] }));

    expect(report.headline).not.toMatch(/^Luismi Cruz/);
  });
});
