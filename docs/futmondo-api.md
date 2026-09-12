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
| `/1/championship/configuration` | `{championshipId}` | Budget, primas, market rules — the whole settings table. **Flat, terse keys; see the decode table below** |
| `/1/championship/information` | `{championshipId}` | Championship metadata |
| `/1/user/information` | `{}` | Account info |
| `/5/strategy/availables` | `{championshipId}` | Legal formations for this championship |

#### The configuration payload, decoded

The keys are flat and terse, and there is **no `bonus` or `awards` wrapper**.
The same values appear twice: at the top level and again under
`configuration`, with identical content. Captured verbatim from championship
`6a95cfc4ce50f2235a55f73f`:

```json
{
  "budget": 210000000, "numberOfPlayers": 15, "maxPlayersInRoster": 0,
  "moneyPerPoint": 0, "moneyPerRanking": 40000000,
  "rankingMode": "flop", "usersToRank": -1,
  "marketPlayers": 12, "marketTimes": 1, "bidDuration": 2,
  "enableAutomaticClauses": true, "enablingClause": 2,
  "playerRetention": 0, "playerMoveInDays": 0,
  "maxUserteams": 14, "members": 9, "blc": true, "rtv": "auto",
  "mnmp": 0.5, "dspct": 0.8, "mcpw": -1, "rcp": -1,
  "mdbp": true, "mbp": 3, "vmb": 3,
  "mtoffset": "-120", "mtrange": "9-20", "ctt": false, "ccr": 1,
  "marketStart": "2026-08-30T22:00:00.000Z", "fullSeason": true
}
```

| Field | Meaning | Consequence |
|---|---|---|
| `moneyPerPoint` | Prize money per point | **Zero here.** The parser used to look for `perPoint` inside a `bonus` object that does not exist, found nothing, and let the engine fall back to a hardcoded 60.000€ — so every prize-money figure the app printed was invented |
| `moneyPerRanking` | Pool distributed by round ranking | 40M. Where all prize money in this league actually comes from |
| `rankingMode` | How that pool is split | `"flop"`. **Payout shape not decoded** — do not convert points to money on the strength of it |
| `numberOfPlayers` | Squad size | 15 |
| `maxPlayersInRoster` | Squad cap, 0 for none | Buying never needs a sale first |
| `bidDuration` | Days a listing lives | 2, so ~24 machine listings are live at once |
| `enablingClause` | Days before a clause can be paid | 2 — but **do not derive `clause.date` from it**, see below |
| `dspct` | Direct-sell share of value | 0.8. A guaranteed floor under any sale |
| `mnmp` | Minimum listing price, as a share of value | 0.5 |
| `blc` | Clause blocking enabled | Blocking is legal here, and costs 200 mondos a player a week — the wrapper exists, nothing calls it |

Not decoded, and nothing should be built on them until observed: `usersToRank`,
`mbp`/`vmb` (both 3 — possibly a cap on simultaneous bids), `ccr`, `mcpw`,
`rcp`, `rtv`, `mtrange`, `mtoffset`.

### Squad, lineup and points

| Endpoint | Query | Returns |
|---|---|---|
| `/1/userteam/information` | `{championshipId, userteamId, type}` | **Funds (`budget`), `withheld`, `teamValue`, `maxBid`.** Source of truth for money. `withheld` is the cash held by standing bids and is what stops the allocator spending the same euro twice |
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
- **`clause` has no `locked` field.** It is exactly
  `{price, date, transferred, suggestedClause}`, here and in
  `/1/player/summary`. Nothing anywhere reports whether a clause is blocked, so
  a block cannot be verified and `action_log` is the only record one exists.
  Blocking also costs 200 mondos a player a week, so this unobservable write is
  deliberately uncalled: the "blocked" badge reads `getLockedPlayerIds` history
  for display only and `lockPlayer` (see below) is never invoked. See OPEN-7.

#### `status` — the availability marker nobody was reading

Present on every roster and market row. Observed values and counts across all
nine rosters of this league:

| Value | Count | Meaning |
|---|---|---|
| `""` | 110 | Nothing to report |
| `"ok"` | 16 | **A positive marker** — returning to fitness, *not* an absence |
| `"doubt"` | 10 | Fitness doubt. Most of these start anyway |
| `"injured"` | 2 | Out |
| `"injured2"` | 3 | Out |
| `"redcard"` | 1 | Out |

Two things follow. `"ok"` must never be read as unavailable, or the players who
have just recovered are exactly the ones benched. And `doubt` is not `injured`:
grading them alike forced three of a fifteen-player squad to zero and left ten
fit outfield players for eleven shirts.

It is also the only availability signal that reaches **market listings**, which
`/2/team/unavailableplayers` never covers — Odriozola was listed with
`status: "injured"` and nothing else would have said so.

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
| `/1/market/myplayers` | `{championshipId, userteamId, type: "market"}` | **Your listings, with the standing bids on them.** Not the same as `/1/market/players` |
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
| `/1/market/playerauctionsummary` | `{championshipId, userteamId, player_id}` | **`increment`: the minimum bid step.** Rejects a slug; errors `market.playerAuctionSummary.needTeamId` without the team |

#### `/1/market/myplayers` — our own listings and their bids

```json
[ { "id": "63a8cd87bfb65a271f11db10", "name": "Carlos Álvarez",
    "price": 18931044, "expirationDate": "2026-09-04T18:17:09.885Z",
    "bids": [ { "id": "6a98f597b4d723070d417621", "price": 18204532,
                "userTeam": { "name": "", "slug": "" } } ] } ]
```

The bidder's team is **blanked for a market bid** — sealed as to identity but
not as to price. A rival's *direct roster bid* on the same listing comes back
with their team name in full, so the absence of a name is a fact about the kind
of bid rather than a property of the endpoint. One captured listing carried
both at once:

```json
"bids": [ { "price": 8188435 },
          { "price": 8971705, "userTeam": { "name": "Theo Obrador" } } ]
```

This is the only way to see an offer standing against one of our own listings,
and without it the engine recommended selling players who were already listed.
Note also that a bid can exceed the asking price (Adrián Niño: 1.00M asked,
1.06M offered), so "top bid versus ask" has to handle both directions.

#### `numberOfBids` is a string, and sometimes `"-"`

The bid count on a market row is `numberOfBids` — not `bids`, `numBids` or
`offers`, which is what the parser looked for, so the value was permanently
undefined. When Futmondo hides it the value is the **string** `"-"`, which a
strict numeric conversion silently turns into "no answer"; the two are
different facts and are kept apart.

**Do not make decisions on the number itself** until it is understood: it came
back as 20 for a 1M injured defender in a nine-member league. See OPEN-3.

#### `/1/market/playerauctionsummary`

```json
{ "numberOfBids": 20, "marketPlayer": { … }, "increment": 250000 }
```

`increment` is the minimum bid step and is the direct answer to "how much
should I bid" — an off-step offer may be rejected outright. It may scale with
value, so it is read per candidate rather than assumed.

### Clauses

| Endpoint | Query | Notes |
|---|---|---|
| `/1/player/summary` | `{championshipId, playerId, userteamId}` | `answer.data.slug`, **`answer.championship.clause.price`**, plus `answer.points[]`, `answer.prices[]`, `answer.owners[]` and `answer.match` |
| `/1/market/rosterclause` | `{championshipId, player_id, player_slug, price, userteamId}` | Pay a clause and take the player |
| `/1/market/renewclause` | `{championshipId, player_id, userteamId}` | Raise your own player's clause |
| `/1/userteam/lockplayer` | `{championshipId, playerId}` | **Block a clause on your own player — 200 mondos a player a week.** The wrapper exists in `client.ts` (verified shape) but nothing calls it by design |
| `/5/userteam/unlockplayer` | `{championshipId, playerId}` | |
| `/5/market/recalculateclauses` | `{championshipId}` | Admin |
| `/5/market/recoverclause` | `{championshipId, userteamId}` | Admin |

Clause price for a *rival's* player is not in any bulk payload, so finding
steal targets means fanning out `/1/player/summary` per player — throttle it.
Your own squad's clause prices come free on the roster row (`clause.price`).

`/1/player/summary` carries considerably more than the clause. One call, made
once per player per sync run, returns all of the following:

```json
{
  "data":   { "…player…", "rating": 2, "total": { "points": 12.2, "played": 3 } },
  "points": [ { "round": 1, "points": 4.1, "isHomeTeam": true,
                "minutesPlayed": 1, "initialLineUp": true, "st": "st" }, … ],
  "prices": [ { "date": "2026-08-29T02:25:30.285Z", "price": 2590865,
                "c": 1000000, "s": 500871 }, … ],
  "owners": [ { "n": "Ted Lasso's Playbook", "p": 0, "d": "2026-09-02T18:05:10.923Z" } ],
  "championship": { "clause": { "price": 9627619, "date": "2026-09-07T18:05:10.923Z",
                                "transferred": false, "suggestedClause": 5000341 },
                    "owner": { … } },
  "bids": …, "market": …,
  "match": { "r": { "number": 4 }, "info": { "date": "2026-09-05T19:00:00.000Z" }, … }
}
```

- **`points[]` is the per-round record `/1/userteam/roundlineup` refuses to
  give**: `{round, points, isHomeTeam, minutesPlayed, initialLineUp, st}` where
  `st` is `"st"` for a start and `"bc"` for a bench appearance. A *measured*
  start rate, rather than the "rounds appeared in" estimate — and start
  probability is the largest term in every projection. Note that `round` is a
  matchday **number**, not a round id, so it has to be resolved against the
  stored calendar; a number matching more than one stored round is skipped
  rather than guessed at.
  `minutesPlayed` was `1` for every round of every player sampled: treat it as
  a flag, not as minutes, until a substitute appearance proves otherwise.
- **`prices[]` is the daily value history**, reaching back to 2026-08-29 —
  before our first snapshot. This is the **one exception to "history cannot be
  backfilled"**: that rule holds for points and ownership, but the whole value
  series is republished on every call, so a day the sync missed is recoverable
  for value alone. Backfilled rows are marked, and a live capture always wins.
  `c` and `s` are **not decoded and not stored**; see OPEN-8.
- **`owners[]` is the ownership chain**; `owners[].d` is the acquisition
  instant, exact to the millisecond, and `"futmondo"` names the machine.
- **`championship.clause.suggestedClause`** is Futmondo's own valuation of a
  fair clause — roughly half what owners actually set (Ximo Navarro: 9.63M
  actual against 5.00M suggested). A free prior in both directions.
- **`data.rating`** (integer, 2 for the player sampled) is unread and
  unexplained. See OPEN-8.

#### `clause.date` — read it, never derive it

`clause.date` is the instant the clause first becomes payable, and it is in the
future far more often than not. Ignoring it produced 55 "take this clause" and
15 "block this now" recommendations on a day when **no clause in the league
could be paid by anybody**.

Two different formulas are visible in the same league on the same day:

- Drafted players: acquisition instant **+ 5 days, to the millisecond**
  (`owners[].d` 2026-09-02T18:05:10.923Z → clause 2026-09-07T18:05:10.923Z).
- Players bought in the market: **end of local day + 2**
  (`2026-09-06T21:59:59.999Z`), which matches `enablingClause: 2`.

Do not reconcile those into a rule. Gate on the field itself, which needs no
formula, and see OPEN-1.

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
