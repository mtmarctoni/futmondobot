import { describe, expect, it } from "vitest";
import {
  parseOdds,
  parsePlayerStats,
  asArray,
  num,
  parseActiveChampionships,
  parseAuctionSummary,
  parseChampionshipConfiguration,
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

  // These four are exactly what the live API sends. The table used to be
  // missing "centrocampista", and because an unmappable role makes basePlayer
  // drop the player, every midfielder in the league disappeared from rosters,
  // the market and the database. The old test asserted it mapped "every alias"
  // while never trying the strings the API actually uses.
  it("maps the lowercase Spanish roles the API really returns", () => {
    expect(role("portero")).toBe("POR");
    expect(role("defensa")).toBe("DEF");
    expect(role("centrocampista")).toBe("MED");
    expect(role("delantero")).toBe("DEL");
  });

  it("resolves unseen variants built on the same stems", () => {
    expect(role("mediocentro")).toBe("MED");
    expect(role("Centrocampista Ofensivo")).toBe("MED");
  });

  it("returns undefined for an unknown role so the player is skipped", () => {
    expect(role("WINGBACK")).toBeUndefined();
    expect(role(undefined)).toBeUndefined();
  });
});

/**
 * Captured verbatim from `/1/userteam/roster`. The hand-written fixtures below
 * spell `clause` as a number and omit `market` entirely, which is why the
 * roster silently contributed no clause price and no listing state for a year:
 * the code and the fixture shared the same wrong assumption.
 */
const LIVE_ROSTER_ROW = {
  id: "63a8cd87bfb65a271f11db10",
  name: "Carlos Álvarez",
  slug: "67291985",
  role: "centrocampista",
  role2: "",
  photo: "67291985.png",
  points: 1.8,
  value: 18526493,
  team: "América",
  logo: "america.png",
  teamId: "5200250711398189070000b4",
  status: "",
  rating: 4,
  market: {
    inMarket: true,
    price: 18931044,
    bids: [
      {
        id: "6a98f597b4d723070d417621",
        price: 18204532,
        userTeam: { name: "", slug: "" },
      },
    ],
  },
  direct: false,
  average: {
    average: 0,
    homeAverage: 0,
    awayAverage: 0,
    averageLastFive: 0,
    matches: 0,
    fitness: [],
  },
  change: 0,
  computer: false,
  buyPrice: 0,
  clause: {
    price: 38228076,
    date: "2026-09-07T18:05:10.934Z",
    transferred: false,
    suggestedClause: 24683383,
  },
};

/** The same endpoint, for a player who is not listed for sale. */
const LIVE_ROSTER_ROW_UNLISTED = {
  ...LIVE_ROSTER_ROW,
  id: "68966a3623f462042dbe3298",
  name: "Ugrinic",
  team: "Valencia",
  teamId: "504e581e4d8bec9a670000cb",
  market: false,
  clause: {
    price: 9447611,
    date: "2026-09-07T18:05:10.924Z",
    transferred: false,
    suggestedClause: 4630088,
  },
};

describe("parseRoster on a captured payload", () => {
  it("reads the clause price out of the object the endpoint really sends", () => {
    const [player] = parseRoster([LIVE_ROSTER_ROW]);
    expect(player.clause).toBe(38228076);
  });

  it("reads the market listing and its asking price", () => {
    const [player] = parseRoster([LIVE_ROSTER_ROW]);
    expect(player.onMarket).toBe(true);
    expect(player.askPrice).toBe(18931044);
  });

  it("reports market: false as not listed", () => {
    const [player] = parseRoster([LIVE_ROSTER_ROW_UNLISTED]);
    expect(player.onMarket).toBe(false);
    expect(player.askPrice).toBeUndefined();
    expect(player.clause).toBe(9447611);
  });

  it("keeps the real club, which is what tells us a player has left the league", () => {
    const [player] = parseRoster([LIVE_ROSTER_ROW]);
    expect(player.team).toBe("América");
    expect(player.teamId).toBe("5200250711398189070000b4");
  });

  it("still accepts a flat numeric clause", () => {
    const [player] = parseRoster([
      { id: "p1", name: "Flat", role: "DEF", clause: 1234, locked: true },
    ]);
    expect(player.clause).toBe(1234);
    expect(player.locked).toBe(true);
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

  /**
   * The shape /2/league/matches actually returns. The old test above used the
   * long `home`/`away` spellings, which this endpoint has never sent, so it
   * passed while all 380 real fixtures stored a null team id -- and fixture
   * difficulty, which can only reach a player through their club id, was dead.
   */
  it("reads the h and a keys the endpoint really sends", () => {
    const rounds = parseRoundsWithMatches({
      rounds: [
        {
          _id: "6a4af7efae633549bd0f037f",
          number: 1,
          status: "closed",
          matches: [
            {
              _id: "6a4af7efae633549bd0f0382",
              info: { date: "2026-08-27T19:00:00.000Z" },
              st: "F",
              h: { id: "t-fcb", score: 2, name: "Barcelona", shortname: "FCB" },
              a: { id: "t-ath", score: 0, name: "Athletic de Bilbao", shortname: "ATH" },
            },
          ],
        },
      ],
    });
    expect(rounds[0].matches[0]).toMatchObject({
      homeTeamId: "t-fcb",
      awayTeamId: "t-ath",
      homeTeamName: "Barcelona",
      awayTeamName: "Athletic de Bilbao",
      homeScore: 2,
      awayScore: 0,
      finished: true,
    });
  });

  it("does not read a 0-0 off a fixture that has not been played", () => {
    const rounds = parseRoundsWithMatches({
      rounds: [
        {
          _id: "r1",
          number: 6,
          status: "next",
          matches: [
            {
              _id: "m9",
              info: { date: "2027-09-05T19:00:00Z" },
              st: "N",
              h: { id: "t1", score: 0, name: "Home" },
              a: { id: "t2", score: 0, name: "Away" },
            },
          ],
        },
      ],
    });
    expect(rounds[0].matches[0]).toMatchObject({ finished: false });
    expect(rounds[0].matches[0].homeScore).toBeUndefined();
    expect(rounds[0].matches[0].awayScore).toBeUndefined();
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

describe("parsePlayerStats", () => {
  // The shape /1/userteam/roster really returns under `average`.
  const RAW = {
    average: 4.066666666666666,
    homeAverage: 4.3,
    awayAverage: 3.6,
    averageLastFive: 4.066666666666666,
    matches: 3,
    fitness: [4.1, 3.6, 4.5],
  };

  it("reads the whole scoring record, not just the headline average", () => {
    const stats = parsePlayerStats(RAW);
    expect(stats).toEqual({
      average: 4.066666666666666,
      homeAverage: 4.3,
      awayAverage: 3.6,
      averageLastFive: 4.066666666666666,
      matches: 3,
      fitness: [4.1, 3.6, 4.5],
    });
  });

  it("keeps the zero that marks a round the player missed", () => {
    // Real payload: two appearances across three rounds.
    const stats = parsePlayerStats({ average: 4.1, matches: 2, fitness: [6, 2.2, 0] });
    expect(stats?.fitness).toEqual([6, 2.2, 0]);
    expect(stats?.matches).toBe(2);
  });

  it("reports a debutant as no evidence rather than as a zero scorer", () => {
    const stats = parsePlayerStats({ average: 0, matches: 0, fitness: [] });
    expect(stats).toEqual({
      average: 0,
      homeAverage: undefined,
      awayAverage: undefined,
      averageLastFive: undefined,
      matches: 0,
      fitness: [],
    });
  });

  it("returns nothing for a payload that carries no average at all", () => {
    expect(parsePlayerStats({ matches: 3 })).toBeUndefined();
    expect(parsePlayerStats(7)).toBeUndefined();
    expect(parsePlayerStats(null)).toBeUndefined();
  });
});

describe("parseOdds", () => {
  /**
   * /5/match/odds returns every market the bookmakers price, not a flat
   * result. Reading it as a flat object found nothing, so no fixture was ever
   * priced and every opponent scored as neutral.
   */
  const REAL = {
    odds: [
      {
        mn: "Half Time/Full Time",
        sels: [{ ssn: "2/2", odds: [{ c: 6.85, f: 5.3, bid: "1xbet" }] }],
      },
      {
        mn: "Match Result",
        // Note the order: away, draw, home. Selections must be matched by name.
        sels: [
          { ssn: "2", odds: [{ c: 4.1, f: 4.0, bid: "a" }, { c: 4.2, f: 4.1, bid: "b" }] },
          { ssn: "X", odds: [{ c: 3.66, f: 3.5, bid: "a" }] },
          { ssn: "1", odds: [{ c: 1.85, f: 1.9, bid: "a" }] },
        ],
      },
      { mn: "Correct Score", sels: [{ ssn: "1-0", odds: [{ c: 7.5, bid: "a" }] }] },
    ],
  };

  it("finds the 1X2 market among all the others and keys it by selection", () => {
    const odds = parseOdds("m1", REAL);
    expect(odds?.home).toBe(1.85);
    expect(odds?.draw).toBe(3.66);
    // Median of the two books, so 4.1 and 4.2 do not average into a new price.
    expect(odds?.away).toBe(4.2);
  });

  it("takes the median across books so one stale price cannot swing a fixture", () => {
    const odds = parseOdds("m1", {
      odds: [
        {
          mn: "Match Result",
          sels: [
            { ssn: "1", odds: [{ c: 2.0 }, { c: 2.1 }, { c: 9.9 }] },
            { ssn: "X", odds: [{ c: 3.4 }] },
            { ssn: "2", odds: [{ c: 3.5 }] },
          ],
        },
      ],
    });
    expect(odds?.home).toBe(2.1);
  });

  it("ignores a quote no bookmaker would offer", () => {
    const odds = parseOdds("m1", {
      odds: [{ mn: "Match Result", sels: [{ ssn: "1", odds: [{ c: 0.5 }, { c: 2.5 }] }] }],
    });
    expect(odds?.home).toBe(2.5);
  });

  it("returns nothing when the result market is absent", () => {
    expect(
      parseOdds("m1", { odds: [{ mn: "Total Goals", sels: [{ ssn: "+2.5", odds: [{ c: 1.8 }] }] }] }),
    ).toBeNull();
    expect(parseOdds("m1", { odds: [] })).toBeNull();
  });

  it("still reads a flat shape, in case one is ever served", () => {
    const odds = parseOdds("m1", { odds: { home: 1.5, draw: 4, away: 6 } });
    expect(odds).toMatchObject({ home: 1.5, draw: 4, away: 6 });
  });
});

/**
 * Every fixture below is a captured payload, copied from a live call rather
 * than written from what the code expects. That distinction is the whole point:
 * this suite was green through six separate parser bugs because each fixture
 * was invented from the same wrong assumption as the code it tested.
 */
describe("parseChampionshipConfiguration against the real payload", () => {
  /** Verbatim from /1/championship/configuration for championship 6a95cf...73f. */
  const CAPTURED = {
    configuration: {
      budget: 210000000,
      numberOfPlayers: 15,
      maxPlayersInRoster: 0,
      moneyPerPoint: 0,
      moneyPerRanking: 40000000,
      rankingMode: "flop",
      usersToRank: -1,
      marketPlayers: 12,
      marketTimes: 1,
      bidDuration: 2,
      enableAutomaticClauses: true,
      enablingClause: 2,
      playerRetention: 0,
      playerMoveInDays: 0,
      maxUserteams: 14,
      members: 9,
      blc: true,
      rtv: "auto",
      mnmp: 0.5,
      dspct: 0.8,
      mcpw: -1,
      rcp: -1,
      mdbp: true,
      mbp: 3,
      vmb: 3,
      mtoffset: "-120",
      mtrange: "9-20",
      ctt: false,
      ccr: 1,
      marketStart: "2026-08-30T22:00:00.000Z",
      fullSeason: true,
    },
  };

  it("reads a genuinely zero points bonus rather than falling through", () => {
    // The bug: the parser looked for `perPoint` inside a `bonus` object that
    // does not exist, so this came back undefined and the engine substituted a
    // hardcoded 60.000€ per point. Every prize-money figure in the app was
    // fiction. Zero has to survive as zero.
    const config = parseChampionshipConfiguration(CAPTURED);
    expect(config.pointBonus).toBe(0);
  });

  it("reads the ranking pool, which is where the money actually comes from", () => {
    const config = parseChampionshipConfiguration(CAPTURED);
    expect(config.rankingBonus).toBe(40_000_000);
    expect(config.rankingMode).toBe("flop");
  });

  it("reads the market rules the bidding and clause logic depend on", () => {
    const config = parseChampionshipConfiguration(CAPTURED);
    expect(config.budget).toBe(210_000_000);
    expect(config.initialPlayers).toBe(15);
    expect(config.marketPlayers).toBe(12);
    expect(config.bidDurationDays).toBe(2);
    expect(config.clauseWindowDays).toBe(2);
    expect(config.directSellShare).toBe(0.8);
    expect(config.minListingShare).toBe(0.5);
    expect(config.automaticClauses).toBe(true);
    expect(config.clauseBlockingEnabled).toBe(true);
  });

  it("accepts the same keys at the top level, without the wrapper", () => {
    const config = parseChampionshipConfiguration(CAPTURED.configuration);
    expect(config.pointBonus).toBe(0);
    expect(config.directSellShare).toBe(0.8);
  });
});

describe("parseMarket bid counts", () => {
  it("reads numberOfBids, which is the key the payload actually uses", () => {
    // The parser looked for `bids`/`numBids`/`offers`, so this was permanently
    // undefined for every listing ever parsed.
    const [player] = parseMarket([
      {
        id: "p1",
        name: "Pedri",
        role: "MED",
        value: 30000000,
        price: 30000000,
        numberOfBids: 20,
      },
    ]);
    expect(player.numberOfBids).toBe(20);
  });

  it('maps the hidden "-" to null rather than swallowing it', () => {
    // "-" is a string, and a strict numeric conversion turns it into undefined,
    // which is indistinguishable from "no bids". They are different facts.
    const [player] = parseMarket([
      {
        id: "p1",
        name: "Pedri",
        role: "MED",
        value: 30000000,
        price: 30000000,
        numberOfBids: "-",
      },
    ]);
    expect(player.numberOfBids).toBeNull();
  });

  it("reads the standing bids on our own listing, as /1/market/myplayers sends", () => {
    // Captured from /1/market/myplayers. The bidder's team is blanked: bids are
    // sealed as to identity but not as to price.
    const [listing] = parseMarket([
      {
        id: "63a8cd87bfb65a271f11db10",
        name: "Carlos Álvarez",
        role: "MED",
        value: 18931044,
        price: 18931044,
        expirationDate: "2026-09-04T18:17:09.885Z",
        bids: [
          {
            id: "6a98f597b4d723070d417621",
            price: 18204532,
            userTeam: { name: "", slug: "" },
          },
        ],
      },
    ]);

    expect(listing.bids).toHaveLength(1);
    expect(listing.bids?.[0].price).toBe(18_204_532);
    expect(listing.bids?.[0].bidderTeamName).toBeUndefined();
    expect(listing.expiresAt).toBe("2026-09-04T18:17:09.885Z");
  });
});

describe("parseAuctionSummary", () => {
  it("reads the minimum bid step, which is what a considered bid needs", () => {
    const summary = parseAuctionSummary("p1", {
      numberOfBids: 20,
      marketPlayer: {},
      increment: 250000,
    });
    expect(summary?.increment).toBe(250_000);
    expect(summary?.numberOfBids).toBe(20);
  });

  it("returns null rather than throwing on an unrecognised answer", () => {
    expect(parseAuctionSummary("p1", "nope")).toBeNull();
  });
});

describe("parsePlayerSummary against the real payload", () => {
  /** Trimmed from a live /1/player/summary response, keys and values verbatim. */
  const CAPTURED = {
    data: {
      slug: "19302146",
      rating: 2,
      total: { points: 12.2, played: 3 },
    },
    points: [
      { round: 1, points: 4.1, isHomeTeam: true, minutesPlayed: 1, initialLineUp: true, st: "st" },
      { round: 2, points: 3.9, isHomeTeam: false, minutesPlayed: 1, initialLineUp: true, st: "st" },
      { round: 3, points: 4.2, isHomeTeam: true, minutesPlayed: 1, initialLineUp: false, st: "bc" },
    ],
    prices: [
      { date: "2026-08-29T02:25:30.285Z", price: 2590865, c: 1000000, s: 500871 },
      { date: "2026-08-30T02:25:30.285Z", price: 2620000, c: 1000000, s: 500871 },
    ],
    owners: [{ n: "Ted Lasso's Playbook", p: 0, d: "2026-09-02T18:05:10.923Z" }],
    championship: {
      clause: {
        price: 9627619,
        date: "2026-09-07T18:05:10.923Z",
        transferred: false,
        suggestedClause: 5000341,
      },
      owner: { _id: "6a98655603bfa804dd19cb52" },
    },
  };

  it("reads the clause window, which decides whether any clause advice applies", () => {
    const summary = parsePlayerSummary("p1", CAPTURED);
    expect(summary?.clausePrice).toBe(9_627_619);
    expect(summary?.clauseDate).toBe("2026-09-07T18:05:10.923Z");
    expect(summary?.suggestedClause).toBe(5_000_341);
    expect(summary?.clauseTransferred).toBe(false);
  });

  it("has no lock state to read, because no payload carries one", () => {
    // Asserted rather than assumed. The clause object is exactly
    // {price, date, transferred, suggestedClause}; if a `locked` field ever
    // appears this test is where it will be noticed.
    const summary = parsePlayerSummary("p1", CAPTURED);
    expect(summary?.locked).toBeUndefined();
  });

  it("reads the measured start record from points[]", () => {
    const summary = parsePlayerSummary("p1", CAPTURED);
    expect(summary?.rounds.map((r) => r.initialLineUp)).toEqual([true, true, false]);
    expect(summary?.rounds[2].state).toBe("bc");
    expect(summary?.rounds[0].points).toBe(4.1);
  });

  it("falls back to st when initialLineUp is absent", () => {
    const summary = parsePlayerSummary("p1", {
      points: [{ round: 1, points: 4, st: "st" }],
    });
    expect(summary?.rounds[0].initialLineUp).toBe(true);
  });

  it("reads value history but not the fields whose meaning is unknown", () => {
    const summary = parsePlayerSummary("p1", CAPTURED);
    expect(summary?.prices).toEqual([
      { date: "2026-08-29T02:25:30.285Z", price: 2_590_865 },
      { date: "2026-08-30T02:25:30.285Z", price: 2_620_000 },
    ]);
  });

  it("reads when the current owner acquired them", () => {
    const summary = parsePlayerSummary("p1", CAPTURED);
    expect(summary?.acquiredAt).toBe("2026-09-02T18:05:10.923Z");
    expect(summary?.ownerTeamId).toBe("6a98655603bfa804dd19cb52");
  });

  it("stays total on a payload with none of it", () => {
    const summary = parsePlayerSummary("p1", { data: { slug: "abc" } });
    expect(summary?.rounds).toEqual([]);
    expect(summary?.prices).toEqual([]);
    expect(summary?.clauseDate).toBeUndefined();
  });
});

describe("player status", () => {
  it("is parsed off the roster row, where it costs no extra call", () => {
    const [player] = parseRoster([
      {
        id: "p1",
        name: "Vargas",
        role: "delantero",
        value: 17341658,
        points: 0,
        status: "doubt",
      },
    ]);
    expect(player.status).toBe("doubt");
  });

  it("is parsed off a market listing, which the club endpoint never reaches", () => {
    const [player] = parseMarket([
      {
        id: "p2",
        name: "Odriozola",
        role: "defensa",
        value: 1000000,
        price: 1000000,
        status: "injured",
      },
    ]);
    expect(player.status).toBe("injured");
  });
});
