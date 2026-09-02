# FutmondoBot

Plays the boring half of Futmondo for you. It sets your lineup before every
deadline, blocks clauses on the players rivals could take, and sends the
decisions that cost money to Telegram as one-tap buttons.

Built for a **Social** league with **Mixto** scoring and manual clauses, but the
league's own settings are read from the API rather than hardcoded.

## What it actually does

| | |
|---|---|
| **Automatic** | Sets the XI before the deadline. Blocks clauses on exposed players. Both are free and reversible, so they run unattended. |
| **One tap** | Bids, clause payments and sales arrive as Telegram buttons and need a confirmation. These spend budget irreversibly. |
| **Never automatic** | Changing formation. Futmondo's formation-write payload could not be verified from the client, so a better shape is reported for you to switch by hand rather than guessed at. |

## How it decides

Everything reduces to one number, computed once and reused everywhere:

```
expectedPoints = startProbability x pointsPerStart x fixtureFactor
```

- **startProbability** — a scraped probable-XI figure if available, else how
  often the player has recently played 60+ minutes, else 0.5. Zero if Futmondo
  reports them injured or suspended.
- **pointsPerStart** — mean points in rounds they actually played, shrunk
  towards a role prior so one big week is not mistaken for form.
- **fixtureFactor** — from bookmaker odds, de-margined into an implied win
  probability. Worth ±20%, deliberately less than whether they play at all.

Because it is denominated in real points, every recommendation converts to money
at the league's own rate: 60.000€ per point here, so "+1.4 pts/round" is
"about 84k a round".

Decisions are then comparative, not absolute:

- A **buy** is only surfaced if it beats the weakest starter it would replace.
- A **sell** is free if the player never starts, and costed in points if they do.
- A **steal** is ranked by lineup upgrade per euro of clause price.
- A **block** is recommended when a rival could actually afford the clause.

## The part that needs time to work

Futmondo's API only ever reports the present: today's value, today's clause,
today's funds. Every edge in this app comes from comparing today with yesterday,
so the app keeps its own history in Postgres:

- **Daily player snapshots** — value, points, clause price, ownership. This is
  what makes a rising player visible.
- **Per-round player points** with minutes, goals and assists, for every team in
  the league. Real form instead of a season average.
- **The transfer ledger and prize payouts** — because this league hides rival
  funds, they have to be reconstructed.
- **Fixtures with odds**, and **injury observations**.

None of it can be backfilled from the API later. **The sooner the sync starts
running, the better the advice gets.**

### Rival funds are an estimate

`budget − spent + received + prizes`, from the ledger. It assumes every team
started with the same budget and that the ledger is complete, and neither is
perfectly true: Futmondo's pressroom pagination is non-deterministic and drops
old rows. Treat the **ordering as reliable and the amounts as approximate** —
the app labels teams with thin data.

## Setup

```bash
pnpm install
cp .env.example .env.local     # fill in FUTMONDO_EMAIL / FUTMONDO_PASSWORD
```

Provision Postgres and pull the connection string:

```bash
vercel link
vercel integration add neon
vercel env pull .env.local
pnpm db:migrate
```

Confirm the credentials work and find your ids:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/futmondo
```

Collect the first history:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" -X POST localhost:3000/api/sync
# clause prices cost one request per player, so run this a few times
curl -H "Authorization: Bearer $CRON_SECRET" -X POST "localhost:3000/api/sync?job=clauses"
```

Then `pnpm dev`. `/settings` shows what is still missing.

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather), get your chat id from
[@userinfobot](https://t.me/userinfobot), then:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>/api/telegram&secret_token=<CRON_SECRET>"
```

`TELEGRAM_CHAT_ID` is an **allowlist**, not just a destination: only those chats
can command the bot, and an empty value means nobody can. The bot can spend
money, so it refuses to obey an unconfigured allowlist.

Commands: `/today` `/lineup` `/market` `/clauses` `/funds` `/log`.

## Schedules

`vercel.json` runs two crons:

- **`/api/cron/sync`** three times a day — collects history. This is the one
  that makes the app better over time.
- **`/api/cron/deadline`** twice a day — sets the lineup, blocks clauses, sends
  the report. Lineup writes only happen within `LINEUP_WINDOW_HOURS` (default
  30) of kickoff, because injuries and probable lineups keep moving and the last
  write before the deadline is the one that counts.

Adjust the cron expressions to your league's kickoff pattern.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/analyze` | The full report as JSON |
| `POST /api/sync` | All cheap jobs, or one via `?job=daily\|ledger\|odds\|availability\|roundPoints\|clauses\|probableLineups` |
| `GET /api/cron/sync` | History collection |
| `GET /api/cron/deadline` | Automation + Telegram. `?dryRun=1` plans without writing |
| `GET /api/futmondo` | Setup diagnosis: ids, and a per-endpoint health check |
| `POST /api/telegram` | Bot webhook |

Everything except `/api/analyze` requires `Authorization: Bearer $CRON_SECRET`.
With `CRON_SECRET` unset they are disabled rather than open.

## Stack

Next.js 16 (App Router), TypeScript, Tailwind v4, Neon Postgres, Vercel Cron.
No ORM — the schema is small and the queries are explicit SQL.

```
src/lib/futmondo/   transport, parsers, typed client   (docs/futmondo-api.md)
src/lib/db/         schema, migrations, repository
src/lib/sync/       the jobs that accumulate history
src/lib/engine/     expected points, lineup, market, clauses, today
src/lib/providers/  probable-lineup scrape and name matching
src/lib/telegram/   formatting and button callbacks
```

`pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm build`

## Notes

Unofficial, and not affiliated with Futmondo. It uses their private API, which
[docs/futmondo-api.md](docs/futmondo-api.md) documents — 166 endpoints extracted
from the compiled web client. That file is worth reading before changing
anything in `src/lib/futmondo`; the API has several traps, notably that **errors
come back as HTTP 200** with `answer.error: true`.

Credentials live only in server-side environment variables and never reach the
browser. Requests are serialised through a throttle, and the session token is
cached so the app does not log in repeatedly.
