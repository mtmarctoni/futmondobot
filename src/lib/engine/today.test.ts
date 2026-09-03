/**
 * What the action list does with a player who has left the competition.
 *
 * The wording is not incidental. This is the one problem in the game that
 * Futmondo itself gives no sign of, so the action has to say what happened as
 * well as what to do, and it must never suggest listing a player who is
 * already listed.
 */
import { describe, expect, it } from "vitest";
import { buildToday, type TodayInput } from "./today";
import type { DepartedPlayer } from "./departed";
import type { Evaluated } from "./types";
import { DEFAULT_RULES } from "./types";
import { pickLineup } from "./lineup";
import type { MarketReport } from "./market";
import type { ClauseReport } from "./clauses";

function evaluated(over: Partial<Evaluated> = {}): Evaluated {
  return {
    playerId: "p1",
    name: "Player",
    role: "MED",
    clubName: "Valencia",
    clubId: "c1",
    slug: null,
    value: 1_000_000,
    seasonPoints: 0,
    pointsPerStart: 4,
    startProbability: 0.5,
    fixtureDifficulty: 0.5,
    nextOpponent: null,
    unavailableReason: null,
    valueDelta: 0,
    sampleRounds: 0,
    expectedPoints: 2,
    pointsPerMillion: 2,
    ownerTeamId: "me",
    clausePrice: null,
    clauseLocked: null,
    notes: [],
    ...over,
  };
}

const CARLOS: DepartedPlayer = {
  playerId: "63a8cd87bfb65a271f11db10",
  name: "Carlos Álvarez",
  role: "MED",
  clubName: "América",
  clubId: "5200250711398189070000b4",
  value: 18_526_493,
  onMarket: false,
  askPrice: null,
};

/** Enough players for pickLineup to return a real XI rather than "no data". */
const SQUAD: Evaluated[] = [
  "POR",
  "DEF",
  "DEF",
  "DEF",
  "DEF",
  "MED",
  "MED",
  "MED",
  "MED",
  "DEL",
  "DEL",
].map((role, i) =>
  evaluated({ playerId: `s${i}`, name: `Starter ${i}`, role: role as Evaluated["role"] }),
);

const NO_MARKET: MarketReport = {
  buys: [],
  sells: [],
  funds: 0,
  maxOffer: 0,
  headline: "",
};

const NO_CLAUSES: ClauseReport = {
  steals: [],
  exposed: [],
  toLock: [],
  headline: "",
};

function input(over: Partial<TodayInput> = {}): TodayInput {
  return {
    lineup: pickLineup(SQUAD),
    lineupChanges: [],
    lineupApplied: false,
    market: NO_MARKET,
    clauses: NO_CLAUSES,
    departed: [],
    deadline: null,
    rules: DEFAULT_RULES,
    ...over,
  };
}

describe("buildToday and departed players", () => {
  it("raises a sell action naming the new club and the money tied up", () => {
    const { actions } = buildToday(input({ departed: [CARLOS] }));
    const action = actions.find((a) => a.id === `departed-${CARLOS.playerId}`);

    expect(action).toBeDefined();
    expect(action?.kind).toBe("sell");
    expect(action?.urgency).toBe("today");
    expect(action?.title).toMatch(/Carlos Álvarez/);
    expect(action?.detail).toMatch(/América/);
    expect(action?.detail).toMatch(/18\.5M€/);
    // A playerId is what earns the action a two-tap button in Telegram.
    expect(action?.playerId).toBe(CARLOS.playerId);
  });

  it("outranks everything except a broken lineup", () => {
    const { actions } = buildToday(input({ departed: [CARLOS] }));
    expect(actions[0].id).toBe(`departed-${CARLOS.playerId}`);
  });

  it("does not offer to list a player who is already listed", () => {
    const { actions } = buildToday(
      input({
        departed: [{ ...CARLOS, onMarket: true, askPrice: 18_931_044 }],
      }),
    );
    const action = actions.find((a) => a.id === `departed-${CARLOS.playerId}`);

    // Info, not sell: an action button here would list him a second time.
    expect(action?.kind).toBe("info");
    expect(action?.detail).toMatch(/Already on the market at 18\.9M€/);
  });

  it("does not raise the same player as an ordinary sell as well", () => {
    const player = evaluated({
      playerId: CARLOS.playerId,
      name: CARLOS.name,
      value: CARLOS.value,
      expectedPoints: 0,
      unavailableReason: "no longer in the competition (now at América)",
    });
    const { actions } = buildToday(
      input({
        departed: [CARLOS],
        market: {
          ...NO_MARKET,
          sells: [{ player, cost: 0, reason: "dead capital" }],
        },
      }),
    );

    const forPlayer = actions.filter((a) => a.playerId === CARLOS.playerId);
    expect(forPlayer).toHaveLength(1);
    expect(forPlayer[0].id).toBe(`departed-${CARLOS.playerId}`);
  });

  it("still raises ordinary sells for everyone else", () => {
    const spare = evaluated({ playerId: "spare", name: "Spare", expectedPoints: 0 });
    const { actions } = buildToday(
      input({
        departed: [CARLOS],
        market: {
          ...NO_MARKET,
          sells: [{ player: spare, cost: 0, reason: "never starts" }],
        },
      }),
    );
    expect(actions.some((a) => a.id === "sell-spare")).toBe(true);
  });

  it("says nothing when nobody has left", () => {
    const { actions } = buildToday(input());
    expect(actions.some((a) => a.id.startsWith("departed-"))).toBe(false);
  });
});
