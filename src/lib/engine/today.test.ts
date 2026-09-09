/**
 * What the action list does with a player who has left the competition.
 *
 * The wording is not incidental. This is the one problem in the game that
 * Futmondo itself gives no sign of, so the action has to say what happened as
 * well as what to do, and it must never suggest listing a player who is
 * already listed.
 */
import { describe, expect, it } from "vitest";
import { buildToday, type Action, type TodayInput } from "./today";
import type { ClauseBet } from "./clauses";
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
    availability: "fit",
    valueDelta: 0,
    sampleRounds: 0,
    expectedPoints: 2,
    pointsPerMillion: 2,
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
  radar: { opportunities: [], unknownChange: 0 },
  sells: [],
  listings: [],
  funds: 0,
  committed: 0,
  maxOffer: 0,
  headline: "",
};

const NO_CLAUSES: ClauseReport = {
  steals: [],
  pendingSteals: [],
  exposed: [],
  toLock: [],
  trendBets: [],
  windowNote: null,
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
      availability: "out",
    });
    const { actions } = buildToday(
      input({
        departed: [CARLOS],
        market: {
          ...NO_MARKET,
          sells: [
            {
              player,
              cost: 0,
              directSell: null,
              alreadyListed: false,
              reason: "dead capital",
            },
          ],
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
          sells: [
            {
              player: spare,
              cost: 0,
              directSell: null,
              alreadyListed: false,
              reason: "never starts",
            },
          ],
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

/**
 * Our own listings, the clause window and multiple bids.
 *
 * All three are things the action list could not previously say anything about:
 * it could not see a bid on our own listing, it recommended clause action on a
 * day when no clause was payable, and it surfaced exactly one buy per day.
 */
describe("listing actions", () => {
  const CLOSING = {
    playerId: "carlos",
    name: "Carlos Álvarez",
    price: 18_931_044,
    value: 18_931_044,
    expiresAt: "2026-09-04T18:17:09.885Z",
    hoursToExpiry: 6.3,
    topBid: 18_204_532,
    bidCount: 1,
    directSell: 15_144_835,
    reason: "Top bid 18.2M€, 727k€ under the asking price. Closes in 6 hours.",
  };

  it("raises a closing bid urgently, because it expires", () => {
    const { actions } = buildToday(
      input({ market: { ...NO_MARKET, listings: [CLOSING] } }),
    );
    const action = actions.find((a) => a.id === "listing-bid-carlos");

    expect(action?.kind).toBe("listing");
    expect(action?.urgency).toBe("now");
    expect(action?.title).toMatch(/18\.2M€ bid on Carlos Álvarez/);
  });

  it("gives it no button, because accepting moves money", () => {
    // And because it is not even established whether a machine-market listing
    // needs acceptance at all (OPEN-4).
    const { actions } = buildToday(
      input({ market: { ...NO_MARKET, listings: [CLOSING] } }),
    );
    const action = actions.find((a) => a.id === "listing-bid-carlos");
    expect(action?.automatable).toBeUndefined();
  });

  it("flags a listing about to lapse with nothing on it", () => {
    const { actions } = buildToday(
      input({
        market: {
          ...NO_MARKET,
          listings: [
            { ...CLOSING, playerId: "nino", name: "Adrián Niño", topBid: null, bidCount: 0 },
          ],
        },
      }),
    );
    const action = actions.find((a) => a.id === "listing-stale-nino");
    expect(action?.detail).toMatch(/Re-price or withdraw/);
  });

  it("says nothing about a listing that has already closed", () => {
    const { actions } = buildToday(
      input({
        market: { ...NO_MARKET, listings: [{ ...CLOSING, hoursToExpiry: -2 }] },
      }),
    );
    expect(actions.some((a) => a.id.startsWith("listing-"))).toBe(false);
  });
});

describe("clause window action", () => {
  it("says when the squad becomes clausable, so the block precedes it", () => {
    const { actions } = buildToday(
      input({
        clauses: {
          ...NO_CLAUSES,
          windowNote:
            "None of your squad can be claused until 2026-09-07 18:05Z. Block before then, not after.",
        },
      }),
    );
    const action = actions.find((a) => a.id === "clause-window");
    expect(action?.detail).toMatch(/2026-09-07/);
  });

  it("says nothing when clauses are already live", () => {
    const { actions } = buildToday(input());
    expect(actions.some((a) => a.id === "clause-window")).toBe(false);
  });
});

describe("buy actions", () => {
  function buy(id: string, price: number, upgrade: number) {
    return {
      player: evaluated({ playerId: id, name: id, value: price }),
      price,
      upgrade,
      replaces: null,
      weeklyReturn: null,
      ceiling: price * 2,
      suggestedBid: price + 250_000,
      increment: 250_000,
      affordable: true,
      reason: `+${upgrade} pts/round`,
    };
  }

  it("surfaces several bids, not one", () => {
    // One buy a day at the asking price was the binding constraint on turning
    // 202M of idle cash into points.
    const { actions } = buildToday(
      input({
        market: {
          ...NO_MARKET,
          funds: 200_000_000,
          buys: [buy("a", 10_000_000, 3), buy("b", 8_000_000, 2), buy("c", 6_000_000, 1)],
        },
      }),
    );
    expect(actions.filter((a) => a.kind === "buy")).toHaveLength(3);
  });

  it("proposes the bid rather than the asking price", () => {
    const { actions } = buildToday(
      input({
        market: { ...NO_MARKET, funds: 200_000_000, buys: [buy("a", 10_000_000, 3)] },
      }),
    );
    const action = actions.find((a) => a.kind === "buy");
    expect(action?.bid).toBe(10_250_000);
    expect(action?.money).toBe(-10_250_000);
    expect(action?.detail).toMatch(/Asking 10\.0M€; bidding 10\.3M€/);
  });

  it("stops proposing bids once winning them all would overspend", () => {
    const { actions } = buildToday(
      input({
        market: {
          ...NO_MARKET,
          funds: 12_000_000,
          buys: [buy("a", 10_000_000, 3), buy("b", 8_000_000, 2)],
        },
      }),
    );
    expect(actions.filter((a) => a.kind === "buy")).toHaveLength(1);
  });

  it("counts cash already held by a standing bid as spent", () => {
    const { actions } = buildToday(
      input({
        market: {
          ...NO_MARKET,
          funds: 12_000_000,
          committed: 5_000_000,
          buys: [buy("a", 10_000_000, 3)],
        },
      }),
    );
    expect(actions.filter((a) => a.kind === "buy")).toHaveLength(0);
  });
});

describe("prize-money wording in steal actions", () => {
  function steal() {
    return {
      player: evaluated({ playerId: "target", name: "Target" }),
      clausePrice: 5_000_000,
      ownerTeamId: "rival",
      ownerName: "Rival FC",
      upgrade: 3,
      replaces: null,
      efficiency: 0.6,
      discount: 1_000_000,
      overSuggested: null,
      affordable: true,
      availableFrom: null,
      clauseDateKnown: true,
      reason: "5.00M€ for 3.0 pts/round better than someone.",
    };
  }

  it("makes no money claim where the league pays nothing per point", () => {
    const { actions } = buildToday(
      input({ clauses: { ...NO_CLAUSES, steals: [steal()] } }),
    );
    const action = actions.find((a) => a.kind === "steal_clause");
    expect(action?.detail).not.toMatch(/prize money/);
  });

  it("makes one where it does", () => {
    const { actions } = buildToday(
      input({
        rules: { ...DEFAULT_RULES, pricePerPoint: 60_000 },
        clauses: { ...NO_CLAUSES, steals: [steal()] },
      }),
    );
    const action = actions.find((a) => a.kind === "steal_clause");
    expect(action?.detail).toMatch(/180k€ a round in prize money/);
  });
});

describe("clause_bet actions", () => {
  function bet(over: Partial<ClauseBet> = {}): ClauseBet {
    return {
      player: evaluated({ playerId: "target", name: "Target" }),
      clausePrice: 10_000_000,
      ownerTeamId: "rival",
      ownerName: "Rival FC",
      ratio: 0.9,
      discount: -1_000_000,
      opportunity: 6,
      affordable: true,
      availableFrom: null,
      clauseDateKnown: true,
      reason:
        "clause 10.0M€ vs value 9.0M€. The payoff is future value, not today's. Bet pays only if value keeps rising.",
      ...over,
    };
  }

  function betActions(over: ClauseBet[]): Action[] {
    const { actions } = buildToday(
      input({ clauses: { ...NO_CLAUSES, trendBets: over } }),
    );
    return actions.filter((a) => a.kind === "clause_bet");
  }

  it("surfaces an affordable, high-opportunity rising bet below the buy band", () => {
    const [action] = betActions([bet()]);
    expect(action).toBeDefined();
    expect(action.kind).toBe("clause_bet");
    expect(action.title).toMatch(/^Bet on Target: clause at 10.0M€, value rising/);
    expect(action.money).toBe(-10_000_000);
    expect(action.urgency).toBe("today");
    // Market buys occupy 60-75; a forward bet must rank below them.
    expect(action.weight).toBeLessThan(60);
    expect(action.weight).toBeGreaterThanOrEqual(45);
  });

  it("carries the honest wording verbatim, never a discount claim", () => {
    const [action] = betActions([bet()]);
    expect(action.detail).toContain("future value, not today's");
    expect(action.detail).not.toMatch(/free money|exploit|discount by any standard/i);
  });

  it("excludes bets below the minimum opportunity", () => {
    expect(betActions([bet({ opportunity: 4.9 })])).toHaveLength(0);
  });

  it("excludes unaffordable bets no matter how strong the trend", () => {
    expect(betActions([bet({ affordable: false, opportunity: 9 })])).toHaveLength(0);
  });

  it("caps at three bets, so the list never crowds the buys", () => {
    const many = [1, 2, 3, 4].map((i) =>
      bet({ player: evaluated({ playerId: `p${i}`, name: `Riser ${i}` }) }),
    );
    const actions = betActions(many);
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.playerId)).toEqual(["p1", "p2", "p3"]);
  });

  it("still surfaces a bet whose window has not opened yet, flagged in the detail", () => {
    const [action] = betActions([
      bet({
        availableFrom: "2026-09-07T18:05:10.923Z",
        reason:
          "Not payable until 2026-09-07 18:05Z. Bet pays only if value keeps rising.",
      }),
    ]);
    expect(action).toBeDefined();
    expect(action.detail).toMatch(/Not payable until 2026-09-07 18:05Z/);
  });
});
