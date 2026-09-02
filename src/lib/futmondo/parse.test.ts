import { describe, expect, it } from "vitest";
import {
  asArray,
  num,
  parseActiveChampionships,
  parseChampionshipTeams,
  parseCurrentLineup,
  parseMarket,
  parseMoneyEvents,
  parsePlayerSummary,
  parseRanking,
  parseRoster,
  parseRoundLineup,
  parseRoundsWithMatches,
  parseStrategies,
  parseTransfers,
  parseUserTeamInformation,
  role,
} from "./parse";

describe("asArray", () => {
  it("accepts a bare array answer, as /1/userteam/roster sends", () => {
    expect(asArray([{ a: 1 }], "players")).toEqual([{ a: 1 }]);
  });

  it("unwraps a named key, as /2/championship/teams sends", () => {
    expect(asArray({ teams: [{ a: 1 }] }, "teams")).toEqual([{ a: 1 }]);
  });

  it("falls back to any array property when the wrapper key is renamed", () => {
    expect(asArray({ somethingNew: [{ a: 1 }] }, "teams")).toEqual([{ a: 1 }]);
  });

  it("returns empty rather than throwing on an unexpected shape", () => {
    expect(asArray(null, "teams")).toEqual([]);
    expect(asArray("nope", "teams")).toEqual([]);
    expect(asArray({ teams: 5 }, "teams")).toEqual([]);
  });

  it("drops non-object entries", () => {
    expect(asArray([{ a: 1 }, null, "x", 3], "players")).toEqual([{ a: 1 }]);
  });
});

describe("num", () => {
  it("parses numeric strings, which Futmondo mixes with numbers", () => {
    expect(num("112508105")).toBe(112508105);
    expect(num(112508105)).toBe(112508105);
  });

  it("keeps genuine decimals", () => {
    expect(num("6.5")).toBe(6.5);
    expect(num("-3")).toBe(-3);
  });

  it("rejects non-numeric input instead of returning zero", () => {
    expect(num("abc")).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num(Number.NaN)).toBeUndefined();
    expect(num("")).toBeUndefined();
  });

  it("rejects separator-formatted input rather than guessing", () => {
    // "1.500" is ambiguous between 1500 and 1.5. These values are euros, so a
    // wrong guess would mis-price a bid; refusing to parse is the safe answer.
    expect(num("1.500.000")).toBeUndefined();
    expect(num("1,500")).toBeUndefined();
  });
});

describe("role", () => {
  it("maps every alias onto the four Futmondo roles", () => {
    expect(role("POR")).toBe("POR");
    expect(role("gk")).toBe("POR");
    expect(role("Delantero")).toBe("DEL");
    expect(role("MC")).toBe("MED");
  });

  it("returns undefined for an unknown role so the player is skipped", () => {
    expect(role("WINGBACK")).toBeUndefined();
    expect(role(undefined)).toBeUndefined();
  });
});

describe("parseRoster", () => {
  it("reads the documented roster shape", () => {
    const players = parseRoster([
      {
        id: "p1",
        name: "Vinicius",
        role: "DEL",
        team: "Real Madrid",
        teamId: "t1",
        value: 50000000,
        points: 120,
        buyPrice: 45000000,
      },
    ]);
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({
      id: "p1",
      name: "Vinicius",
      role: "DEL",
      team: "Real Madrid",
      teamId: "t1",
      value: 50000000,
      points: 120,
      buyPrice: 45000000,
    });
  });

  it("resolves a nested team object", () => {
    const [player] = parseRoster([
      {
        _id: "p2",
        name: "Lewandowski",
        role: "DEL",
        team: { _id: "t2", name: "Barcelona" },
        value: "40000000",
      },
    ]);
    expect(player.team).toBe("Barcelona");
    expect(player.teamId).toBe("t2");
    expect(player.value).toBe(40000000);
  });

  it("skips rows missing an id, name or role rather than emitting junk", () => {
    expect(
      parseRoster([
        { id: "p3", role: "DEF" },
        { name: "No Id", role: "DEF" },
        { id: "p4", name: "No Role" },
      ]),
    ).toEqual([]);
  });

  it("defaults value and points to zero when absent", () => {
    const [player] = parseRoster([{ id: "p5", name: "X", role: "MED" }]);
    expect(player.value).toBe(0);
    expect(player.points).toBe(0);
  });
});

describe("parseMarket", () => {
  it("treats a listing with no seller as machine-owned", () => {
    const [player] = parseMarket({
      players: [
        { id: "p1", name: "Pedri", role: "MED", value: 30000000, price: 30000000 },
      ],
    });
    expect(player.fromComputer).toBe(true);
    expect(player.price).toBe(30000000);
  });

  it("records the selling rival when one is present", () => {
    const [player] = parseMarket([
      {
        id: "p2",
        name: "Gavi",
        role: "MED",
        value: 20000000,
        price: 25000000,
        computer: false,
        userteam: { _id: "team9", name: "Rival FC" },
      },
    ]);
    expect(player.fromComputer).toBe(false);
    expect(player.sellerTeamId).toBe("team9");
    expect(player.price).toBe(25000000);
  });

  it("falls back to value when no price is quoted", () => {
    const [player] = parseMarket([
      { id: "p3", name: "Raphinha", role: "DEL", value: 35000000 },
    ]);
    expect(player.price).toBe(35000000);
  });
});

describe("parsePlayerSummary", () => {
  it("digs the clause price out of answer.championship.clause.price", () => {
    const summary = parsePlayerSummary("p1", {
      data: { slug: "19302146" },
      championship: { clause: { price: 112508105, locked: false } },
    });
    expect(summary).toMatchObject({
      playerId: "p1",
      slug: "19302146",
      clausePrice: 112508105,
      locked: false,
    });
  });

  it("returns a summary without a clause price when the block is missing", () => {
    const summary = parsePlayerSummary("p1", { data: { slug: "abc" } });
    expect(summary?.slug).toBe("abc");
    expect(summary?.clausePrice).toBeUndefined();
  });

  it("returns null for a non-object answer", () => {
    expect(parsePlayerSummary("p1", null)).toBeNull();
  });
});

describe("parseUserTeamInformation", () => {
  it("reads funds and team value under any of the observed key names", () => {
    expect(parseUserTeamInformation({ funds: 5000000, teamValue: 210000000 })).toMatchObject(
      { funds: 5000000, teamValue: 210000000 },
    );
    expect(parseUserTeamInformation({ money: 7000000, value: 100 })).toMatchObject({
      funds: 7000000,
      teamValue: 100,
    });
  });

  it("defaults to zero rather than NaN so affordability maths stays safe", () => {
    const info = parseUserTeamInformation(null);
    expect(info.funds).toBe(0);
    expect(info.teamValue).toBe(0);
    expect(info.reserved).toBe(0);
  });
});

describe("parseActiveChampionships", () => {
  it("requires both a championship id and a user team id", () => {
    const rows = parseActiveChampionships({
      championships: [
        {
          _id: "c1",
          name: "Mata D Yonk",
          userteam: { _id: "t1", name: "My Team" },
          leagueId: "l1",
        },
        { _id: "c2", name: "No team here" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "c1",
      name: "Mata D Yonk",
      userteamId: "t1",
      userteamName: "My Team",
      leagueId: "l1",
    });
  });

  it("accepts a flattened userteamId", () => {
    const [row] = parseActiveChampionships([
      { _id: "c1", name: "L", userteamId: "t9" },
    ]);
    expect(row.userteamId).toBe("t9");
  });
});

describe("parseChampionshipTeams", () => {
  it("prefers the lowercase teamid the endpoint actually sends", () => {
    const [team] = parseChampionshipTeams({
      teams: [
        {
          userid: "u1",
          teamid: "t1",
          _id: "ignored",
          teamname: "Bichos Team",
          name: "Real Person",
          teamValue: 150000000,
        },
      ],
    });
    expect(team).toMatchObject({
      userid: "u1",
      teamId: "t1",
      teamName: "Bichos Team",
      userName: "Real Person",
      teamValue: 150000000,
    });
  });

  it("falls back to the team id when no stable userid is sent", () => {
    const [team] = parseChampionshipTeams({ teams: [{ teamid: "t2" }] });
    expect(team.userid).toBe("t2");
  });
});

describe("parseRanking", () => {
  it("reads answer.ranking with points defaulted", () => {
    const rows = parseRanking({
      ranking: [
        { id: "t1", teamname: "A", points: 88, position: 1 },
        { id: "t2", teamname: "B" },
      ],
    });
    expect(rows[0]).toMatchObject({ teamId: "t1", points: 88, position: 1 });
    expect(rows[1].points).toBe(0);
  });
});

describe("parseRoundsWithMatches", () => {
  it("keeps round ids and kickoff times, which is how the deadline is derived", () => {
    const rounds = parseRoundsWithMatches({
      rounds: [
        {
          _id: "r1",
          number: 1,
          status: "closed",
          matches: [
            {
              _id: "m1",
              info: { date: "2026-09-05T19:00:00Z" },
              home: { _id: "t1", name: "Home" },
              away: { _id: "t2", name: "Away" },
            },
          ],
        },
      ],
    });
    expect(rounds[0]).toMatchObject({ id: "r1", number: 1, status: "closed" });
    expect(rounds[0].matches[0]).toMatchObject({
      id: "m1",
      date: "2026-09-05T19:00:00Z",
      homeTeamId: "t1",
      awayTeamId: "t2",
    });
  });

  it("keeps a round that has no matches yet", () => {
    const rounds = parseRoundsWithMatches({
      rounds: [{ _id: "r2", number: 2, status: "pending" }],
    });
    expect(rounds[0].matches).toEqual([]);
  });
});

describe("parseRoundLineup", () => {
  it("lifts match stats out of detailedPoints.data", () => {
    const lineup = parseRoundLineup("r1", "t1", {
      strategy: "4-3-3",
      players: [
        {
          id: "p1",
          name: "Oyarzabal",
          role: "DEL",
          points: 11,
          detailedPoints: {
            data: { mins_played: 90, goals: 1, goal_assist: 1, yellow_card: 0 },
          },
        },
      ],
    });
    expect(lineup.strategy).toBe("4-3-3");
    expect(lineup.players[0]).toMatchObject({
      playerId: "p1",
      points: 11,
      minutesPlayed: 90,
      goals: 1,
      assists: 1,
      started: true,
    });
  });

  it("marks benched players as not started", () => {
    const lineup = parseRoundLineup("r1", "t1", {
      players: [{ id: "p2", name: "Sub", role: "MED", points: 0, bench: true }],
    });
    expect(lineup.players[0].started).toBe(false);
  });

  it("survives a player row with no detailedPoints block", () => {
    const lineup = parseRoundLineup("r1", "t1", {
      players: [{ id: "p3", name: "Plain", role: "DEF", points: 4 }],
    });
    expect(lineup.players[0].minutesPlayed).toBeUndefined();
    expect(lineup.players[0].points).toBe(4);
  });
});

describe("parseCurrentLineup", () => {
  it("splits the XI from the bench using the bench flag", () => {
    const lineup = parseCurrentLineup({
      strategy: "4-3-3",
      players: [
        { id: "p1", name: "A", role: "POR", position: 0, bench: false },
        { id: "p2", name: "B", role: "DEF", position: 1, bench: true },
      ],
    });
    expect(lineup.players.map((p) => p.playerId)).toEqual(["p1"]);
    expect(lineup.bench.map((p) => p.playerId)).toEqual(["p2"]);
  });

  it("merges a separately nested bench without duplicating players", () => {
    const lineup = parseCurrentLineup({
      players: [{ id: "p1", name: "A", role: "POR" }],
      bench: { players: [{ id: "p1" }, { id: "p9", name: "Sub" }] },
    });
    expect(lineup.bench.map((p) => p.playerId)).toEqual(["p9"]);
  });
});

describe("parseStrategies", () => {
  it("reads formation names from strings or objects", () => {
    expect(parseStrategies(["4-3-3", "4-4-2"])).toEqual(["4-3-3", "4-4-2"]);
    expect(parseStrategies({ strategies: [{ name: "3-5-2" }] })).toEqual(["3-5-2"]);
  });

  it("de-duplicates", () => {
    expect(parseStrategies(["4-3-3", "4-3-3"])).toEqual(["4-3-3"]);
  });
});

describe("parseTransfers", () => {
  it("reads the nested player, buyer and seller objects", () => {
    const [tx] = parseTransfers({
      news: [
        {
          _id: "tx1",
          _player: { _id: "p1", name: "Griezmann" },
          _buyer: { _id: "t1", name: "Buyer FC" },
          _seller: { _id: "t2", name: "Seller FC" },
          price: 30000000,
          created: "2026-08-30T10:00:00Z",
        },
      ],
    });
    expect(tx).toMatchObject({
      id: "tx1",
      playerId: "p1",
      playerName: "Griezmann",
      buyerTeamId: "t1",
      sellerTeamId: "t2",
      price: 30000000,
    });
  });

  it("leaves the counterparty absent when Futmondo itself traded", () => {
    const [tx] = parseTransfers({
      news: [
        {
          _id: "tx2",
          _player: { name: "Someone" },
          _buyer: { _id: "t1", name: "Buyer" },
          price: 1000,
        },
      ],
    });
    expect(tx.sellerTeamId).toBeUndefined();
    expect(tx.buyerTeamId).toBe("t1");
  });
});

describe("parseMoneyEvents", () => {
  it("keeps only customize rows, which is where prize money lives", () => {
    const events = parseMoneyEvents({
      news: [
        {
          _id: "n1",
          styp: "customize",
          data: { name: "Bichos Team", amount: 15000000, text: "Prima ranking" },
          created: "2026-08-30T10:00:00Z",
        },
        { _id: "n2", styp: "transfer", data: { name: "Other", amount: 5 } },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "n1",
      teamName: "Bichos Team",
      amount: 15000000,
    });
  });
});
