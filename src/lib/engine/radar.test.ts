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
  detectOpportunities,
  type RadarListing,
} from "./radar";

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
    const found = detectOpportunities({
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
    });

    expect(found.opportunities.map((o) => o.playerId)).toEqual(["a"]);
    expect(found.opportunities[0].dailyChange).toBe(100_000);
  });

  it("excludes a player one euro over the ceiling", () => {
    const found = detectOpportunities({
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
    });

    expect(found.opportunities).toEqual([]);
  });

  it("excludes a player whose value is flat today", () => {
    const found = detectOpportunities({
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
    });

    expect(found.opportunities).toEqual([]);
  });

  it("excludes a player whose value fell today", () => {
    const found = detectOpportunities({
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
    });

    expect(found.opportunities).toEqual([]);
  });

  it("orders by percentage rise, not by euros gained", () => {
    const found = detectOpportunities({
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
    });

    expect(found.opportunities.map((o) => o.playerId)).toEqual([
      "bigger-percent",
      "bigger-euros",
    ]);
  });

  it("reports a single price point as unknown rather than flat", () => {
    const found = detectOpportunities({
      listings: [
        listing({
          playerId: "new-arrival",
          prices: [{ date: "2026-09-08T02:25:30.285Z", price: 2_000_000 }],
        }),
      ],
      ceiling: 50_000_000,
    });

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("reports a missing price series as unknown rather than flat", () => {
    const found = detectOpportunities({
      listings: [listing({ playerId: "unread", prices: [] })],
      ceiling: 50_000_000,
    });

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(1);
  });

  it("does not count a player priced out of the module as unknown", () => {
    const found = detectOpportunities({
      listings: [
        listing({ playerId: "expensive", value: 12_000_000, prices: [] }),
      ],
      ceiling: 50_000_000,
    });

    expect(found.unknownChange).toBe(0);
  });

  it("reads the daily change from the two newest points of an unsorted series", () => {
    const found = detectOpportunities({
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
    });

    expect(found.opportunities[0].dailyChange).toBe(100_000);
  });

  it("suggests a bid above the asking price, on the auction step", () => {
    const found = detectOpportunities({
      listings: [listing({ playerId: "a", price: 2_000_000, increment: 250_000 })],
      ceiling: 50_000_000,
    });

    const [opportunity] = found.opportunities;
    expect(opportunity.suggestedBid).toBeGreaterThan(opportunity.price);
    expect((opportunity.suggestedBid - opportunity.price) % 250_000).toBe(0);
  });

  it("never suggests a bid above what the ceiling allows", () => {
    const found = detectOpportunities({
      listings: [listing({ playerId: "a", price: 2_000_000 })],
      ceiling: 2_000_000,
    });

    expect(found.opportunities[0].suggestedBid).toBe(2_000_000);
  });

  it("returns nothing for an empty market rather than throwing", () => {
    const found = detectOpportunities({ listings: [], ceiling: 50_000_000 });

    expect(found.opportunities).toEqual([]);
    expect(found.unknownChange).toBe(0);
  });
});
