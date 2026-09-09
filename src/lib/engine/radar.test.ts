/**
 * The radar's whole job is a filter, so its tests are about what it refuses.
 *
 * Price series in these fixtures are shaped like a real `/1/player/summary`
 * `prices[]` payload as captured in docs/futmondo-api.md: ISO instants stamped
 * around 02:25 UTC, ascending, with the fields `c` and `s` present but unread.
 * Writing them from the same assumption as the code is exactly how the six
 * parser bugs in AGENTS.md stayed green, so the shape is copied, not invented.
 */
import { describe, expect, it } from "vitest";

import {
  LOW_VALUE_CEILING,
  couldBeOpportunity,
  detectOpportunities,
  type RadarInput,
  type RadarListing,
} from "./radar";

/** Noon on the day after the newest fixture point below. */
const NOW = new Date("2026-09-08T12:00:00.000Z");

function input(over: Partial<RadarInput> = {}): RadarInput {
  return { listings: [], ceiling: 50_000_000, now: NOW, ...over };
}

/** A listing whose price series rises by `rise` on the last day. */
function listing(over: Partial<RadarListing> & { playerId: string }): RadarListing {
  return {
    playerId: over.playerId,
    name: over.name ?? "Test Player",
    role: over.role ?? "DEFENSA",
    clubName: over.clubName ?? "Test Club",
    price: over.price ?? 2_000_000,
    value: over.value ?? 2_000_000,
    increment: over.increment ?? 250_000,
    prices: over.prices ?? [
      { date: "2026-09-07T02:25:30.285Z", price: 1_900_000 },
      { date: "2026-09-08T02:25:30.285Z", price: 2_000_000 },
    ],
  };
}

describe("detectOpportunities", () => {
  it("keeps a player at the ceiling whose value rose today", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({
          playerId: "a",
          value: LOW_VALUE_CEILING,
          prices: [
            { date: "2026-09-07T02:25:30.285Z", price: 2_400_000 },
            { date: "2026-09-08T02:25:30.285Z", price: LOW_VALUE_CEILING },
          ],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities.map((o) => o.playerId)).toEqual(["a"]);
    expect(found.opportunities[0].dailyChange).toBe(100_000);
  });

  it("excludes a player one euro over the ceiling", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({
          playerId: "a",
          value: LOW_VALUE_CEILING + 1,
          prices: [
            { date: "2026-09-07T02:25:30.285Z", price: 2_400_000 },
            { date: "2026-09-08T02:25:30.285Z", price: LOW_VALUE_CEILING + 1 },
          ],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities).toEqual([]);
  });

  it("excludes a player whose value is flat today", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({
          playerId: "a",
          prices: [
            { date: "2026-09-07T02:25:30.285Z", price: 2_000_000 },
            { date: "2026-09-08T02:25:30.285Z", price: 2_000_000 },
          ],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities).toEqual([]);
  });

  it("excludes a player whose value fell today", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({
          playerId: "a",
          prices: [
            { date: "2026-09-07T02:25:30.285Z", price: 2_100_000 },
            { date: "2026-09-08T02:25:30.285Z", price: 2_000_000 },
          ],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities).toEqual([]);
  });

  it("orders by percentage rise, not by euros gained", () => {
    const found = detectOpportunities(input({
      listings: [
        // +100.000 on 2.4M is +4,3%.
        listing({
          playerId: "bigger-euros",
          value: 2_500_000,
          prices: [
            { date: "2026-09-07T02:25:30.285Z", price: 2_400_000 },
            { date: "2026-09-08T02:25:30.285Z", price: 2_500_000 },
          ],
        }),
        // +50.000 on 200.000 is +25%.
        listing({
          playerId: "bigger-percent",
          value: 250_000,
          prices: [
            { date: "2026-09-07T02:25:30.285Z", price: 200_000 },
            { date: "2026-09-08T02:25:30.285Z", price: 250_000 },
          ],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities.map((o) => o.playerId)).toEqual([
      "bigger-percent",
      "bigger-euros",
    ]);
  });

  it("reports a single price point as unknown rather than flat", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({
          playerId: "new-arrival",
          prices: [{ date: "2026-09-08T02:25:30.285Z", price: 2_000_000 }],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("reports a missing price series as unknown rather than flat", () => {
    const found = detectOpportunities(input({
      listings: [listing({ playerId: "unread", prices: [] })],
    }));

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("does not count a player priced out of the module as unknown", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({ playerId: "expensive", value: 12_000_000, prices: [] }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.unknownChange).toBe(0);
  });

  it("reads the daily change from the two newest points of an unsorted series", () => {
    const found = detectOpportunities(input({
      listings: [
        listing({
          playerId: "a",
          prices: [
            { date: "2026-09-08T02:25:30.285Z", price: 2_000_000 },
            { date: "2026-09-06T02:25:30.285Z", price: 1_500_000 },
            { date: "2026-09-07T02:25:30.285Z", price: 1_900_000 },
          ],
        }),
      ],
      ceiling: 50_000_000,
    }));

    expect(found.opportunities[0].dailyChange).toBe(100_000);
  });

  it("suggests a bid above the asking price, on the auction step", () => {
    const found = detectOpportunities(input({
      listings: [listing({ playerId: "a", price: 2_000_000, increment: 250_000 })],
      ceiling: 50_000_000,
    }));

    const [opportunity] = found.opportunities;
    expect(opportunity.suggestedBid).toBeGreaterThan(opportunity.price);
    expect((opportunity.suggestedBid - opportunity.price) % 250_000).toBe(0);
  });

  it("never suggests a bid above what the ceiling allows", () => {
    const found = detectOpportunities(input({
      listings: [listing({ playerId: "a", price: 2_000_000 })],
      ceiling: 2_000_000,
    }));

    expect(found.opportunities[0].suggestedBid).toBe(2_000_000);
  });

  it("returns nothing for an empty market rather than throwing", () => {
    const found = detectOpportunities(input());

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(0);
  });
});

describe("detectOpportunities and a series that is not daily", () => {
  it("refuses to call a week-old move a rise today", () => {
    // The newest valuation predates the report. Printing it as "up today"
    // would be a false claim about a number someone is about to bid on.
    const found = detectOpportunities(
      input({
        listings: [
          listing({
            playerId: "stale",
            prices: [
              { date: "2026-08-31T02:25:30.285Z", price: 1_900_000 },
              { date: "2026-09-01T02:25:30.285Z", price: 2_000_000 },
            ],
          }),
        ],
      }),
    );

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("refuses to call a multi-day move a rise today", () => {
    // Both points are recent enough, but they are nine days apart, so the
    // change between them is not a daily one.
    const found = detectOpportunities(
      input({
        listings: [
          listing({
            playerId: "gap",
            prices: [
              { date: "2026-08-30T02:25:30.285Z", price: 1_900_000 },
              { date: "2026-09-08T02:25:30.285Z", price: 2_000_000 },
            ],
          }),
        ],
      }),
    );

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("accepts the normal cadence, which is a shade under a day apart", () => {
    // Futmondo stamps these around 02:25 and the report runs whenever it runs,
    // so an exactly-24h assumption would reject every real series.
    const found = detectOpportunities(
      input({
        listings: [
          listing({
            playerId: "normal",
            prices: [
              { date: "2026-09-07T02:25:30.285Z", price: 1_900_000 },
              { date: "2026-09-08T02:25:11.100Z", price: 2_000_000 },
            ],
          }),
        ],
      }),
    );

    expect(found.opportunities.map((o) => o.playerId)).toEqual(["normal"]);
  });

  it("cannot establish a rise from a previous value of zero", () => {
    // A previous price of zero is the same parse artifact a current value of
    // zero is, and the percentage is undefined. Reporting it printed the
    // self-contradicting line "+100k (+0.0%)" and sorted the most extreme move
    // in the list last.
    const found = detectOpportunities(
      input({
        listings: [
          listing({
            playerId: "from-zero",
            value: 100_000,
            prices: [
              { date: "2026-09-07T02:25:30.285Z", price: 0 },
              { date: "2026-09-08T02:25:30.285Z", price: 100_000 },
            ],
          }),
        ],
      }),
    );

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("ignores a listing with no value at all rather than calling it free", () => {
    // A zero value is a parse failure, not the cheapest player in the league.
    const found = detectOpportunities(
      input({
        listings: [
          listing({
            playerId: "unparsed",
            value: 0,
            prices: [
              { date: "2026-09-07T02:25:30.285Z", price: 0 },
              { date: "2026-09-08T02:25:30.285Z", price: 100_000 },
            ],
          }),
        ],
      }),
    );

    expect(found.opportunities).toEqual([]);
  });
});

describe("couldBeOpportunity", () => {
  // Whatever decides which listings are worth fetching a price history for has
  // to be the same rule that filters them afterwards. Two copies of "cheap"
  // would drift by a euro and the difference would never show up as an error:
  // the radar would just quietly stop seeing one player.
  it("accepts a value at the ceiling", () => {
    expect(couldBeOpportunity(LOW_VALUE_CEILING)).toBe(true);
  });

  it("rejects a value one euro over the ceiling", () => {
    expect(couldBeOpportunity(LOW_VALUE_CEILING + 1)).toBe(false);
  });

  it("rejects a value of zero, which is a parse failure", () => {
    expect(couldBeOpportunity(0)).toBe(false);
  });

  it("agrees with the filter detectOpportunities applies", () => {
    const at = LOW_VALUE_CEILING;
    const over = LOW_VALUE_CEILING + 1;
    const rising = [
      { date: "2026-09-07T02:25:30.285Z", price: 1_000_000 },
      { date: "2026-09-08T02:25:30.285Z", price: at },
    ];

    const found = detectOpportunities(
      input({
        listings: [
          listing({ playerId: "at", value: at, prices: rising }),
          listing({ playerId: "over", value: over, prices: rising }),
        ],
      }),
    );

    expect(found.opportunities.map((o) => o.playerId)).toEqual(
      [at, over].filter(couldBeOpportunity).map(() => "at"),
    );
  });
});
