/**
 * Which opportunities are new to this browser.
 *
 * Pure on purpose: the alert is the only part of the radar the user cannot
 * scroll back to, so "did we already tell them" has to be testable without a
 * DOM. The React hook over it does nothing but read and write localStorage.
 */
import { describe, expect, it } from "vitest";

import { newIds, parseSeen } from "./unseen";

describe("newIds", () => {
  it("treats everything as new the first time", () => {
    expect(newIds(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("says nothing is new when all of it has been seen", () => {
    expect(newIds(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("returns only the ids that were not seen before", () => {
    expect(newIds(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  it("keeps the order of the current list, which is the ranking", () => {
    expect(newIds(["c", "a", "b"], [])).toEqual(["c", "a", "b"]);
  });

  it("ignores a seen id that is no longer listed", () => {
    expect(newIds(["a"], ["gone", "a"])).toEqual([]);
  });

  it("alerts again for a listing that returns after dropping off", () => {
    // Seen state is replaced by the current list, not accumulated, so storage
    // stays bounded. The cost is that a relisted player alerts a second time,
    // which is the right side to err on: it is a genuinely new listing.
    const afterFirstRun = ["a"];
    expect(newIds([], afterFirstRun)).toEqual([]);
    expect(newIds(["a"], [])).toEqual(["a"]);
  });

  it("returns nothing for an empty market", () => {
    expect(newIds([], ["a"])).toEqual([]);
  });
});

describe("parseSeen", () => {
  it("reads a stored list of ids", () => {
    expect(parseSeen('["a","b"]')).toEqual(["a", "b"]);
  });

  it("treats a missing store as nothing seen", () => {
    expect(parseSeen(null)).toEqual([]);
  });

  it("treats an empty store as nothing seen", () => {
    expect(parseSeen("")).toEqual([]);
  });

  it("survives a corrupted store rather than throwing", () => {
    // The alert repeating is a far cheaper failure than the page not rendering.
    expect(parseSeen("{not json")).toEqual([]);
  });

  it("ignores a stored value that is not a list", () => {
    expect(parseSeen('{"a":1}')).toEqual([]);
  });

  it("drops non-string entries rather than trusting the store", () => {
    expect(parseSeen('["a",1,null,"b"]')).toEqual(["a", "b"]);
  });
});
