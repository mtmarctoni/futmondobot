/**
 * The clause-blocking writer.
 *
 * The bug it had was not a wrong write but an invisible one. No Futmondo
 * payload carries lock state, so `alreadyLocked` was permanently false; the cap
 * of five meant the same top five targets were re-locked every day and the
 * other ten never reached; and `action_log` contained no lock row in the app's
 * entire history, which is indistinguishable from the job never having run.
 */
import { describe, expect, it, vi } from "vitest";
import { applyLocks } from "./apply";
import type { FutmondoClient, Scope } from "../futmondo/client";
import type { ExposedPlayer } from "./clauses";
import type { Evaluated } from "./types";

const SCOPE: Scope = {
  championshipId: "6a95cfc4ce50f2235a55f73f",
  userteamId: "6a98655603bfa804dd19cb52",
};

function player(id: string): Evaluated {
  return {
    playerId: id,
    name: id,
    role: "DEF",
    clubName: "Club",
    clubId: "c1",
    slug: null,
    value: 10_000_000,
    seasonPoints: 0,
    pointsPerStart: 4,
    startProbability: 1,
    fixtureDifficulty: 0.5,
    nextOpponent: null,
    unavailableReason: null,
    availability: "fit",
    valueDelta: 0,
    sampleRounds: 3,
    expectedPoints: 4,
    pointsPerMillion: 0.4,
    ownerTeamId: SCOPE.userteamId,
    clausePrice: 5_000_000,
    clauseLocked: null,
    clauseDate: null,
    suggestedClause: null,
    onMarket: false,
    askPrice: null,
    notes: [],
  };
}

function exposed(id: string, over: Partial<ExposedPlayer> = {}): ExposedPlayer {
  return {
    player: player(id),
    clausePrice: 5_000_000,
    efficiency: 0.8,
    threats: [{ teamId: "rival", teamName: "Rival FC", funds: 50_000_000 }],
    alreadyLocked: false,
    availableFrom: null,
    reason: "Clause 5.00M€, a bargain at that price; 1 rival could pay it.",
    ...over,
  };
}

function fakeClient(lockPlayer: FutmondoClient["lockPlayer"]): FutmondoClient {
  return { lockPlayer } as unknown as FutmondoClient;
}

describe("applyLocks", () => {
  it("blocks every exposed player, not the first five", () => {
    // A squad is fifteen. With no readable lock state, a cap of five meant ten
    // players were never protected at all, however many runs happened.
    const lockPlayer = vi.fn().mockResolvedValue({});
    const targets = Array.from({ length: 15 }, (_, i) => exposed(`p${i}`));

    return applyLocks({
      client: fakeClient(lockPlayer),
      scope: SCOPE,
      exposed: targets,
    }).then((result) => {
      expect(result.locked).toHaveLength(15);
      expect(result.skipped).toBe(0);
      expect(lockPlayer).toHaveBeenCalledTimes(15);
    });
  });

  it("does not re-block a player we already blocked", async () => {
    const lockPlayer = vi.fn().mockResolvedValue({});
    const result = await applyLocks({
      client: fakeClient(lockPlayer),
      scope: SCOPE,
      exposed: [exposed("done", { alreadyLocked: true }), exposed("todo")],
    });

    expect(result.locked.map((l) => l.playerId)).toEqual(["todo"]);
    expect(lockPlayer).toHaveBeenCalledTimes(1);
  });

  it("does not block a player no rival can take", async () => {
    const lockPlayer = vi.fn().mockResolvedValue({});
    const result = await applyLocks({
      client: fakeClient(lockPlayer),
      scope: SCOPE,
      exposed: [exposed("safe", { threats: [] })],
    });

    expect(result.locked).toHaveLength(0);
    expect(lockPlayer).not.toHaveBeenCalled();
  });

  it("reports how many it left for the next run when the cap bites", async () => {
    const lockPlayer = vi.fn().mockResolvedValue({});
    const result = await applyLocks({
      client: fakeClient(lockPlayer),
      scope: SCOPE,
      exposed: [exposed("a"), exposed("b"), exposed("c")],
      max: 2,
    });

    expect(result.locked).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("reports a failed write instead of silently counting it as done", async () => {
    const lockPlayer = vi
      .fn()
      .mockRejectedValueOnce(new Error("clause.lock.notAllowed"))
      .mockResolvedValue({});

    const result = await applyLocks({
      client: fakeClient(lockPlayer),
      scope: SCOPE,
      exposed: [exposed("fails"), exposed("works")],
    });

    expect(result.locked.map((l) => l.playerId)).toEqual(["works"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Could not block fails/);
  });

  it("writes nothing on a dry run but still names the targets", async () => {
    const lockPlayer = vi.fn().mockResolvedValue({});
    const result = await applyLocks({
      client: fakeClient(lockPlayer),
      scope: SCOPE,
      exposed: [exposed("a"), exposed("b")],
      dryRun: true,
    });

    expect(result.locked).toHaveLength(2);
    expect(lockPlayer).not.toHaveBeenCalled();
  });
});
