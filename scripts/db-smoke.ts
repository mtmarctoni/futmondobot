/**
 * Exercises every repository write and read against the real database with
 * synthetic data, then removes it.
 *
 * The bulk writes use UNNEST with explicit casts, which unit tests cannot
 * check — a wrong cast or a column-order mistake only shows up against a real
 * Postgres. This is the cheapest way to know the data layer works before any
 * Futmondo credentials exist.
 *
 * Safe to run against a live database: every row it creates is prefixed
 * `smoke-` and deleted at the end, including on failure.
 */
import { getSql } from "../src/lib/db/client";
import * as repo from "../src/lib/db/repo";

const PREFIX = "smoke-";
const DAY = "2000-01-01";
const DAY_BEFORE = "1999-12-31";

function player(id: string, role: "POR" | "DEF" | "MED" | "DEL", value: number) {
  return {
    id: PREFIX + id,
    name: `Smoke ${id}`,
    role,
    team: "Smoke FC",
    teamId: PREFIX + "club",
    value,
    points: 10,
    average: 5.5,
    slug: undefined,
    raw: {},
  };
}

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  const sql = getSql();
  // Ordered so nothing trips a foreign key.
  await sql`DELETE FROM probable_lineups WHERE match_name LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM unavailability WHERE player_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM round_points WHERE player_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM money_events WHERE event_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM transfers WHERE tx_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM player_snapshots WHERE player_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM matches WHERE match_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM rounds WHERE round_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM players WHERE player_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM team_name_history WHERE team_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM teams WHERE team_id LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM action_log WHERE action LIKE ${PREFIX + "%"}`;
}

async function main() {
  const sql = getSql();
  await cleanup();

  // ---------------------------------------------------------- players ------
  const squad = [
    player("gk", "POR", 5_000_000),
    player("df", "DEF", 10_000_000),
    player("md", "MED", 20_000_000),
    player("fw", "DEL", 30_000_000),
  ];
  check("upsertPlayers", (await repo.upsertPlayers(squad)) === 4);

  // A second pass must not wipe a slug learned from a richer endpoint.
  await repo.setPlayerSlug(PREFIX + "fw", "slug-123");
  await repo.upsertPlayers(squad);
  const slugRows = (await sql`
    SELECT slug FROM players WHERE player_id = ${PREFIX + "fw"}`) as Record<string, unknown>[];
  check(
    "upsertPlayers keeps a known slug",
    slugRows[0]?.slug === "slug-123",
    String(slugRows[0]?.slug),
  );

  // ------------------------------------------------------------ teams ------
  const teams = [
    {
      userid: PREFIX + "u1",
      teamId: PREFIX + "t1",
      teamName: "Smoke Mine",
      userName: "Me",
      teamValue: 100_000_000,
      raw: {},
    },
    {
      userid: PREFIX + "u2",
      teamId: PREFIX + "t2",
      teamName: "Smoke Rival",
      userName: "Them",
      teamValue: 90_000_000,
      raw: {},
    },
  ];
  check("upsertTeams", (await repo.upsertTeams(teams, PREFIX + "t1")) === 2);

  const stored = (await repo.getTeams()).filter((t) => t.teamId.startsWith(PREFIX));
  check(
    "getTeams marks my own team",
    stored.find((t) => t.teamId === PREFIX + "t1")?.isMe === true,
  );

  // A rename must not lose the old name: money events match on name only.
  await repo.upsertTeams(
    [{ ...teams[1], teamName: "Smoke Renamed" }],
    PREFIX + "t1",
  );
  const history = (await sql`
    SELECT team_name FROM team_name_history
    WHERE team_id = ${PREFIX + "t2"} ORDER BY team_name`) as Record<string, unknown>[];
  check(
    "team_name_history keeps both names",
    history.length === 2,
    history.map((r) => r.team_name).join(", "),
  );

  // -------------------------------------------------------- snapshots ------
  await repo.writeSnapshots(DAY_BEFORE, [
    { playerId: PREFIX + "fw", value: 28_000_000, points: 8 },
  ]);
  const written = await repo.writeSnapshots(DAY, [
    {
      playerId: PREFIX + "fw",
      value: 30_000_000,
      points: 10,
      average: 5.5,
      ownerTeamId: PREFIX + "t2",
      clausePrice: 45_000_000,
      locked: false,
    },
    { playerId: PREFIX + "gk", value: 5_000_000, points: 4, ownerTeamId: PREFIX + "t1" },
  ]);
  check("writeSnapshots", written === 2);

  // A later cheap pass must not null out the clause a summary sweep found.
  await repo.writeSnapshots(DAY, [{ playerId: PREFIX + "fw", value: 31_000_000 }]);
  const kept = (await sql`
    SELECT value, clause_price FROM player_snapshots
    WHERE player_id = ${PREFIX + "fw"} AND snapshot_date = ${DAY}`) as Record<string, unknown>[];
  check(
    "writeSnapshots merges instead of overwriting",
    Number(kept[0]?.value) === 31_000_000 && Number(kept[0]?.clause_price) === 45_000_000,
    `value=${kept[0]?.value} clause=${kept[0]?.clause_price}`,
  );

  const historyRows = await repo.getValueHistory(PREFIX + "fw", 20_000);
  check(
    "getValueHistory returns ISO dates, newest first",
    historyRows.length === 2 &&
      historyRows[0].date === DAY &&
      historyRows[1].date === DAY_BEFORE,
    historyRows.map((h) => h.date).join(" > "),
  );

  const ownership = (await repo.getLatestOwnership()).filter((o) =>
    o.playerId.startsWith(PREFIX),
  );
  const fw = ownership.find((o) => o.playerId === PREFIX + "fw");
  check(
    "getLatestOwnership joins players and carries team_id",
    fw?.ownerTeamId === PREFIX + "t2" && fw?.teamId === PREFIX + "club",
    `owner=${fw?.ownerTeamId} club=${fw?.teamId}`,
  );

  // ------------------------------------------------- rounds and odds -------
  const rounds = [
    {
      id: PREFIX + "r1",
      number: 1,
      status: "closed",
      raw: {},
      matches: [
        {
          id: PREFIX + "m1",
          date: "2000-01-02T19:00:00.000Z",
          homeTeamId: PREFIX + "club",
          awayTeamId: PREFIX + "other",
          homeTeamName: "Smoke FC",
          awayTeamName: "Other FC",
          raw: {},
        },
      ],
    },
    {
      // Deadline must be the earliest kickoff, not the last.
      id: PREFIX + "r2",
      number: 2,
      status: "open",
      raw: {},
      matches: [
        {
          id: PREFIX + "m3",
          date: "2999-01-05T19:00:00.000Z",
          homeTeamId: PREFIX + "club",
          awayTeamId: PREFIX + "other",
          homeTeamName: "Smoke FC",
          awayTeamName: "Other FC",
          raw: {},
        },
        {
          id: PREFIX + "m2",
          date: "2999-01-03T19:00:00.000Z",
          homeTeamId: PREFIX + "other",
          awayTeamId: PREFIX + "club",
          homeTeamName: "Other FC",
          awayTeamName: "Smoke FC",
          raw: {},
        },
      ],
    },
  ];
  check("upsertRounds", (await repo.upsertRounds(rounds)) === 2);

  const r2 = (await repo.getRounds()).find((r) => r.roundId === PREFIX + "r2");
  check(
    "round deadline is the earliest kickoff",
    r2?.deadline?.startsWith("2999-01-03") === true,
    String(r2?.deadline),
  );

  const next = await repo.getNextRound();
  check(
    "getNextRound finds the upcoming round",
    next?.roundId === PREFIX + "r2",
    String(next?.roundId),
  );

  check(
    "saveOdds",
    (await repo.saveOdds([
      { matchId: PREFIX + "m2", home: 4.0, draw: 3.5, away: 1.8, raw: {} },
    ])) === 1,
  );

  const difficulty = await repo.getFixtureDifficulty();
  const clubDifficulty = difficulty.get(PREFIX + "club");
  // The club plays m2 away, where the away price is the short one (1.80), so
  // this is the marginal favourite: 1/1.8 de-margined against 3.50 and 4.00 is
  // a win probability just over a half, hence difficulty just under it. Also
  // checks the right side of the fixture was read: the opponent must be the
  // home team, and the earliest future match must win over the later one.
  check(
    "getFixtureDifficulty derives difficulty from the correct side of the odds",
    clubDifficulty !== undefined &&
      clubDifficulty.difficulty > 0.45 &&
      clubDifficulty.difficulty < 0.5 &&
      clubDifficulty.opponent === "Other FC",
    `difficulty=${clubDifficulty?.difficulty.toFixed(3)} opponent=${clubDifficulty?.opponent}`,
  );

  // The same match seen from the home side must be the mirror image.
  const otherDifficulty = difficulty.get(PREFIX + "other");
  check(
    "getFixtureDifficulty is consistent from the other side",
    otherDifficulty !== undefined && otherDifficulty.difficulty > 0.7,
    `difficulty=${otherDifficulty?.difficulty.toFixed(3)}`,
  );

  // ----------------------------------------------------- round points ------
  const lineup = {
    roundId: PREFIX + "r1",
    userteamId: PREFIX + "t1",
    strategy: "4-3-3",
    players: [
      {
        playerId: PREFIX + "fw",
        name: "Smoke fw",
        role: "DEL" as const,
        points: 12,
        minutesPlayed: 90,
        goals: 2,
        assists: 1,
        yellowCards: 0,
        redCards: 0,
        started: true,
        raw: {},
      },
      {
        playerId: PREFIX + "gk",
        name: "Smoke gk",
        role: "POR" as const,
        points: 0,
        minutesPlayed: 0,
        started: false,
        raw: {},
      },
    ],
  };
  check("upsertRoundPoints", (await repo.upsertRoundPoints(lineup)) === 2);

  const form = (await repo.getPlayerForm(5)).filter((f) =>
    f.playerId.startsWith(PREFIX),
  );
  const fwForm = form.find((f) => f.playerId === PREFIX + "fw");
  check(
    "getPlayerForm aggregates from closed rounds only",
    fwForm?.avgPoints === 12 && fwForm?.startRate === 1,
    `avg=${fwForm?.avgPoints} startRate=${fwForm?.startRate}`,
  );

  // --------------------------------------------------------- ledgers -------
  const transfers = [
    {
      id: PREFIX + "tx1",
      playerId: PREFIX + "fw",
      playerName: "Smoke fw",
      buyerTeamId: PREFIX + "t2",
      buyerName: "Smoke Rival",
      sellerTeamId: undefined,
      sellerName: undefined,
      price: 25_000_000,
      createdAt: "2000-01-01T10:00:00.000Z",
      raw: {},
    },
  ];
  check("insertTransfers", (await repo.insertTransfers(transfers)) === 1);
  check(
    "insertTransfers is append-only",
    (await repo.insertTransfers(transfers)) === 0,
    "re-inserting the same id writes nothing",
  );

  const events = [
    {
      id: PREFIX + "n1",
      // Matches by the team's *old* name, which is the case that matters.
      teamName: "Smoke Rival",
      amount: 500_000,
      description: "Smoke prize",
      createdAt: "2000-01-01T11:00:00.000Z",
      raw: {},
    },
  ];
  check("insertMoneyEvents", (await repo.insertMoneyEvents(events)) === 1);

  const resolved = (await sql`
    SELECT team_id FROM money_events WHERE event_id = ${PREFIX + "n1"}`) as Record<
    string,
    unknown
  >[];
  check(
    "money events resolve a historical team name to an id",
    resolved[0]?.team_id === PREFIX + "t2",
    String(resolved[0]?.team_id),
  );

  const funds = (await repo.getRivalFunds(210_000_000)).filter((f) =>
    f.teamId.startsWith(PREFIX),
  );
  const rival = funds.find((f) => f.teamId === PREFIX + "t2");
  check(
    "getRivalFunds = budget - spent + received + prizes",
    rival?.estimatedFunds === 210_000_000 - 25_000_000 + 500_000,
    `estimated=${rival?.estimatedFunds} spent=${rival?.spent} prizes=${rival?.prizes}`,
  );

  // ---------------------------------------------------- availability -------
  check(
    "recordUnavailability",
    (await repo.recordUnavailability(DAY, PREFIX + "club", [
      { playerId: PREFIX + "df", name: "Smoke df", reason: "injured", raw: {} },
    ])) === 1,
  );

  // Deliberately dated far in the past, so the 3-day window excludes it.
  const current = await repo.getCurrentUnavailability();
  check(
    "getCurrentUnavailability ignores stale observations",
    !current.has(PREFIX + "df"),
    `${current.size} current entries`,
  );

  // ------------------------------------------------- probable lineups ------
  check(
    "saveProbableLineups",
    (await repo.saveProbableLineups(DAY, [
      {
        matchName: PREFIX + "Smoke fw",
        playerId: PREFIX + "fw",
        teamName: "Smoke FC",
        startProb: 0.3,
        source: "smoke",
      },
    ])) === 1,
  );

  // ------------------------------------------------------ action log -------
  await repo.logAction({
    action: PREFIX + "lineup",
    target: PREFIX + "t1",
    detail: { moves: 2 },
    ok: true,
  });
  const logged = (await repo.getRecentActions(50)).filter((a) =>
    a.action.startsWith(PREFIX),
  );
  check("logAction and getRecentActions", logged.length === 1);

  // ---------------------------------------------------------- session ------
  const before = await repo.loadSession();
  await repo.saveSession("smoke-token", "smoke-user");
  const session = await repo.loadSession();
  check(
    "session round-trips",
    session?.token === "smoke-token" && session?.userid === "smoke-user",
  );
  await repo.clearSession();
  check("clearSession", (await repo.loadSession()) === null);
  // Put back whatever was there, so running this does not log the app out.
  if (before) await repo.saveSession(before.token, before.userid);

  // Empty inputs must be no-ops rather than malformed SQL.
  check(
    "empty inputs are no-ops",
    (await repo.upsertPlayers([])) === 0 &&
      (await repo.writeSnapshots(DAY, [])) === 0 &&
      (await repo.insertTransfers([])) === 0 &&
      (await repo.saveOdds([])) === 0,
  );
}

main()
  .then(async () => {
    await cleanup();
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `\n${checks.length - failed.length}/${checks.length} checks passed.`,
    );
    if (failed.length > 0) process.exit(1);
  })
  .catch(async (err) => {
    await cleanup().catch(() => undefined);
    console.error("\nSmoke test threw:", err);
    process.exit(1);
  });
