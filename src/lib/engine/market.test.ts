/**
 * Market reasoning: what we claim about money, what we can see of our own
 * listings, and how much to actually bid.
 *
 * The fixtures are the real market state of 2026-09-04 where a real one exists,
 * because the failures here were failures of the model rather than of the
 * arithmetic: a fabricated prize-money rate, a blind spot over our own
 * listings, and a ranking that put a 1.0M defender ahead of everything with
 * 202M sitting idle.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BID_INCREMENT,
  runMarket,
  suggestBid,
  willingnessToPay,
  type MarketContext,
} from "./market";
import { DEFAULT_RULES, type Evaluated, type LeagueRules } from "./types";

const NOW = new Date("2026-09-04T12:00:00.000Z");

/** The real league: pays nothing per point, 40M by round ranking. */
const REAL_RULES: LeagueRules = {
  ...DEFAULT_RULES,
  pricePerPoint: 0,
  pricePerRanking: 40_000_000,
  rankingMode: "flop",
  directSellShare: 0.8,
  minListingShare: 0.5,
  clauseWindowDays: 2,
  bidDurationDays: 2,
  marketPlayers: 12,
};

/** A league that does pay per point, to show the sentence is not simply gone. */
const PAYING_RULES: LeagueRules = { ...REAL_RULES, pricePerPoint: 60_000 };

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
    ownerTeamId: null,
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

function context(over: Partial<MarketContext> = {}): MarketContext {
  const starter = player({ playerId: "mine", expectedPoints: 2 });
  return {
    listings: [],
    squad: [starter],
    starterIds: new Set(["mine"]),
    funds: 202_061_856,
    teamValue: 111_789_641,
    rules: REAL_RULES,
    now: NOW,
    ...over,
  };
}

describe("prize-money claims", () => {
  it("makes none when the league does not pay for points", () => {
    const report = runMarket(
      context({
        listings: [{ player: player({ playerId: "buy", expectedPoints: 6 }), price: 5_000_000 }],
      }),
    );

    expect(report.buys[0].weeklyReturn).toBeNull();
    // Not "0€ a round", which would be as misleading as the invented rate.
    expect(report.buys[0].reason).not.toMatch(/prize money/);
    expect(report.headline).not.toMatch(/prize money/);
  });

  it("still makes one where the league genuinely pays", () => {
    const report = runMarket(
      context({
        rules: PAYING_RULES,
        listings: [{ player: player({ playerId: "buy", expectedPoints: 6 }), price: 5_000_000 }],
      }),
    );

    expect(report.buys[0].weeklyReturn).toBeCloseTo(4 * 60_000, 6);
    expect(report.buys[0].reason).toMatch(/prize money/);
  });
});

describe("ranking buys", () => {
  it("ranks by absolute upgrade when cash is not the constraint", () => {
    // The real failure: with 202M idle and no yield on cash, points per million
    // put Héctor Fort at 1.00M above every player who would actually improve
    // the team.
    const report = runMarket(
      context({
        listings: [
          { player: player({ playerId: "cheap", expectedPoints: 2.5 }), price: 1_000_000 },
          { player: player({ playerId: "good", expectedPoints: 7 }), price: 40_000_000 },
        ],
      }),
    );

    expect(report.buys[0].player.playerId).toBe("good");
  });

  it("falls back to efficiency once funds actually bind", () => {
    const report = runMarket(
      context({
        funds: 2_000_000,
        teamValue: 1_000_000,
        reportedMaxBid: 2_500_000,
        listings: [
          { player: player({ playerId: "cheap", expectedPoints: 3 }), price: 1_000_000 },
          { player: player({ playerId: "mid", expectedPoints: 3.2 }), price: 2_000_000 },
          // Out of reach, which is what makes cash the binding constraint.
          { player: player({ playerId: "good", expectedPoints: 9 }), price: 40_000_000 },
        ],
      }),
    );

    expect(report.buys[0].player.playerId).toBe("cheap");
  });

  it("never puts an unaffordable candidate first", () => {
    const report = runMarket(
      context({
        funds: 5_000_000,
        teamValue: 0,
        reportedMaxBid: 5_000_000,
        listings: [
          { player: player({ playerId: "reach", expectedPoints: 9 }), price: 40_000_000 },
          { player: player({ playerId: "ok", expectedPoints: 3 }), price: 4_000_000 },
        ],
      }),
    );
    expect(report.buys[0].player.playerId).toBe("ok");
    expect(report.buys[0].affordable).toBe(true);
  });
});

describe("bid pricing", () => {
  it("bids above the asking price, in whole increment steps", () => {
    const bid = suggestBid({ price: 10_000_000, ceiling: 30_000_000, increment: 250_000 });
    expect(bid).toBeGreaterThan(10_000_000);
    expect((bid - 10_000_000) % 250_000).toBe(0);
  });

  it("raises a cheap listing above the ask, where the markup rounds to nothing", () => {
    // The percentage markup is smaller than one increment down here -- 12% of
    // 900k is 108k against a 250k step -- so rounding down to whole steps used
    // to hand back the asking price itself. The ask is the auction floor, so
    // that bid loses every contested listing by construction.
    const bid = suggestBid({ price: 900_000, ceiling: 50_000_000, increment: 250_000 });

    expect(bid).toBeGreaterThan(900_000);
    expect((bid - 900_000) % 250_000).toBe(0);
  });

  it("still refuses to raise a cheap listing past the ceiling", () => {
    // One whole step does not fit, and there is no legal bid between the two,
    // so the ask stands rather than an offer we could not fund.
    expect(
      suggestBid({ price: 2_000_000, ceiling: 2_100_000, increment: 250_000 }),
    ).toBe(2_000_000);
  });

  it("never exceeds what the player is worth to us", () => {
    const bid = suggestBid({ price: 10_000_000, ceiling: 10_400_000, increment: 250_000 });
    expect(bid).toBeLessThanOrEqual(10_400_000);
  });

  it("falls back to the asking price when the ceiling is below it", () => {
    expect(
      suggestBid({ price: 10_000_000, ceiling: 1_000_000, increment: 250_000 }),
    ).toBe(10_000_000);
  });

  it("uses the live increment when there is one, the default otherwise", () => {
    const report = runMarket(
      context({
        listings: [
          { player: player({ playerId: "a", expectedPoints: 6 }), price: 4_000_000, increment: 1_000_000 },
          { player: player({ playerId: "b", expectedPoints: 6 }), price: 4_000_000 },
        ],
      }),
    );
    const byId = new Map(report.buys.map((b) => [b.player.playerId, b]));
    expect(byId.get("a")?.increment).toBe(1_000_000);
    expect(byId.get("b")?.increment).toBe(DEFAULT_BID_INCREMENT);
  });

  it("bounds the ceiling by what we can actually spend", () => {
    const ceiling = willingnessToPay({
      player: player({ value: 100_000_000 }),
      upgrade: 5,
      rules: REAL_RULES,
      funds: 3_000_000,
      ceiling: 200_000_000,
    });
    expect(ceiling).toBe(3_000_000);
  });
});

describe("our own listings", () => {
  /** The four real listings live on 2026-09-04, with their standing bids. */
  const OWN = [
    {
      playerId: "carlos",
      name: "Carlos Álvarez",
      price: 18_931_044,
      value: 18_931_044,
      expiresAt: "2026-09-04T18:17:09.885Z",
      bids: [{ price: 18_204_532 }],
    },
    {
      playerId: "vargas",
      name: "Vargas",
      price: 17_341_658,
      value: 17_341_658,
      expiresAt: "2026-09-04T18:17:09.885Z",
      bids: [{ price: 16_445_702 }],
    },
    {
      playerId: "vlachodimos",
      name: "Vlachodimos",
      price: 8_971_705,
      value: 8_971_705,
      expiresAt: "2026-09-06T04:00:00.000Z",
      bids: [],
    },
    {
      playerId: "nino",
      name: "Adrián Niño",
      price: 1_000_000,
      value: 1_000_000,
      expiresAt: "2026-09-06T04:00:00.000Z",
      bids: [],
    },
  ];

  it("reports the standing bid and when it closes", () => {
    const report = runMarket(context({ ownListings: OWN }));
    const carlos = report.listings.find((l) => l.playerId === "carlos");

    expect(carlos?.topBid).toBe(18_204_532);
    expect(carlos?.hoursToExpiry).toBeCloseTo(6.285, 2);
    expect(carlos?.reason).toMatch(/Top bid 18\.2M€/);
    expect(carlos?.reason).toMatch(/Closes in 6 hours/);
  });

  it("computes the direct-sell floor from the league's own rate", () => {
    const report = runMarket(context({ ownListings: OWN }));
    const carlos = report.listings.find((l) => l.playerId === "carlos");
    // dspct is 0.8, so the machine guarantees 80% of value.
    expect(carlos?.directSell).toBe(Math.floor(18_931_044 * 0.8));
    expect(carlos?.reason).toMatch(/guaranteed/);
  });

  it("puts the soonest expiry first", () => {
    const report = runMarket(context({ ownListings: OWN }));
    expect(report.listings[0].expiresAt).toBe("2026-09-04T18:17:09.885Z");
  });

  it("leads with a closing bid rather than a marginal buy", () => {
    const report = runMarket(
      context({
        ownListings: OWN,
        listings: [{ player: player({ playerId: "buy", expectedPoints: 6 }), price: 5_000_000 }],
      }),
    );
    expect(report.headline).toMatch(/bid closing in/);
  });

  it("omits the direct-sell figure when the league publishes no rate", () => {
    const report = runMarket(
      context({ rules: DEFAULT_RULES, ownListings: OWN }),
    );
    expect(report.listings[0].directSell).toBeNull();
    expect(report.listings[0].reason).not.toMatch(/guaranteed/);
  });
});

describe("selling", () => {
  it("does not call a player who is already listed a sale to make", () => {
    // The engine said "Sell Adrián Niño — 1.00M€" while he sat listed at 1.0M.
    const listed = player({
      playerId: "nino",
      name: "Adrián Niño",
      value: 1_000_000,
      expectedPoints: 0,
      onMarket: true,
      askPrice: 1_000_000,
    });
    const report = runMarket(
      context({ squad: [player({ playerId: "mine", expectedPoints: 2 }), listed] }),
    );

    const sell = report.sells.find((s) => s.player.playerId === "nino");
    expect(sell?.alreadyListed).toBe(true);
    expect(sell?.reason).toMatch(/Already listed at 1\.00M€/);
  });

  it("does not call a fit player carrying a doubt dead capital", () => {
    // This produced "doubt and not in the XI — 17.0M€ of dead capital" about a
    // fit 17M starting forward.
    const doubtful = player({
      playerId: "vargas",
      name: "Vargas",
      role: "DEL",
      value: 17_341_658,
      expectedPoints: 1.6,
      unavailableReason: "doubt",
      availability: "doubt",
    });
    const report = runMarket(
      context({ squad: [player({ playerId: "mine", expectedPoints: 2 }), doubtful] }),
    );

    const sell = report.sells.find((s) => s.player.playerId === "vargas");
    expect(sell?.reason).not.toMatch(/dead capital/);
  });

  it("still calls a departed player dead capital", () => {
    const gone = player({
      playerId: "carlos",
      value: 18_526_493,
      expectedPoints: 0,
      unavailableReason: "no longer in the competition (now at América)",
      availability: "out",
    });
    const report = runMarket(
      context({ squad: [player({ playerId: "mine", expectedPoints: 2 }), gone] }),
    );

    const sell = report.sells.find((s) => s.player.playerId === "carlos");
    expect(sell?.reason).toMatch(/dead capital/);
  });
});

describe("committed funds", () => {
  it("does not treat cash held by a standing bid as spendable", () => {
    const report = runMarket(
      context({
        funds: 5_000_000,
        teamValue: 0,
        reportedMaxBid: 5_000_000,
        committed: 4_000_000,
        listings: [{ player: player({ playerId: "buy", expectedPoints: 6 }), price: 4_500_000 }],
      }),
    );

    expect(report.committed).toBe(4_000_000);
    expect(report.buys[0].affordable).toBe(false);
  });
});

describe("what a player is worth where points have no euro rate", () => {
  it("anchors on market value, not on the liquidation floor", () => {
    // Anchoring on the 80% direct-sell floor puts every ceiling below every
    // asking price, which collapses every bid back to the ask and undoes the
    // point of pricing a bid at all.
    const ceiling = willingnessToPay({
      player: player({ value: 10_000_000 }),
      upgrade: 2,
      rules: REAL_RULES,
      funds: 200_000_000,
      ceiling: 200_000_000,
    });

    expect(ceiling).toBeGreaterThan(10_000_000);
    expect(ceiling).toBeLessThan(13_000_000);
  });

  it("offers no premium for a player who would not improve the team", () => {
    const ceiling = willingnessToPay({
      player: player({ value: 10_000_000 }),
      upgrade: -1,
      rules: REAL_RULES,
      funds: 200_000_000,
      ceiling: 200_000_000,
    });
    expect(ceiling).toBe(10_000_000);
  });

  it("still produces a bid above the asking price", () => {
    const report = runMarket(
      context({
        listings: [
          {
            player: player({ playerId: "buy", value: 2_870_000, expectedPoints: 6 }),
            price: 2_870_000,
          },
        ],
      }),
    );
    expect(report.buys[0].suggestedBid).toBeGreaterThan(2_870_000);
  });

  it("prices from the points rate where the league has one", () => {
    const ceiling = willingnessToPay({
      player: player({ value: 10_000_000 }),
      upgrade: 2,
      rules: PAYING_RULES,
      funds: 200_000_000,
      ceiling: 200_000_000,
    });
    // 2 pts x 30 rounds x 60k, plus 80% of value recoverable on resale.
    expect(ceiling).toBe(2 * 30 * 60_000 + 8_000_000);
  });
});

describe("the low-value radar", () => {
  it("reports a cheap rising listing separately from the buy list", () => {
    const report = runMarket(
      context({
        listings: [
          {
            player: player({ playerId: "cheap", value: 2_000_000, expectedPoints: 0.5 }),
            price: 2_000_000,
            increment: 250_000,
            prices: [
              { date: "2026-09-03T02:25:30.285Z", price: 1_900_000 },
              { date: "2026-09-04T02:25:30.285Z", price: 2_000_000 },
            ],
          },
        ],
      }),
    );

    expect(report.radar.opportunities.map((o) => o.playerId)).toEqual(["cheap"]);
    // A speculation is not an XI upgrade, so the bid must clear the ask.
    expect(report.radar.opportunities[0].suggestedBid).toBeGreaterThan(2_000_000);
  });

  it("judges cheapness on today's listing, not on a stored valuation", () => {
    // Evaluated.value comes from history.ownership -- yesterday's snapshot --
    // while the listing itself is live. Judging the ceiling on the stored
    // figure would silently drop a player who fell under 2.5M today, which is
    // exactly the player this module exists to find, and nothing would report
    // an error.
    const report = runMarket(
      context({
        listings: [
          {
            player: player({ playerId: "fell", value: 2_600_000 }),
            price: 2_400_000,
            value: 2_400_000,
            increment: 250_000,
            prices: [
              { date: "2026-09-03T02:25:30.285Z", price: 2_300_000 },
              { date: "2026-09-04T02:25:30.285Z", price: 2_400_000 },
            ],
          },
        ],
      }),
    );

    expect(report.radar.opportunities.map((o) => o.playerId)).toEqual(["fell"]);
    expect(report.radar.opportunities[0].value).toBe(2_400_000);
  });

  it("leaves the radar empty when no price series was read", () => {
    const report = runMarket(
      context({
        listings: [
          { player: player({ playerId: "cheap", value: 2_000_000 }), price: 2_000_000 },
        ],
      }),
    );

    expect(report.radar.opportunities).toEqual([]);
    expect(report.radar.unknownChange).toBe(1);
  });
});

describe("bidding on a cheap upgrade", () => {
  it("does not recommend bidding the asking price itself", () => {
    // The willingness ceiling is value plus a 12% placeholder premium, which on
    // a 900k player is narrower than a single 250k bid step. The bid therefore
    // collapsed back to the ask -- the one offer guaranteed to lose a contested
    // listing -- and the headline said "Bid 900k (asking 900k)" in as many
    // words. A ceiling that cannot express one legal bid step is a rounding
    // artifact, not a valuation.
    const report = runMarket(
      context({
        listings: [
          {
            player: player({
              playerId: "bargain",
              value: 900_000,
              expectedPoints: 6,
            }),
            price: 900_000,
            increment: 250_000,
          },
        ],
        squad: [player({ playerId: "mine", expectedPoints: 2, value: 5_000_000 })],
        starterIds: new Set(["mine"]),
      }),
    );

    const [buy] = report.buys;
    expect(buy.suggestedBid).toBeGreaterThan(buy.price);
    expect((buy.suggestedBid - buy.price) % 250_000).toBe(0);
    expect(report.headline).not.toMatch(/Bid 900k€ .*asking 900k€/);
  });

  it("does not recommend a cheap player who is no upgrade at all", () => {
    // Stretching the ceiling is justified by the upgrade being real, and the
    // buy list is already confined to real upgrades. Pinned so that widening
    // the bid cannot quietly widen what gets recommended.
    const report = runMarket(
      context({
        listings: [
          {
            player: player({
              playerId: "spare",
              value: 900_000,
              expectedPoints: 0.5,
            }),
            price: 900_000,
            increment: 250_000,
          },
        ],
        squad: [player({ playerId: "mine", expectedPoints: 4, value: 5_000_000 })],
        starterIds: new Set(["mine"]),
      }),
    );

    expect(report.buys.map((b) => b.player.playerId)).not.toContain("spare");
  });

  it("never stretches the ceiling past what we can actually spend", () => {
    const report = runMarket(
      context({
        listings: [
          {
            player: player({
              playerId: "bargain",
              value: 900_000,
              expectedPoints: 6,
            }),
            price: 900_000,
            increment: 250_000,
          },
        ],
        squad: [player({ playerId: "mine", expectedPoints: 2, value: 5_000_000 })],
        starterIds: new Set(["mine"]),
        funds: 1_000_000,
        teamValue: 0,
      }),
    );

    expect(report.buys[0].suggestedBid).toBeLessThanOrEqual(1_000_000);
  });
});
