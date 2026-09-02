# FutmondoBot

Automate your Futmondo fantasy league so you win without spending hours each matchday: automatic lineup suggestions, market buy/sell picks, rival clause steal alerts, and a one-click "Today's actions" list — with Telegram reminders before the matchday deadline.

Built for **Social mode** leagues (`Mixto` scoring, manual clauses). Uses Futmondo's internal REST API (token auth with your email/password).

## Features

- **Today** — a prioritized, one-click decision list (set lineup, buy, sell, steal).
- **Lineup** — suggested XI weighted by form, fixtures and injuries (default 4-3-3).
- **Market** — buy picks and sell picks ranked by points-per-million and form.
- **Clauses** — rival players with unlocked, undervalued clauses you can steal.
- **Settings** — env/config health check and setup guide.
- **Telegram reminders** — scheduled message before the matchday deadline (Vercel Cron).

## Stack

- Next.js 16 (App Router, TypeScript, Tailwind v4)
- Node.js server runtime (default)
- Deploy: Vercel (+ Vercel Cron for reminders)

## Setup

1. Install deps:

   ```bash
   pnpm install
   ```

2. Configure the environment (see `.env.example`):

   ```bash
   cp .env.example .env.local
   ```

   Required: `FUTMONDO_EMAIL`, `FUTMONDO_PASSWORD`, and for reminders `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

3. Run locally:

   ```bash
   pnpm dev
   ```

4. Find your league/team IDs (optional, auto-discovery exists):

   ```bash
   curl http://localhost:3000/api/futmondo
   ```

## Telegram bot

- Create a bot with [@BotFather](https://t.me/BotFather), get the token, set `TELEGRAM_BOT_TOKEN`.
- Find your chat id with [@userinfobot](https://t.me/userinfobot), set `TELEGRAM_CHAT_ID` (comma-separated for multiple).
- Set the webhook:
  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<YOUR_APP>/api/telegram&secret_token=<CRON_SECRET>"
  ```
- Message the bot with `/status` to get a live summary anytime.

## Deadline reminders (Vercel Cron)

`vercel.json` schedules `GET /api/cron/deadline` daily at 18:00 (change the cron to match your deadline). The route is protected by `CRON_SECRET` (send `Authorization: Bearer <CRON_SECRET>`).

## Stats (optional)

Set `API_FOOTBALL_KEY` (RapidAPI free tier) and `LEAGUE_ID` (e.g. 140 = La Liga) to enrich lineups with fixture difficulty. Without a stats provider the app still works, just without fixture weighting.

## Notes

This project is unofficial and not affiliated with Futmondo. Use the internal API responsibly and at your own risk. Credentials are stored as server-side env vars only and never exposed to the client.
