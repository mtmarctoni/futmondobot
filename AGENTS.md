<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FutmondoBot — agent orientation

Read this before touching anything. It exists because this codebase talks to an
undocumented API with several traps that look like working code until they
silently produce wrong advice.

## What this is

A decision engine for one Futmondo fantasy-football league. It answers "what
should I do right now", sets the lineup by itself, defends the squad against
clause steals, and pushes money decisions to Telegram as buttons. The goal is
not a dashboard; it is spending less time on the game while playing it better.

Full behaviour: `docs/BEHAVIOUR.md`. Structure: `docs/ARCHITECTURE.md`.
Settings: `docs/CONFIGURATION.md`. **API: `docs/futmondo-api.md` — mandatory
reading before editing `src/lib/futmondo/`.**

## Hard rules

These are load-bearing. Breaking one produces a bug that is expensive and quiet.

1. **Futmondo reports failure as HTTP 200.** The only reliable signal is
   `answer.error === true` with `answer.code`. Never infer success from a status
   code. `postEnvelope` already handles this; do not add a code path that reads
   `answer` without going through it.

2. **Never automate an action that spends money.** Bids, clause payments and
   sales are irreversible. They may only ever reach Futmondo from an explicit
   human tap, confirmed twice, with affordability re-checked against live funds
   at the moment of execution. Lineups and clause blocks are automated precisely
   because they are free and reversible.

3. **Never guess a write payload.** Read shapes can be inferred safely; a wrong
   write can corrupt a lineup or spend budget. This is why formation changes are
   *not* automated — that payload could not be verified from the client bundle.
   If you cannot confirm a write shape from `docs/futmondo-api.md` or a working
   community client, report it to the user instead of trying it.

4. **The ledger tables are append-only.** `transfers` and `money_events` are
   never deleted by a sync. Futmondo's pressroom pagination is
   non-deterministic and returns different subsets on different calls, so a row
   not returned this time is not evidence it did not happen.

5. **History cannot be backfilled.** The API only ever reports the present. A
   day the sync does not run is a day of value trends lost permanently. Treat
   anything that could stop `syncDaily` as a high-severity bug.

6. **Round ids, not round numbers.** `/1/ranking/round` and
   `/1/userteam/roundlineup` want the round's Mongo `_id`. Passing the integer
   matchday silently returns nothing.

7. **Join on stable ids, never names.** In-game team names change when a user
   renames. `userid` is stable; `team_name_history` exists so old names stay
   resolvable, because `/2/locker/news` identifies a team by name only.

8. **Money is integer euros.** `num()` in `src/lib/futmondo/parse.ts` refuses
   separator-formatted input rather than guessing, because "1.500" is ambiguous
   between 1500 and 1.5 and a wrong guess mis-prices a bid. Do not "fix" this by
   making it lenient.

9. **`date` columns come back as local-time `Date` objects.** Formatting one
   with `toISOString()` reports the previous day under a positive UTC offset.
   Use `isoDay` / `isoInstant` in `src/lib/db/repo.ts`; never format a date
   column by hand.

## Traps that look fine

- **A parser that reads the wrong key never fails; it returns a neutral default
  and the report still looks plausible.** Every real bug found so far is this
  one bug: `role()` missing `CENTROCAMPISTA` deleted every midfielder in the
  league; `parseMatch` reading `home`/`away` instead of `h`/`a` left all 380
  fixtures without a team id, so opponent strength could not attach to a player
  and facing Barcelona scored the same as facing the bottom club; `parseOdds`
  expecting a flat result priced zero fixtures. The unit suite was green
  throughout all three, because the fixtures were written from the same wrong
  assumption as the code. **A parser test is worth nothing unless its fixture is
  a real captured payload.**

- `/5/league/championshipplayers` looks like a full player dump. It carries
  **no ownership and no clause price** — only `{id, name, teamId, role}`. Clause
  price comes from `/1/player/summary`, one call per player; ownership from
  `/2/championship/teams` plus a roster call per team.
- `/2/league/list` is not your leagues. Championship discovery is
  `/2/user/activechampionships`.
- `/1/market/players` silently needs `type: "market"` in the query.
- `answer` is sometimes a bare array and sometimes an object wrapping one, with
  no consistent rule. Always go through the helpers in `parse.ts`.
- Rival funds are an **estimate** reconstructed from the ledger, not a reading.
  Never present them as fact; the UI and Telegram output both say so, and that
  wording should stay.

## Conventions

- **pnpm only.** Never npm.
- Parsers are total: an unrecognised payload degrades one feature and returns
  empty, rather than throwing and taking down the report. Preserve this.
- Every sync job is idempotent and returns a `SyncReport` of what it wrote plus
  warnings. Warnings are surfaced to the user, not swallowed.
- Bulk writes use `UNNEST` with explicit casts so a batch is one parameterised
  round trip. Follow the existing pattern rather than looping statements.
- Expected points are real points, not a normalised index, so numbers stay
  interpretable and convert to prize money at the league's own rate.
- **Form comes from the `average` object on the roster payload, not from
  `round_points`.** `/1/userteam/roundlineup` returns an empty player list even
  for a closed round, so that table never fills; see `docs/futmondo-api.md`.
  Waiting for it meant every player scored the bare role prior and the lineup
  page showed one identical number per position.
- **This league has no bench** (`bench.enabled: false`), and `planMoves` can only
  promote a substitute, so the automatic lineup writer cannot move anything here.
  The recommendation is the deliverable: the daily message prints the XI in full,
  in pitch order, so it can be entered without opening the report.
- No emojis in code, comments, commit messages or UI copy.

## Verify before claiming done

```bash
pnpm typecheck && pnpm lint && pnpm test    # 132 unit tests, no network
pnpm build
pnpm db:smoke                               # 29 checks against the real database
```

`pnpm db:smoke` is the one that matters most when changing `src/lib/db/repo.ts`:
the `UNNEST` casts cannot be checked by unit tests, and it already caught two
real date bugs. It creates only `smoke-` prefixed rows and cleans up on failure,
so it is safe against a live database.

Live Futmondo calls need real credentials in `.env.local`. With them set,
`GET /api/futmondo` (needs `Authorization: Bearer $CRON_SECRET`) reports each
endpoint's health separately, which is how you find out an inferred shape was
wrong.

## Where things live

```
src/lib/futmondo/   transport, total parsers, typed client. Read docs/futmondo-api.md first
src/lib/db/         schema, migrations, repository, session store
src/lib/sync/       the jobs that accumulate history the API forgets
src/lib/engine/     expected points -> lineup, market, clauses -> today's actions
src/lib/engine/apply.ts   the only place that writes to Futmondo automatically
src/lib/providers/  probable-lineup scrape and name matching
src/lib/telegram/   message formatting and button callbacks
src/lib/automation.ts     the scheduled routine: decide, do the safe parts, report the rest
```

Data flows one way: **Futmondo + scrape -> sync -> database -> engine -> report
-> UI / Telegram**, with live API reads for the present (funds, today's market,
current lineup) joined onto stored history for the past (form, trends, odds).
