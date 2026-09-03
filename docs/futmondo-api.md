# Futmondo private API reference

Unofficial. Derived on 2026-09-02 by extracting endpoint literals and their query
shapes from the compiled Flutter bundle at `https://app.futmondo.com/main.dart.js`,
then cross-checking request/response shapes against community clients that run in
production:

- [lluc898/futmondojobs](https://github.com/lluc898/futmondojobs) — `services/futmondo_client.py`, has tests
- [Th3Gerb7/Futmondo-Tracking](https://github.com/Th3Gerb7/Futmondo-Tracking) — `CLAUDE.md` documents pagination behaviour
- [kelo71bis/FutmondoBOT](https://github.com/kelo71bis/FutmondoBOT) — `roundlineup`, `league/matches`
- [alehandermartins/catorrasso](https://github.com/alehandermartins/catorrasso) — clause + bid payloads
- [Mutinho/futmondo-analytics](https://github.com/Mutinho/futmondo-analytics)

Futmondo publishes none of this. It can change without notice. Treat every response
field as optional.

## Coverage of this document

The bundle contains **173 distinct endpoint paths**, 163 of which are reachable
through the client's request helper. The tables below document the ~74 this app
uses or could plausibly use, with their query shapes and the parts of `answer`
we rely on. The rest — championship administration, cups, head-to-head, shop,
notifications, profile management — are listed by name under
[Other](#other) without detail.

An endpoint missing from the tables is therefore not necessarily missing from the
API. To re-derive the full list:

```bash
curl -s https://app.futmondo.com/main.dart.js \
  | grep -oE '"/[0-9]{1,2}/[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*"' \
  | sort -u
```

Query shapes come from the `A.aE("<path>", A.l([...]))` call sites in the same
file. dart2js preserves string literals, so JSON keys survive minification even
though identifiers do not.

## Transport

Base URL `https://api.futmondo.com`. Every call is a `POST` with a JSON envelope:

```json
{
  "header": { "token": "<session token>", "userid": "<user id>" },
  "query":  { "championshipId": "...", "userteamId": "..." },
  "answer": {}
}
```

The response echoes `header` and `query` and puts the payload in `answer`.

### Errors are HTTP 200

**A failed call returns HTTP 200.** The only reliable signal is `answer.error === true`
plus `answer.code`. Never infer success from the status code.

Observed codes:

| `answer.code` | Meaning |
|---|---|
| `api.general.ok` | Success (some endpoints set this explicitly) |
| `api.error.not_found` | Login rejected — bad email or password |
| `futmondo.access.denied` | Missing, invalid or expired token — re-login and retry once |

Verified against the live host on 2026-09-02: a bad-credential login and a
token-less read both return HTTP 200 with `answer.error: true`.

### Headers

The mobile app sends these; mimicking them avoids being singled out:

```
Content-Type: application/json; charset=utf-8
Accept: application/json, text/plain, */*
Origin: https://app.futmondo.com
Referer: https://app.futmondo.com/
X-Requested-With: com.futmondo.app
X-Device: android
```

### Authentication

`POST /5/login/with_mail`

```json
{
  "header": { "token": null, "device": "android", "deviceId": "<stable uuid>", "lang": "es" },
  "query":  { "mail": "you@example.com", "pwd": "..." }
}
```

Success gives `answer.mobile.token` and `answer.mobile.userid`, and
`answer.mobile.code === "login.mobile.ok"`. Cache the token — it is long-lived.
Re-login only on `futmondo.access.denied`. Logging in per request risks lockout.

Every subsequent call needs `header.token` **and** `header.userid`.

## Scope identifiers

| Id | Where it comes from | Notes |
|---|---|---|
| `userid` | login response | Stable per account |
| `championshipId` | `/2/user/activechampionships` | Your private league. **Not** from `/2/league/list` |
| `userteamId` | `/2/user/activechampionships` | Your team inside that championship |
| `leagueId` | championship info | The real competition. La Liga is `504e4f584d8bec9a67000079` |
| `teamId` | player payloads (`teamId`) | A real La Liga club |
| `roundId` | `/1/userteam/rounds` or `/2/league/matches` | A matchday's Mongo `_id`, not its number |
| `playerId` / `player_slug` | player payloads | Both are needed to bid; slug comes from `/1/player/summary` |

Note the inconsistent casing: `championshipId` and `userteamId` are camelCase,
but market endpoints take `player_id` and `player_slug` in snake_case.

## Endpoints that matter

### Discovery and configuration

| Endpoint | Query | Returns |
|---|---|---|
| `/2/user/activechampionships` | `{excludeGeneral}` | Your championships and your team in each. **Use this, not `/2/league/list`** |
| `/1/championship/configuration` | `{championshipId}` | Budget, primas, market rules — the whole settings table |
| `/1/championship/information` | `{championshipId}` | Championship metadata |
| `/1/user/information` | `{}` | Account info |
| `/5/strategy/availables` | `{championshipId}` | Legal formations for this championship |

### Squad, lineup and points

| Endpoint | Query | Returns |
|---|---|---|
| `/1/userteam/information` | `{championshipId, userteamId, type}` | **Funds, team value, max bid.** Source of truth for money |
| `/1/userteam/roster` | `{championshipId, userteamId}` | `answer[]` of `{id, name, role, team, teamId, value, buyPrice, average{}, clause{}, market}` — see the row shape below |
| `/1/userteam/lineup` | `{championshipId, userteamId}` | Current XI, bench and strategy string (e.g. `"4-3-3"`) |
| `/1/userteam/rounds` | `{championshipId, userteamId}` | `answer[]` of `{id, number, status}`, status ∈ `closed`/`running`/`open` |
| `/1/userteam/roundlineup` | `{championshipId, round: <roundId>, userteamId}` | Documented as per-player per-round `points` plus `detailedPoints.data`. **In this league it returns `players: []` for every closed round** — see the trap below |
| `/1/userteam/moneymovements` | `{championshipId, userteamId}` | Your cash ledger |
| `/1/userteam/dreamteam` | `{championshipId, round}` | Round's ideal XI (relevant to the "equipo ideal" prima) |
| `/1/userteam/nightmareteam` | `{championshipId, round}` | Worst XI |

Roles are `POR`, `DEF`, `MED`, `DEL`.

A real roster row, captured:

```json
{
  "id": "63a8cd87bfb65a271f11db10", "name": "Carlos Álvarez", "slug": "67291985",
  "role": "centrocampista", "points": 1.8, "value": 18526493,
  "team": "América", "teamId": "5200250711398189070000b4",
  "market": { "inMarket": true, "price": 18931044, "bids": [{ "id": "…", "price": 18204532 }] },
  "average": { "average": 0, "homeAverage": 0, "awayAverage": 0,
               "averageLastFive": 0, "matches": 0, "fitness": [] },
  "clause": { "price": 38228076, "date": "2026-09-07T18:05:10.934Z",
              "transferred": false, "suggestedClause": 24683383 }
}
```

Two of those are nested where a flat value would be expected, and reading them
as flat values fails silently:

- **`clause` is an object**, not a number. `clause.price` is the same figure
  `/1/player/summary` returns, so the roster already carries the clause price
  for your own squad and needs no per-player fan-out for it.
- **`market` is `false` when the player is not listed** and an object
  `{inMarket, price, bids[]}` when they are. Its presence is the shape test.
- **`team` and `teamId` are the real club**, and Futmondo keeps them current
  through a real-world transfer *out* of the league. The row above is a player
  who moved to Club América: still on the championship roster, still valued at
  18.5M, still clause-priced, and permanently unable to score. Nothing in the
  payload flags it — see "a departed player looks completely normal" below.

### Writing a lineup

Three-step flow, mirroring the app:

1. `/1/userteam/lineup` — read current `{strategy, players, bench}`
2. `/5/userteam/multichanges` — `{championshipId, userteamId, modified, current, changes}`
   where `changes` is a list of position assignments. Single moves can instead use
   `/2/userteam/moveplayer` with `{championshipId, userteamId, from:{position, bench}, to:{position, bench}}`
3. `/2/userteam/clicktosave` — `{championshipId, userteamId}` commits it

Related: `/2/userteam/changestrategy`, `/2/userteam/changeplayer`,
`/2/userteam/makesubstitution` (`{championshipId, id, outPlayer, roundId}`),
`/5/userteam/setcaptain` (disabled in leagues without captains).

### Market

| Endpoint | Query | Notes |
|---|---|---|
| `/1/market/players` | `{championshipId, userteamId, type: "market"}` | Today's market. `type` is required |
| `/1/market/myplayers` | `{championshipId, userteamId, type}` | Your listings |
| `/1/market/bid` | `{championshipId, userteamId, player_id, player_slug, price, isClause}` | New bid |
| `/5/market/modifybid` | `{championshipId, userteamId, player_id, price, bid, rounds: []}` | Change a bid — takes `bid` id, no slug |
| `/1/market/cancelbid` | `{championshipId, bid}` | |
| `/1/market/putonmarket` | `{championshipId, player_id, price, isClause, toLoan}` | List for sale |
| `/1/market/cancelsell` | `{championshipId, player_id}` | |
| `/5/market/modifyprice` | `{championshipId, player_slug, price}` | |
| `/1/market/directsell` | `{championshipId, player_id}` | Sell to the machine |
| `/1/market/rosterbid` | `{championshipId, player_slug, price}` | Bid on a *rival's* player |
| `/1/market/rosterbids` | `{championshipId, type}` | Incoming/outgoing roster bids |
| `/1/market/acceptrosterbid` / `rejectrosterbid` / `cancelrosterbid` | `{championshipId, bid}` | |
| `/1/market/playerauctionsummary` | `{championshipId, player_id}` | Auction detail |

### Clauses

| Endpoint | Query | Notes |
|---|---|---|
| `/1/player/summary` | `{championshipId, playerId, userteamId}` | `answer.data.slug`, **`answer.championship.clause.price`**, plus `answer.points[]`, `answer.prices[]`, `answer.owners[]` and `answer.match` |
| `/1/market/rosterclause` | `{championshipId, player_id, player_slug, price, userteamId}` | Pay a clause and take the player |
| `/1/market/renewclause` | `{championshipId, player_id, userteamId}` | Raise your own player's clause |
| `/1/userteam/lockplayer` | `{championshipId, playerId}` | **Block a clause on your own player** |
| `/5/userteam/unlockplayer` | `{championshipId, playerId}` | |
| `/5/market/recalculateclauses` | `{championshipId}` | Admin |
| `/5/market/recoverclause` | `{championshipId, userteamId}` | Admin |

Clause price for a *rival's* player is not in any bulk payload, so finding
steal targets means fanning out `/1/player/summary` per player — throttle it.
Your own squad's clause prices come free on the roster row (`clause.price`).

`/1/player/summary` carries considerably more than the clause, and this is not
yet all used:

- **`answer.points[]` is the per-round record `/1/userteam/roundlineup` refuses
  to give**: `{round, points, isHomeTeam, minutesPlayed, initialLineUp, st}`
  where `st` is `"st"` for a start and `"bc"` for a bench appearance. This is a
  measured start rate rather than the "rounds appeared in" estimate the model
  currently uses. `minutesPlayed` appears to be a flag rather than a count in
  this league — verify before trusting it as minutes.
- **`answer.prices[]` is the value history**, per day, from before our first
  snapshot: `{date, price, c, s}`.
- **`answer.owners[]` is the ownership chain** with the price and date of each
  transfer, `"futmondo"` naming the machine.
- **`answer.championship.clause.date`** is in the future for a recently bought
  player, alongside `unlockDate` — a grace period during which the clause
  cannot be paid, which the clause-defence model does not yet account for.

### Rivals and standings

| Endpoint | Query | Returns |
|---|---|---|
| `/2/championship/teams` | `{championshipId}` | `answer.teams[]` of `{userid, _id, teamid, teamname, name, teamValue}` |
| `/1/ranking/general` | `{championshipId}` | `answer.ranking[]` overall table |
| `/1/ranking/round` | `{championshipId, roundNumber: <roundId>, userteamId}` | `answer.ranking[]` for one round. **`roundNumber` takes the round's `_id`**, not its number |
| `/1/league/championshipteams` | `{championshipId}` | |
| `/5/ranking/matches` | `{championshipId, userteamId}` | |

`teamname` is the in-game name and **changes** when a user renames. `userid` is the
stable key — always join on it.

### Transfer ledger and money events

| Endpoint | Query | Returns |
|---|---|---|
| `/1/locker/pressroom` | `{championshipId, from: "<cursor>"}` | `answer.news[]` of `{_id, _player.name, _buyer:{_id,name}, _seller:{_id,name}, price, created}` |
| `/2/locker/news` | `{championshipId, from}` | `answer.news[]`. Filter `styp === "customize"` for prize/money payouts |
| `/1/locker/reverttransfer` | `{championshipId, marketMoveId, playerId}` | |

**Pagination is cursor-based and non-deterministic.** Pass the last `_id` as
`query.from`. Th3Gerb7 found that repeated calls return *different subsets*, so a
full backfill needs several passes with a delay between them, deduplicated by `_id`,
and even then some old rows never appear. Treat these tables as append-only ledgers
and never delete rows a later sync fails to return.

Because leagues can hide rival funds, the pressroom ledger plus `/2/locker/news`
money events is the only way to reconstruct how much cash each rival has.

### Real-football data — no third party needed

| Endpoint | Query | Returns |
|---|---|---|
| `/2/team/unavailableplayers` | `{teamId}` | `answer.players[]` — **injuries and suspensions** |
| `/2/team/nextandpreviousmatches` | `{teamId}` | `{previousMatch, nextMatch}` |
| `/2/team/lastmatches` | `{teamId}` | Recent results |
| `/2/team/matches` | `{teamId}` | Full fixture list |
| `/2/team/summary` | `{teamId}` | Club summary |
| `/1/team/players` | `{teamId}` | Club squad |
| `/2/league/matches` | `{leagueId}` | `answer.rounds[]` of `{_id, number, status, matches[]}`. Each match is `{_id, info.date, st, h, a}` — **the two sides are `h` and `a`**, each `{id, name, slug, shortname, score}`. `st: "F"` means full time, and only then do the scores mean anything. The round deadline is the earliest `info.date` |
| `/2/league/standing` | `{leagueId}` | Real league table |
| `/2/league/players` | `{leagueId}` | All players in the competition |
| `/2/match/bydate` | `{from, to}` | `answer.matches[]` in a date window |
| `/2/match/statistics` | `{matchId}` | Match stats |
| `/2/match/fetchmatch` | `{matchId}` | Match detail |
| `/2/match/oponentslastmatches` | `{matchId}` | Head-to-head form |
| `/5/match/odds` | `{matchId}` | **Bookmaker odds** — the best fixture-difficulty signal. Not a flat result: `answer.odds[]` is one entry per betting market. See the trap below |
| `/1/match/list` | `{championshipId, roundId}` | |
| `/1/player/fullprofile` | `{playerId}` | Full player profile |
| `/2/player/statistics` | `{playerId}` | Season stats |
| `/2/player/matches` | `{playerId}` | Per-match history |
| `/2/player/lastseasons` | `{playerId}` | Multi-season history |
| `/5/league/championshipplayers` | `{championshipId}` | `answer.players[]` of `{id, name, teamId, role}`. **Identity only — no clause, no owner, no value** |
| `/5/sportstatistics` | `{group, set, team, league, stats[], limit}` | Aggregate stat leaderboards |

`/5/league/championshipplayers` is a common trap: it looks like a full player dump
but carries neither ownership nor clause price.

### Other

Notifications `/1/notification/{list,unread,markreaded,remove}`.
Prizes `/5/prize/{listbyuser,unread,view,claim}`.
Locker room `/1/locker/create`, `/5/locker/{edit,delete,report,unpin}`, `/8/locker/pin`,
`/5/locker/poll/{create,vote}`.
Conversations `/1/conversation/{list,get,reply,sendmessage,delete,unreaditems}`.
Championship admin `/1/championship/{activate,configuration,configurebonus,configurechampionship,duplicate,exit,invite,join,remove,restart,…}`,
`/5/championship/{create,configurepointsystem,setawards,search}`, `/2/championship/configuremarket`.
Cups and head-to-head `/5/cup/{create,get,remove,restart}`, `/5/h2h/{create,remove,restart}`.
Predictions `/5/userteam/{setpool,setprediction}`.
Coach `/1/userteam/{hirecoach,hiredt}`, `/5/userteam/roundhirecoach`, `/2/userteam/getdtconfig`.
Account `/5/login/{initial,register_with_mail,validate_mail,resend_pin,recover_password,change_password}`,
`/5/user/{updateprofile,changeavatar,firebase,remove}`, `/1/user/change*`.

## Practical notes

- **Throttle.** Clause discovery is one `/1/player/summary` per player; a 14-team
  league is hundreds of calls. Serialise with a delay (the community clients use
  250–400 ms) rather than firing `Promise.all`.
- **Round ids, not numbers.** `/1/ranking/round` and `/1/userteam/roundlineup` both
  want the round's Mongo `_id`. Passing the integer matchday silently returns nothing.
- **`/1/userteam/roundlineup` returns no players here.** With a correct championship
  id, userteam id and closed-round `_id` it answers
  `{pro, strategy: "4-4-2", players: [], budget, bench, pointSystem}` — the right
  formation, and an empty squad. It is not an auth or an id problem; it looks like a
  successful call that found nothing, which is why `round_points` sat empty while
  `backfillRoundPoints` reported success. **Per-round minutes are therefore
  unavailable**, and the expected-points model reads the scoring record off the
  roster payload instead (below). `backfillRoundPoints` now warns rather than
  spending nine requests a round in silence.
- **The scoring record lives on `average`.** Every player in `/1/userteam/roster` and
  `/1/market/players` carries
  `average: {average, homeAverage, awayAverage, averageLastFive, matches, fitness[]}`.
  This is the only per-player evidence the API gives up, so the whole form model
  rests on it. `average` is per match *played*; `averageLastFive` is per *round*,
  counting a missed round as zero, so the two diverge exactly when a player loses
  their place. `fitness[]` is points per round in order with a zero for a round not
  played, which makes `fitness.length` rounds elapsed and
  `fitness.length - matches` rounds missed. A player who has appeared reports
  `matches: 0, fitness: []` until they first feature, which is no evidence rather
  than a zero score.
- **`/5/match/odds` returns every market, not a result.** `answer.odds[]` is one entry
  per betting market: `{mn: "Match Result" | "Correct Score" | "Total Goals" |
  "Half Time/Full Time" | …, sels: [{ssn, sn, odds: [{c, f, bid, lu}, …]}]}`. The 1X2
  market is `mn: "Match Result"`, whose three selections are `ssn` `"1"` (home),
  `"X"` and `"2"` (away) — **in a different order in the payload than in the client,
  so match them by name, never by index**. Each selection carries one quote per
  bookmaker: `c` is the current price, `f` the opening one. Take the median across
  books, not the first, so one stale bookmaker cannot swing a fixture.
- **A departed player looks completely normal.** Transfer a player out of the
  league in real life and Futmondo keeps him in the championship: he holds a
  squad slot, keeps a market value and a clause price, appears in
  `/5/league/championshipplayers`, and can still be fielded. The only thing
  that changes is `teamId`, which now points at a club with no fixtures. There
  is no status flag: `status` is `""` for departed and present players alike,
  and `average.fitness` is not a reliable tell either — one departed player in
  this league has a populated `fitness` array. **The signal is the calendar:**
  a club is in the competition if and only if `/2/league/matches` gives it
  fixtures, so a player whose club has none has left. Live check: 7 of 526
  championship players, against 20 clubs with fixtures.
- **Values are integers in euros**, not millions.
- **`answer` is sometimes a bare array** (`/1/userteam/roster`, `/1/market/players`)
  and sometimes an object wrapping one (`answer.ranking`, `answer.news`,
  `answer.players`, `answer.teams`, `answer.rounds`). There is no consistent rule —
  check per endpoint.
