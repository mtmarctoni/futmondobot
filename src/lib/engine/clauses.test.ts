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
