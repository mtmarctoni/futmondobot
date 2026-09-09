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

It is denominated in **real points**, not a 0-100 score, which is what lets a
recommendation convert to money **at the league's own rate, where there is
one**. This league's `moneyPerPoint` is 0 — all 40M of prize money is
distributed by round ranking — so the app states no euro figure for points at
all. It used to state one, at an invented 60.000€ per point, because the
configuration parser read a key that does not exist. Points remain the whole
objective; euros are simply the wrong unit for them here.

### startProbability

The single biggest factor, because a player who does not play scores nothing.

1. A scraped probable-XI percentage, where one exists.
2. A **measured** start rate from `/1/player/summary`'s `points[]`, which
   records whether the player was in the starting XI each round. This
   distinguishes a starter from a player who appears off the bench every week —
   the appearance-share estimate below cannot.
3. Otherwise the share of rounds they have appeared in, shrunk towards 0.5 —
   two starts out of two is suggestive, not certain.
4. `0.5` when nothing is known, because that is honest.

Availability then **multiplies** that number rather than replacing it:

| Severity | Reasons | Multiplier |
|---|---|---|
| `out` | `injured`, `injured2`, `redcard`, suspension, left the competition | 0 |
| `doubt` | `doubt`, and **anything unrecognised** | 0.45 |
| `fit` | `""`, `"ok"` | 1 |

Two things about that table matter more than the numbers in it. An unrecognised
reason degrades a projection and never deletes a player, so a new Futmondo
wording cannot silently empty a position. And `doubt` is not `injured`: grading
them alike zeroed three of a fifteen-player squad, leaving ten fit outfield
players for eleven shirts, so no formation could be filled and the picker
fielded a body it scored at 0.0. The 0.45 is a stated guess, named next to the
model constants so it can be tuned once the measured start record has enough
rounds to say what share of doubtful players actually start.

Availability comes from three sources, merged so the most severe reading wins:
the per-club injury endpoint (most precise reason), the `status` field on every
roster and market row (free, and the only one that reaches market listings),
and the departure scan (strongest fact, always wins).

### pointsPerStart

Mean points in rounds the player actually played, from `round_points` where a
per-round record exists and from the roster payload's `average` object
otherwise. Blended towards a per-role prior with a weight equivalent to two
prior rounds, so a single spectacular week is not mistaken for form and a
player with no history still gets a usable projection.

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

- Selection is on expected points alone. An `out` player sinks to the bottom by
  himself, because a zero start probability makes his projection zero — but he
  is still **fielded rather than leaving a slot empty**, since Futmondo scores a
  missing place as zero and an unfit body might not. A `doubt` competes on his
  discounted projection, which is the point of grading availability: sorting him
  behind every fit player as well would count the doubt twice.
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

- **Points.** Worth a euro figure only where the league pays per point; here it
  does not, so points are ranked and never priced.
- **Value drift.** Futmondo revalues players daily. Buying a rising player and
  selling a falling one compounds, and it is invisible without stored history.

Recommendations are **comparative, not absolute**: a candidate is judged against
the starter they would actually displace, in the same role. A brilliant forward
is not a buy if your forwards are already better. Only genuine improvements are
surfaced — ranking the whole market produces confident-looking noise.

**Ranking depends on whether cash is the constraint.** Points per million is
right when funds bind and wrong when they do not: with 202M idle in a 210M
budget and no yield whatsoever on cash, efficiency ranking put a 1.0M defender
above every player who would actually improve the team. So the default is the
biggest absolute upgrade affordable, and efficiency takes over only once the
best candidate on the market is out of reach.

**Bidding is priced, not accepted.** The asking price is the auction's floor, so
offering it loses every contested listing by construction — the one bid ever
placed through this app was an asking price. Each candidate now carries:

- a **ceiling**: the most the player is worth to us, from the points they add
  over the rest of the season (at the league's rate, zero here) plus what we
  could recover on resale, bounded by funds and by Futmondo's offer ceiling;
- a **bid**: the asking price plus a whole number of `increment` steps, read per
  listing from `/1/market/playerauctionsummary` because an off-step offer may
  be rejected outright.

Both are shown, so the two-tap confirmation is an informed decision rather than
a number to trust. The markup between the ask and the ceiling is a **stated
placeholder**: the honest input is a clearing-price model fitted to what
listings actually sold for, and the `transfers` ledger does not yet hold enough
rows to fit one.

Up to three bids are surfaced per report rather than one, with committed funds
tracked: winning every proposed bid at once must stay inside
`funds - withheld`, where `withheld` is what Futmondo already holds against our
standing bids.

**Our own listings** come from `/1/market/myplayers`, which is the only place a
standing bid against us is visible — the bidder's identity is blanked, the price
is not. A player already listed never produces a "sell him" recommendation, a
bid closing inside the lineup window outranks any buy, and every sell figure is
shown next to the `dspct` direct-sell floor (80% of value here) so "hold out for
more" can be compared against "take this now, guaranteed". None of it is
automated: accepting or cancelling moves money, and it is not even established
whether a machine-market listing needs acceptance at all.

Selling is costed in points. A substitute who never starts is free to sell; a
player who does start is priced so the trade-off is explicit. Only a player who
is genuinely `out` is ever called dead capital — a fitness doubt is a player who
will most likely be available next week.

Affordability uses Futmondo's own reported ceiling when it gives one, otherwise
funds plus 50% of squad value, per the league settings.

A recommended bid is always at least one whole increment step above the ask,
because the ask is the auction floor and an offer equal to it loses every
contested listing. Two roundings used to defeat that rule, and only for cheap
players, which is why it went unnoticed: `suggestBid` floored its percentage
markup to whole steps, and the willingness ceiling -- value plus a 12%
placeholder premium -- is itself narrower than one step below about 2.08M. Both
are fixed, and the ceiling is stretched to one step above the ask only for a
genuine upgrade and never past the offer ceiling or available cash.

### The low-value radar

`src/lib/engine/radar.ts`. A second, deliberately separate pass over the same
listings, answering a different question: not "who improves the XI" but "whose
price is moving off the floor". Exactly two conditions, and no others — market
value at or under `LOW_VALUE_CEILING` (2.5M), and a daily value change above
zero. Availability, expected points and whether the player would ever start are
not consulted, because a speculation is a bet on the price. Results are ranked
by percentage gain, which is the right ranking for that bet and the wrong one
for a squad upgrade; keeping the two lists apart is what lets each keep its own
ordering rule.

The daily change comes from `/1/player/summary`'s `prices[]`, read live for each
listing alongside the auction step. That series is republished in full on every
call, which makes value the one exception to "history cannot be backfilled", so
the radar does not depend on yesterday's sync having run. It deliberately does
not read `player_snapshots`: `syncClausePrices` only fans out to players with an
owner, and most listings at this price are the machine's, so the stored series
would be empty for precisely the players the radar exists to find.

A listing whose daily change cannot be established has an **unknown** change,
not a flat one. Those are counted and reported separately — in the Telegram
section, on the market page, and as a warning — because a failed read and a
market with no opportunities in it must never look the same. Four things land
there, and the last two matter most:

- no series at all, or a single point, which is a player who just arrived;
- a **stale** series, whose newest valuation predates the report;
- a series with a **hole** where yesterday should be, so the move between the
  two newest points spans several days.

The last two exist because the alternative is a false claim rather than a
missing one. Without them a player last revalued a week ago is printed as "up
120k today", and somebody bids on that sentence. The tolerance is 36 hours,
which absorbs the jitter of a series Futmondo stamps around 02:25 while still
refusing a two-day gap.

Two zeroes are refused for the same reason. A market value of zero is a parse
failure rather than the cheapest player in the league, and a *previous* value of
zero leaves the percentage undefined — it used to print the self-contradicting
line "+100k (+0.0%)" and sort the most extreme move in the list dead last.

The ceiling is applied to **today's** listing value, not to `Evaluated.value`.
That field is built from `history.ownership`, which is yesterday's stored
snapshot, so judging on it would silently drop a player who fell under 2.5M
today — precisely the player the module exists to find, with nothing anywhere
reporting an error.

Only listings that could actually qualify get a value-history call. Each one is
a throttled round trip on the critical path of every report, and the same
`couldBeOpportunity` predicate decides both what is fetched and what is
filtered: two copies of "cheap" would drift by a euro and the radar would
quietly stop seeing a player. Both that lookup and the bid-step lookup are
bounded, and exceeding either bound is a warning rather than a silent
truncation.

The bid it recommends clears the asking price, through the same `suggestBid`
the buy list uses. Both figures are printed, so the difference between the
auction floor and the offer is visible rather than implied.

Nothing here spends money. The radar produces text and an alert; a bid still
reaches Futmondo only through the confirmed-tap route, with funds re-checked at
the moment of execution.

The daily Telegram message lists the best five and points at the web page for
the rest. Telegram rejects a message over 4096 characters outright and this
section shares one with the XI, the actions and the departures, so an unbounded
list would mean the whole report fails to send on exactly the day the market is
most worth reading.

The web app shows it as a "Speculation opportunities" panel on the market page,
plus a dismissible in-app alert for listings this browser has not been shown
before. The alert mounts only in the browser and is keyed on the id list, so
"what is new" is answered once per set of listings: that is what stops it
erasing itself the moment the visit is recorded, and what stops it reappearing
every time the user navigates back to the page. That seen-state lives in `localStorage`, not the database: it differs
per device rather than per league, and nothing about "has this person seen a
toast" belongs in the ledger. The stored set is replaced by the current listing
ids rather than accumulated, so it stays bounded — at the cost of a relisted
player alerting a second time, which is the right side to err on.

## Clauses

`src/lib/engine/clauses.ts`. This league runs manual clauses with **no weekly
cap and unlimited blocking**, which makes clauses the sharpest tool available in
both directions.

**Everything here is gated on the clause window.** `clause.date` is the instant
a clause first becomes payable, and it is in the future more often than not.
Before it, there is nothing to take and nothing to defend — ignoring it produced
55 steal candidates and 15 block recommendations on a day when no clause in the
league could be paid by anybody. The date is read from the payload, never
derived: drafted players get acquisition + 5 days to the millisecond and bought
players get end-of-local-day + 2, and reconciling those into a rule would be
guessing about a decision that spends millions.

**Attack.** A rival's player can be taken outright for their clause price — no
bidding, no negotiation. Targets are ranked by lineup upgrade multiplied by
points per million of clause, filtered to unlocked players we can actually
afford whose window is open. Targets whose window opens later are reported
separately, as planning information rather than as advice. Clause price comes
from `/1/player/summary`, one call per player, which is why it is collected in
batches on a slower schedule; the same call supplies `suggestedClause`,
Futmondo's own idea of a fair price, which is roughly half what owners set.

**Defence.** Blocking costs nothing and removes a player from every rival's
list. The app blocks players who are attractively priced, affordable to at least
one rival, and actually takeable today. When nothing is takeable yet it says
when that changes, so the block happens before the window opens rather than
after.

**The app cannot see whether a block worked.** No Futmondo payload carries lock
state anywhere, so the only record that a block exists is our own `action_log`,
and `runClauses` reads it back to avoid re-blocking the same player daily. That
is weaker than a reading — a rival's clause payment could clear a block with no
trace here — and it is why every automated block is now stated explicitly in the
Telegram report. A free, reversible, automated action that leaves no trace
anywhere is indistinguishable from one that never ran, which is exactly the
state this was in: fifteen players reported as needing a block, and not one lock
row in the app's entire history.

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
4. A bid standing against one of our own listings and closing soon, because it
   expires rather than waiting for the next report.
5. A clause block, because it is free.
6. A clause steal, weighted by the upgrade.
7. Up to three buys, then a sell.

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
so the app keeps its own record. **Almost none of it can be backfilled later** —
see the one exception below.

| Table | What it enables |
|---|---|
| `player_snapshots` | Value trends, clause history, ownership over time |
| `round_points` | Real form and a measured start record, per round |
| `transfers`, `money_events` | Rival fund reconstruction |
| `matches` + odds | Fixture difficulty |
| `unavailability` | Injury history rather than only current state |
| `probable_lineups` | Whether a doubtful player will start |

**The exception is value.** `/1/player/summary` republishes a player's whole
daily price series on every call, so a day the sync missed is recoverable for
value alone. Those rows are marked `value_backfilled`, and a live capture always
overwrites a reconstructed one. Points and ownership remain unrecoverable: a day
the sync does not run is still a day of those lost permanently, which is why
anything that could stop `syncDaily` is a high-severity bug.

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
