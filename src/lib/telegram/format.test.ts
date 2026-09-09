/**
 * What the bot says about a low-value opportunity.
 *
 * The wording matters more than it looks: this section recommends spending
 * money, and every figure in it has to survive being read on a phone with no
 * report open. So the tests pin the claims, not the layout.
 */
import { describe, expect, it } from "vitest";

import type { LowValueOpportunity, RadarReport } from "../engine/radar";

import { formatOpportunities } from "./index";

function opportunity(over: Partial<LowValueOpportunity> = {}): LowValueOpportunity {
  return {
    playerId: "p1",
    name: "Cheap Player",
    role: "DEFENSA",
    clubName: "Test Club",
    value: 2_000_000,
    price: 2_000_000,
    dailyChange: 100_000,
    dailyChangePct: 0.0526,
    suggestedBid: 2_250_000,
    increment: 250_000,
    ...over,
  };
}

function radar(over: Partial<RadarReport> = {}): RadarReport {
  return { opportunities: [], unknownChange: 0, ...over };
}

describe("formatOpportunities", () => {
  it("says nothing at all when the market has no opportunity", () => {
    expect(formatOpportunities(radar())).toBe("");
  });

  it("names the player, the value, the rise and the bid", () => {
    const text = formatOpportunities(radar({ opportunities: [opportunity()] }));

    expect(text).toContain("Cheap Player");
    expect(text).toContain("2.00M€");
    expect(text).toContain("+100k€");
    expect(text).toContain("2.25M€");
  });

  it("shows the rise as a percentage as well as in euros", () => {
    const text = formatOpportunities(
      radar({ opportunities: [opportunity({ dailyChangePct: 0.0526 })] }),
    );

    expect(text).toMatch(/5\.3%/);
  });

  it("distinguishes the asking price from the bid it recommends", () => {
    const text = formatOpportunities(
      radar({
        opportunities: [opportunity({ price: 2_000_000, suggestedBid: 2_250_000 })],
      }),
    );

    // Both figures present, so the reader can see the bid clears the floor.
    expect(text).toContain("2.00M€");
    expect(text).toContain("2.25M€");
  });

  it("escapes a player name that would otherwise break the HTML", () => {
    const text = formatOpportunities(
      radar({ opportunities: [opportunity({ name: "A<b>&C" })] }),
    );

    expect(text).toContain("A&lt;b&gt;&amp;C");
  });

  it("says how many listings it could not judge", () => {
    const text = formatOpportunities(
      radar({ opportunities: [opportunity()], unknownChange: 3 }),
    );

    expect(text).toMatch(/3/);
    // "no value history" would be a lie about a series that was read but is
    // stale or has a hole in it. What is missing is a *daily* change.
    expect(text.toLowerCase()).toContain("daily change");
  });

  it("stays silent about unreadable listings when there is nothing to report", () => {
    // No opportunities means no section, so there is nowhere to hang the note
    // and no decision it could change.
    expect(formatOpportunities(radar({ unknownChange: 3 }))).toBe("");
  });

  it("carries no emoji, per the house style", () => {
    const text = formatOpportunities(radar({ opportunities: [opportunity()] }));

    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("formatOpportunities and message size", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    opportunity({ playerId: `p${i}`, name: `Player Number ${i}` }),
  );

  it("caps the list so one busy market cannot kill the daily message", () => {
    // Telegram rejects a message over 4096 characters outright, and this
    // section shares one message with the XI, the actions and the departures.
    // An unbounded list would mean the whole report fails to send on exactly
    // the day the market is most interesting.
    const text = formatOpportunities(radar({ opportunities: many }));

    expect(text.length).toBeLessThan(1000);
  });

  it("says how many it left out rather than truncating in silence", () => {
    const text = formatOpportunities(radar({ opportunities: many }));

    expect(text).toMatch(/25 more/);
  });

  it("keeps the best of them, since the list is ranked", () => {
    const text = formatOpportunities(radar({ opportunities: many }));

    expect(text).toContain("Player Number 0");
    expect(text).not.toContain("Player Number 29");
  });
});
