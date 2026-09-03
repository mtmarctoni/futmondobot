# Configuration

Everything that can be set, what happens when it is not, and the operational
runbook. Template: [`.env.example`](../.env.example). `/settings` in the running
app shows which of these are present.

## Environment variables

### Required

| Variable | Purpose | If unset |
|---|---|---|
| `FUTMONDO_EMAIL` | Futmondo login | Nothing works. `runAnalysis` returns a report whose only content is the reason. |
| `FUTMONDO_PASSWORD` | Futmondo login | As above. Wrong credentials return `api.error.not_found`, reported distinctly so nothing retries forever. |
| `DATABASE_URL` | Postgres connection | The app still runs, but remembers nothing: no value trends, no real form, no clause prices, no rival funds. Advice falls back to role averages and says so. |
| `CRON_SECRET` | Guards `/api/sync`, `/api/cron/*`, `/api/futmondo` | **Those routes are disabled, not opened.** They can write to Futmondo, so absence denies rather than allows. |

Secrets are read server-side only and never reach the browser. `/settings`
reports presence, never a value.

### Recommended

| Variable | Purpose | If unset |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Sends the matchday report and action buttons | No notifications; the web UI still works. |
| `TELEGRAM_CHAT_ID` | **Allowlist** of chats that may command the bot. Comma-separate for several. | The bot ignores everyone. This is deliberate: it can spend money, so it obeys nobody rather than anybody. |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `FUTMONDO_CHAMPIONSHIP_ID` | auto | Only needed when the account has more than one active championship. Without it and with several, the app refuses and lists the options rather than guessing. |
| `FUTMONDO_USER_TEAM_ID` | auto | Only needed if auto-discovery picks the wrong team. |
| `LINEUP_WINDOW_HOURS` | `30` | How close to kickoff the lineup is written. Earlier writes waste the change, because injuries and probable lineups keep moving. |
| `FUTMONDO_MIN_INTERVAL_MS` | `300` | Minimum gap between Futmondo calls, shared by one module-level queue. This throttle is what keeps the account out of trouble during clause sweeps. |
| `FUTMONDO_NAME_OVERRIDES` | `{}` | JSON object `{"Scraped Name": "futmondoPlayerId"}` for scraped names that never match. Invalid JSON is ignored with a warning. |
| `TELEGRAM_WEBHOOK_SECRET` | `CRON_SECRET` | Secret token Telegram sends with each webhook call. |
| `FUTMONDO_DEVICE_ID` | `futmondobot-01` | Sent at login; Futmondo ties sessions to it. Change only to force a fresh session. |
| `FUTMONDO_API_URL` | `https://api.futmondo.com` | Host override, for testing. |

Both `FUTMONDO_CHAMPIONSHIP_ID` and `FUTMONDO_USER_TEAM_ID` must be set together
to skip discovery entirely; setting only the championship still resolves the team
from it.

### Removed on purpose

`FUTMONDO_FUNDS` and `FUTMONDO_DEADLINE` used to exist and are **gone**. Funds
come live from `/1/userteam/information`; the deadline is derived from stored
kickoff times. Hardcoding either is how the app previously gave stale advice —
do not reintroduce them.

`API_FOOTBALL_KEY` and `LEAGUE_ID` are also gone. Futmondo serves odds
(`/5/match/odds`) and injuries (`/2/team/unavailableplayers`) itself, so no
third-party stats provider is needed.

## League settings

The championship's own configuration is read live from
`/1/championship/configuration` and mapped onto `LeagueRules` in
`src/lib/engine/types.ts`. It is never hardcoded, so changing a league setting in
Futmondo changes the advice without a code change.

Defaults used when that call fails, matching the league this was built for:

| Rule | Default | Where it is used |
|---|---|---|
| `budget` | `210.000.000€` | The baseline for every rival-funds estimate |
| `initialPlayers` | `15` | Squad expectations |
| `pricePerPoint` | `60.000€` | Converts expected points to prize money in every recommendation |
| `maxOfferTeamValueShare` | `0.5` | Offer ceiling is funds + 50% of squad value |

Settings that shape behaviour but are not parameters, because they are read from
the API or are properties of the league:

- **Mixto scoring** — the engine never assumes a scoring formula. Form is
  measured from actual per-round points in `round_points`, so whatever the
  system awards is what gets modelled.
- **Multiposition disabled** — roles are disjoint, which is what makes the
  lineup optimiser exactly optimal rather than approximate. If this league ever
  enables it, `pickLineup` needs revisiting.
- **Captain disabled** — `/5/userteam/setcaptain` is never called.
- **Manual clauses, no weekly cap, unlimited blocks** — this is why clause
  attack and defence are both first-class features.
- **Funds hidden** — this is why rival cash must be reconstructed from the
  ledger.
- **Max offer = funds + 50% squad value** — encoded as
  `maxOfferTeamValueShare`, though Futmondo's own reported ceiling wins when it
  gives one.

## Schedules

`vercel.json`:

| Cron | Schedule | Job |
|---|---|---|
| `/api/cron/sync` | `0 6,14,22 * * *` | Collects history. **This is the one that makes the app better over time.** |
| `/api/cron/deadline` | `0 9,18 * * *` | Sets the lineup, blocks clauses, sends the Telegram report. |

Adjust the expressions to your league's kickoff pattern. Two things to keep in
mind:

- The sync cron should run **more often than the deadline cron**, because the
  deadline cron's advice is only as good as the history behind it.
- The deadline cron should fire at least once inside `LINEUP_WINDOW_HOURS` of
  every kickoff, or the lineup is never written automatically. With the default
  30 hours and two runs a day, that holds for any normal fixture list.

Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the routes also accept
`x-vercel-cron-secret`.

## Endpoints

All except `/api/analyze` require `Authorization: Bearer $CRON_SECRET`.

| Route | Method | Purpose |
|---|---|---|
| `/api/analyze` | GET | The full report as JSON. Returns a report describing the failure rather than a bare error, so the UI can render the reason. |
| `/api/sync` | POST/GET | All cheap jobs, or one via `?job=` |
| `/api/cron/sync` | GET | History collection, plus a bounded clause batch |
| `/api/cron/deadline` | GET | Automation and Telegram. `?dryRun=1` plans without writing. |
| `/api/futmondo` | GET | Setup diagnosis: ids, and a per-endpoint health check |
| `/api/telegram` | POST | Bot webhook |

### Sync jobs

`?job=` accepts:

| Job | Cost | What it collects |
|---|---|---|
| `daily` | ~1 call per team | Teams, calendar, every squad in the league, today's market, one snapshot row per player |
| `ledger` | several passes | Transfers and prize payouts. Run repeatedly: pagination is non-deterministic, so coverage accumulates. |
| `odds` | 1 per fixture | Bookmaker odds for the next 10 days |
| `availability` | 1 per club (~20) | Injuries and suspensions |
| `roundPoints` | 1 per team per round | Per-player round performance. Bounded to 5 rounds per run. |
| `clauses` | **1 per player** | Clause prices. The most expensive job; bounded to 60 players per run, prioritised by staleness then points. |
| `probableLineups` | 1 scrape | Start percentages, matched to player ids |

`daily`, `ledger`, `odds`, `availability`, `roundPoints` and `probableLineups`
run together by default. `clauses` is separate because of its cost — successive
runs rotate through the stalest players.

## Runbook

### First-time setup

```bash
pnpm install
cp .env.example .env.local          # add FUTMONDO_EMAIL, FUTMONDO_PASSWORD, CRON_SECRET

vercel link
vercel integration add neon         # provisions Postgres, injects DATABASE_URL
vercel env pull .env.local
pnpm db:migrate
```

Confirm the credentials and find your ids — this reports each endpoint's health
separately, which is how you discover an inferred shape is wrong:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/futmondo
```

Start collecting history. Do this as early as possible; it cannot be backfilled:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" -X POST localhost:3000/api/sync
curl -H "Authorization: Bearer $CRON_SECRET" -X POST "localhost:3000/api/sync?job=clauses"   # repeat
```

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather), get your chat id from
[@userinfobot](https://t.me/userinfobot), then register the webhook:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>/api/telegram&secret_token=<CRON_SECRET>"
```

### Checking automation without writing anything

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<app>/api/cron/deadline?dryRun=1"
```

Returns the moves it would make and the reasons it skipped anything.

### Verification

```bash
pnpm typecheck && pnpm lint && pnpm test    # 132 tests, no network
pnpm build
pnpm db:smoke                               # 29 checks against the real database
```

`pnpm db:smoke` creates only `smoke-` prefixed rows and cleans up even on
failure, so it is safe to run against a live database. It is the only thing that
exercises the `UNNEST` casts in `src/lib/db/repo.ts`.

## Diagnosing

| Symptom | Likely cause |
|---|---|
| "Futmondo rejected the credentials" | Wrong email or password. Distinct from a token problem, which retries once by itself. |
| "Several active championships" with a list | Set `FUTMONDO_CHAMPIONSHIP_ID` to one of them. |
| No clause targets at all | No clause prices collected. Run `?job=clauses` several times; it is one request per player. |
| No deadline known | Calendar not synced. Run `?job=daily`. |
| Value trends all zero | Fewer than two days of snapshots. Only time fixes this. |
| Lineup never written automatically | Deadline outside `LINEUP_WINDOW_HOURS`, round already started, or gain below the 0.5-point threshold. `?dryRun=1` says which. |
| Rival funds obviously wrong | Thin ledger coverage. Teams with fewer than five known transfers are flagged; run `?job=ledger` repeatedly. |
| Probable lineups empty | The scrape found no rows, meaning the page markup changed. A warning says so and start probability falls back to minutes played. |
| Telegram buttons do nothing | Chat not in `TELEGRAM_CHAT_ID`, or the webhook secret does not match. Unlisted chats are ignored silently by design. |

Warnings are surfaced rather than swallowed: the web UI has an expandable panel,
the Telegram report appends them, and every sync job returns them in its
`SyncReport`.
