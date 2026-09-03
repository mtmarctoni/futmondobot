# What the app does

FutmondoBot exists to answer one question — *what should I do right now* — and
then to carry out the parts of the answer that are safe to automate. Everything
below describes behaviour as built, including the limits.

## The automation boundary

This is the most important design decision in the app, and it is drawn on
reversibility rather than convenience.

| | What | Why |
|---|---|---|
| **Automatic** | Set the starting XI. Block clauses on exposed players. | Both cost nothing and can be undone at will. A wrong XI can be changed again before kickoff; a block is lifted with one call. |
| **One tap in Telegram** | Bid, pay a clause, sell a player. | Irreversible. A bug in a price calculation would spend real budget with no way back, so a human always presses the button — twice. |
| **Never automatic** | Change formation. | The formation-write payload could not be verified from Futmondo's client. Guessing a write shape risks corrupting the lineup, so the app reports "switch to 3-4-3 for +2.1 pts" and leaves it to you. |

A money action is confirmed twice: the first tap produces a button that spells
out the amount, the second executes. Before executing, affordability is
re-checked against **live** funds rather than the price quoted in what may be an
hours-old message.

## How a decision is made

Every recommendation reduces to one number, computed once in
`src/lib/engine/expected.ts` and reused everywhere:

```
expectedPoints = startProbability x pointsPerStart x fixtureFactor
```

It is denominated in **real points**, not a 0-100 score, which is what lets any
recommendation convert to money at the league's own rate. At 60.000€ per point,
"+1.4 pts/round" is "about 84k a round".

### startProbability

The single biggest factor, because a player who does not play scores nothing.

1. `0` if Futmondo reports them injured or suspended (`/2/team/unavailableplayers`).
2. A scraped probable-XI percentage, where one exists.
3. Otherwise how often they have recently played 60+ minutes, shrunk towards
   0.5 — two starts out of two is suggestive, not certain.
4. `0.5` when nothing is known, because that is honest.

### pointsPerStart

Mean points in rounds the player actually played, from `round_points`. Blended
towards a per-role prior with a weight equivalent to two prior rounds, so a
single spectacular week is not mistaken for form and a player with no history
still gets a usable projection.

### fixtureFactor

From bookmaker odds (`/5/match/odds`). Implied win probability is `1/odds`,
normalised against the other two outcomes to remove the bookmaker's margin;
difficulty is its complement. Worth ±20% at the extremes — deliberately mild,
because fixture matters far less than whether the player is on the pitch.

Where no odds are stored, difficulty is 0.5 and the factor is exactly 1.

## Lineup

`src/lib/engine/lineup.ts` evaluates **every formation the championship
permits** (`/5/strategy/availables`) and keeps the highest total. The previous
version hardcoded 4-3-3.

Because this league disables multiposition, roles are disjoint, so for any fixed
formation the optimum is simply the best N in each role. That makes trying every
legal shape **exactly optimal, not a heuristic** — there is a test that verifies
it by brute force.

Two behaviours worth knowing:

- An unavailable player is never picked while a fit replacement exists, **but is
  fielded rather than leaving a slot empty**, because Futmondo scores a missing
  place as zero and an unfit body might not.
- A formation the squad cannot fill always loses to one it can, however good the
  filled slots look.

The suggested XI is diffed against what Futmondo currently holds, and each
difference is expressed as a swap with its reason and points gained.

### Writing it

`applyLineup` in `src/lib/engine/apply.ts` optimises **within the formation
already set**, then performs each swap as a pitch-slot to bench-slot move via
`/2/userteam/moveplayer`, and commits with `/2/userteam/clicktosave`. Without
the save, nothing persists.

It only writes inside `LINEUP_WINDOW_HOURS` (default 30) of kickoff. Writing
earlier wastes the change: injuries and probable lineups keep moving, and the
last write before the deadline is the one that counts. It also skips when the
total gain is below 0.5 expected points.

## Market

`src/lib/engine/market.ts`. Two distinct things earn money here and they are not
the same:

- **Points**, at 60.000€ each.
- **Value drift.** Futmondo revalues players daily. Buying a rising player and
  selling a falling one compounds, and it is invisible without stored history.

Recommendations are **comparative, not absolute**: a candidate is judged against
the starter they would actually displace, in the same role. A brilliant forward
is not a buy if your forwards are already better. Only genuine improvements are
surfaced — ranking the whole market produces confident-looking noise.

Selling is costed the same way. A substitute who never starts is free to sell; a
player who does start is priced in points so the trade-off is explicit.

Affordability uses Futmondo's own reported ceiling when it gives one, otherwise
funds plus 50% of squad value, per the league settings.

## Clauses

`src/lib/engine/clauses.ts`. This league runs manual clauses with **no weekly
cap and unlimited blocking**, which makes clauses the sharpest tool available in
both directions.

**Attack.** A rival's player can be taken outright for their clause price — no
bidding, no negotiation. Targets are ranked by lineup upgrade multiplied by
points per million of clause, filtered to unlocked players we can actually
afford. Clause price comes from `/1/player/summary`, one call per player, which
is why it is collected in batches on a slower schedule.

**Defence.** Blocking costs nothing and removes a player from every rival's
list. The app blocks players who are both attractively priced and affordable to
at least one rival. Not using this is leaving the door open, and it is the half
of the clause game most often left unplayed.

## Rival funds, and why they are an estimate

The league hides rival funds, so they are reconstructed:

```
estimate = starting budget - spent + received + prize payouts
```

from the transfer ledger (`/1/locker/pressroom`) and prize events
(`/2/locker/news`).

This is an estimate, not a reading, and the app says so everywhere it appears.
Two assumptions do not hold perfectly: that every team began with the same
budget, and that the ledger is complete. Futmondo's pressroom pagination is
non-deterministic — repeated calls return different subsets — so coverage builds
up over many syncs and some old rows may never appear.

**Treat the ordering as reliable and the amounts as approximate.** Teams with
fewer than five known transfers are flagged in the UI.

It matters because a rival who cannot afford your player's clause is not a
threat, so this is what decides which of your players are worth blocking.

## Today's action list

`src/lib/engine/today.ts` merges everything into one ranked list. Ordering is by
**consequence, not category**:

1. An unavailable player in the XI — the most expensive mistake available.
2. A lineup change inside 24 hours of the deadline.
3. A player who has left the competition, because the loss compounds daily.
4. A clause block, because it is free.
5. A clause steal, weighted by the upgrade.
6. A buy, then a sell.

Anything that needs no action is deliberately not listed. Each entry carries the
points at stake and the money involved, so the cost of ignoring it is visible.

## Players who have left the competition

`src/lib/engine/departed.ts`.

A real-world transfer out of the league does not remove a player from Futmondo.
He keeps his squad slot, his market value and his clause price, his card looks
like everyone else's, and he can still be picked — he simply never scores
again. It is the only mistake in this game that is invisible from inside
Futmondo, which is why it gets its own check and its own banner rather than a
line in a list.

No field says "gone". The signal is the calendar: **a club is in the
competition if and only if it has fixtures**, so a player whose club has none
has left. That reads the transfer the day Futmondo updates his club, instead of
waiting for rounds of zeroes to drag his average down.

A false positive here tells you to dump a good player, so the check refuses to
guess:

- It needs at least 18 clubs in the stored calendar. Below that, a missing
  fixture means the sync has not run.
- It refuses to fire at all if it would flag more than a fifth of the league —
  the shape of a calendar synced for the wrong competition. It warns instead.
- A player with no club id is unknown, not departed.

A departure is fed into the same availability map as an injury, so it reaches
every decision at once: start probability zero, out of the XI, out of the
clause-steal candidates (which is what stops a rival's departed player looking
like a bargain on a low clause and a stale average), and into the sell list as
dead capital. It is scanned league-wide for that reason, not just for our own
squad.

Selling is never automated — it moves real money, so it stays a two-tap
confirmation like every other money action. When the player is already listed,
the action becomes a note rather than a sell, because the only thing left to do
is take the best offer.

## History, and why it needs time

Futmondo's API only ever reports the present: today's value, today's clause,
today's funds. Every edge in this app comes from comparing today with yesterday,
so the app keeps its own record. **None of it can be backfilled later.**

| Table | What it enables |
|---|---|
| `player_snapshots` | Value trends, clause history, ownership over time |
| `round_points` | Real form from actual per-round performance, with minutes |
| `transfers`, `money_events` | Rival fund reconstruction |
| `matches` + odds | Fixture difficulty |
| `unavailability` | Injury history rather than only current state |
| `probable_lineups` | Whether a doubtful player will start |

The UI states its own data coverage rather than hiding it: one day of snapshots
is not a trend, and the app says so instead of presenting a confident number.

## Probable lineups

Scraped from FútbolFantasy's LaLiga fitness page, which is server-rendered and
publishes a **start percentage per doubtful player**, refreshed daily. Roughly 65
players across 19 clubs.

Only players with a fitness question appear there, and that is the useful set.
For everyone else, recent minutes from Futmondo's own round data are a better
signal than anything a scrape adds.

Names are matched to Futmondo player ids by ordered strategies — manual
override, exact match, surname plus club, then league-unique surname — each
reporting its own confidence. **A match below 0.8 confidence is dropped
entirely.** A wrong match would attribute one player's injury to another and
bench a fit starter, which is worse than having no scrape at all. Unmatched
names are reported as warnings so they can be added to
`FUTMONDO_NAME_OVERRIDES`.

The site's *probable-lineup* pages are client-rendered and cannot be scraped
without a browser; only the fitness page is used. If the markup changes, the
scrape returns nothing, a warning is raised, and start probability falls back to
minutes played.

## Interfaces

**Web.** `/` today's actions · `/lineup` the XI and each change · `/market` buys
and sells · `/clauses` steals and exposure · `/rivals` estimated funds ·
`/settings` configuration health. Pages render on the server, so they arrive
with data and no loading flash.

**Telegram.** `/today` `/lineup` `/market` `/clauses` `/funds` `/log`, plus
inline buttons for money actions. `TELEGRAM_CHAT_ID` is an allowlist, not just a
destination — the bot can spend money, so it obeys nobody when unset.

Every automated write is recorded in `action_log` and readable with `/log`, so
nothing the app does by itself is a surprise.

## Failure behaviour

Designed to degrade in pieces rather than all at once:

- A failed market read costs the market section, not the report.
- An unrecognised payload shape yields an empty result plus a warning.
- No database means advice falls back to role averages, and says so.
- A failed Telegram send does not hide that the lineup was written.
- Telegram always answers HTTP 200, because a retry on a money action is the one
  thing that must never happen.
