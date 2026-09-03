# Architecture

Written for whoever — human or agent — has to change this next. It explains the
shape and, where the shape is unusual, why.

## The central constraint

Futmondo's API only ever reports the present: today's value, today's clause,
today's funds. It has no history and no time series.

But almost every edge in fantasy football is a *comparison over time* — a player
whose value is rising, a striker who has caught fire, a rival who just spent
their budget. So the app's job splits cleanly in two:

- **Live reads** for the present: funds, today's market, the current lineup.
- **A local database** for the past, accumulated by scheduled jobs.

Neither alone is enough. The API cannot tell you a player is rising; the
database cannot tell you what is for sale today. Everything else in this
document follows from that.

## Data flow

```
                       ┌──────────────────────┐
   api.futmondo.com ──►│  src/lib/futmondo/   │  transport, parsers, client
                       └──────────┬───────────┘
                                  │
   futbolfantasy.com ──► providers/│
                                  ▼
                       ┌──────────────────────┐
                       │    src/lib/sync/     │  idempotent jobs, on cron
                       └──────────┬───────────┘
                                  ▼
                       ┌──────────────────────┐
                       │  Postgres (history)  │  src/lib/db/
                       └──────────┬───────────┘
                                  │
        live reads ───────────────┼──────────────┐
                                  ▼              ▼
                       ┌──────────────────────────────┐
                       │      src/lib/engine/         │
                       │  expected points → lineup,   │
                       │  market, clauses → today     │
                       └──────┬────────────────┬──────┘
                              │                │
                    AnalysisReport      engine/apply.ts
                              │                │
                    ┌─────────┴────┐      writes back to
                    ▼              ▼        Futmondo
                web pages     Telegram    (lineup, locks only)
```

One direction, one report type. `AnalysisReport` is the single object every
surface renders, so the web UI and the bot can never disagree about what to do.

## Layers

### `src/lib/futmondo/` — the API boundary

The only place that knows Futmondo's wire format. **Read
[`futmondo-api.md`](./futmondo-api.md) before editing anything here.**

| File | Responsibility |
|---|---|
| `transport.ts` | One envelope POST, error detection, the shared throttle |
| `errors.ts` | `FutmondoError`, and classifying auth vs credential failures |
| `parse.ts` | Total normalisers from wire shapes to our types |
| `types.ts` | Our shapes, with `raw` kept for anything we do not model |
| `client.ts` | Typed methods, session handling, scope resolution |

Three non-obvious properties:

**Errors arrive as HTTP 200** with `answer.error: true`. `postEnvelope` is the
only correct way to make a call; anything that reads `answer` directly will
treat failures as success.

**One module-level throttled queue.** Calls are serialised with a minimum gap,
shared across every client instance in the process, because clause discovery is
one request per player and a 14-team league is hundreds of calls. Firing
`Promise.all` at this API is how accounts get locked.

**Parsers are total.** Every one returns an empty result for a shape it does not
recognise rather than throwing. A renamed field costs one feature, not the
report. `asArray` also falls back to the first array-valued property, so a
renamed wrapper key still works.

### `src/lib/db/` — history

Raw SQL, no ORM: the schema is small, stable and explicit.

| File | Responsibility |
|---|---|
| `client.ts` | Lazy Neon client. Lazy because Next evaluates module code at build time and `neon()` throws without a URL. A plain function, never a `Proxy`. |
| `migrate.ts` | Applies `migrations/*.sql` in order, one transaction each |
| `repo.ts` | Every read and write, plus the derived queries |
| `token-store.ts` | Session persistence, so cold starts do not re-login |

Bulk writes go through `UNNEST` with explicit casts, so a whole sync batch is
one parameterised round trip instead of a loop of statements. This is the part
unit tests cannot verify — hence `scripts/db-smoke.ts`.

`COALESCE` in the upserts is load-bearing: a cheap roster sync must not null out
a clause price that an expensive summary sweep already found.

Two tables are **append-only ledgers** (`transfers`, `money_events`) because
pressroom pagination is non-deterministic. A row not returned by this sync is
not evidence it did not happen.

Derived queries that carry real logic:

- `getFixtureDifficulty` — de-margins bookmaker odds into a per-club difficulty,
  unioning home and away sides of each fixture and taking each club's next one.
- `getPlayerForm` — form from the last N *closed* rounds, since a running
  round's points are still changing.
- `getValueTrends` — first-to-last value change within a window.
- `getRivalFunds` — the ledger reconstruction, with a row count so callers can
  tell a strong estimate from a guess.

### `src/lib/sync/` — accumulation

One function per job. Each is idempotent, catches its own failures, and returns
a `SyncReport` of what it wrote plus warnings. Jobs are split **by cost, not by
subject**, which is why clause prices are their own job rather than part of the
daily one.

They run in sequence, never in parallel: the client shares one throttled queue,
so concurrency would gain nothing and only complicate failure.

### `src/lib/engine/` — decisions

| File | Responsibility |
|---|---|
| `expected.ts` | The one model: `startProbability x pointsPerStart x fixtureFactor` |
| `lineup.ts` | Formation parsing, the optimiser, diffing against the current XI |
| `market.ts` | Buys and sells, judged against the starter they would displace |
| `clauses.ts` | Steal targets, and our own exposure |
| `today.ts` | Merging everything into one list ranked by consequence |
| `apply.ts` | The only code that writes to Futmondo automatically |
| `index.ts` | Orchestration: live reads + history, degrading in pieces |
| `types.ts` | `Evaluated`, `LeagueRules`, formatting |

The engine is **pure** apart from `apply.ts` and `index.ts`. Everything in
`expected`, `lineup`, `market`, `clauses` and `today` is a function from data to
decisions, which is why they are the well-tested parts.

Expected points are **real points, not a normalised index**. That is a
deliberate choice: it keeps every downstream number interpretable ("6.2 points
for 30M" beats "score 78") and lets any recommendation convert to prize money at
the league's own rate.

`index.ts` uses `Promise.allSettled` for live reads and a `safe()` wrapper for
history reads, so one failure costs one section. Every failure becomes a warning
the user sees.

### `src/lib/providers/` — external data

Isolated from Futmondo data because the source is fragile.

`futbolfantasy.ts` is a shallow regex parse of a server-rendered page — no DOM
library, no browser. If the markup changes it returns nothing plus a warning,
which is the correct failure for an optional input.

`name-match.ts` maps external names onto Futmondo ids through ordered
strategies, each reporting a confidence. **Matches below 0.8 are dropped.** A
wrong match would bench a fit starter, which is worse than no scrape at all.

### `src/lib/telegram/` and the web UI

`telegram/index.ts` formats and sends; `callbacks.ts` encodes button actions.
Telegram caps `callback_data` at 64 bytes, so a button carries only a verb, an
id and a price — everything else is looked up when pressed, which is also safer
because the price is re-validated against live funds at execution.

Pages are **server components** that call `runAnalysis()` directly and hand the
result to a client component. No `/api/analyze` round trip on first load, no
loading flash, and no fetch-on-mount effect. The client hook only re-fetches
when the user asks, and keeps the existing report on screen if a refresh fails.

## Automation, and where it stops

`src/lib/automation.ts` is the scheduled routine: run the analysis, do the free
and reversible parts, report the rest.

The boundary is drawn on **reversibility**, not convenience:

- Setting a lineup and blocking a clause cost nothing and can be undone, so they
  run unattended.
- Bids, clause payments and sales spend budget irreversibly, so they only ever
  become a Telegram button needing two taps.
- **Formation changes are never automated.** That write payload could not be
  established with confidence from the client bundle, and guessing a write shape
  risks corrupting a lineup. The app reports a better shape instead.

That last point is worth preserving. Read shapes can be inferred safely because
a wrong guess yields empty data; a wrong write guess does damage.

Lineup writes use `/2/userteam/moveplayer` (a shape we could verify) rather than
the bulk `/5/userteam/multichanges` (one we could not), then commit with
`/2/userteam/clicktosave`. Every write is recorded in `action_log`.

## Testing

| Layer | How |
|---|---|
| Parsers, client, engine, matcher, callbacks | 132 unit tests, `fetch` doubled, no network |
| The `UNNEST` SQL | `pnpm db:smoke` — 29 checks against real Postgres |
| The scrape | Unit tests on a fixture mirroring the live markup |
| Live Futmondo | `GET /api/futmondo`, which health-checks each endpoint separately |

The split matters. Unit tests cannot catch a wrong SQL cast or a driver
type-conversion quirk — `db:smoke` found two real date bugs that every unit test
had passed, including one where `date` columns read back a day early because the
driver builds them in local time.

The lineup optimiser has a test that verifies optimality by brute force rather
than asserting a specific formation, because the right answer depends on the
squad and a hardcoded expectation would be testing the test.

## Stack

Next.js 16 App Router, TypeScript, Tailwind v4, Neon Postgres, Vercel Cron.
Node runtime throughout — nothing here benefits from the edge, and the Futmondo
client needs full Node.

pnpm only.
