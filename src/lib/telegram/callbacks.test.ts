import { describe, expect, it } from "vitest";
import {
  decodeCallback,
  encodeCallback,
  needsConfirmation,
} from "./callbacks";

describe("callback encoding", () => {
  it("round-trips an unconfirmed money action", () => {
    const data = encodeCallback({
      verb: "clause",
      playerId: "5b33408c744d2a591d3e566e",
      price: 112508105,
      confirmed: false,
    });
    expect(decodeCallback(data)).toEqual({
      verb: "clause",
      playerId: "5b33408c744d2a591d3e566e",
      price: 112508105,
      confirmed: false,
    });
  });

  it("round-trips a confirmed action distinctly from an unconfirmed one", () => {
    const args = {
      verb: "bid" as const,
      playerId: "abc123",
      price: 5_000_000,
    };
    const pending = encodeCallback({ ...args, confirmed: false });
    const confirmed = encodeCallback({ ...args, confirmed: true });

    expect(pending).not.toBe(confirmed);
    expect(decodeCallback(pending)?.confirmed).toBe(false);
    expect(decodeCallback(confirmed)?.confirmed).toBe(true);
  });

  it("stays inside Telegram's 64-byte callback_data limit for real ids", () => {
    const data = encodeCallback({
      verb: "clause",
      // Futmondo ids are 24-character Mongo ObjectIds.
      playerId: "5b33408c744d2a591d3e566e",
      price: 999_999_999,
      confirmed: true,
    });
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });

  it("refuses to build oversized callback data rather than truncating it", () => {
    expect(() =>
      encodeCallback({
        verb: "clause",
        playerId: "x".repeat(80),
        price: 1,
        confirmed: false,
      }),
    ).toThrowError(/64-byte limit/);
  });

  it("rounds a fractional price, since prices are whole euros", () => {
    const data = encodeCallback({
      verb: "bid",
      playerId: "p1",
      price: 1234.7,
      confirmed: false,
    });
    expect(decodeCallback(data)?.price).toBe(1235);
  });

  it("rejects data that is not one of our verbs", () => {
    expect(decodeCallback("delete:p1")).toBeNull();
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback("bid:p1:notanumber")).toBeNull();
  });

  it("does not mistake a verb starting with the confirm prefix", () => {
    // "y" + "bid" is confirmed; a bare verb must stay unconfirmed.
    expect(decodeCallback("bid:p1:100")?.confirmed).toBe(false);
    expect(decodeCallback("ybid:p1:100")?.confirmed).toBe(true);
  });

  it("treats a refresh with no player as valid", () => {
    const data = encodeCallback({ verb: "refresh", confirmed: false });
    expect(decodeCallback(data)).toEqual({
      verb: "refresh",
      playerId: undefined,
      price: undefined,
      confirmed: false,
    });
  });
});

describe("needsConfirmation", () => {
  it("requires confirmation for everything that moves money", () => {
    expect(needsConfirmation("bid")).toBe(true);
    expect(needsConfirmation("clause")).toBe(true);
    expect(needsConfirmation("sell")).toBe(true);
  });

  it("does not require it for free, reversible actions", () => {
    expect(needsConfirmation("lock")).toBe(false);
    expect(needsConfirmation("refresh")).toBe(false);
  });
});
