# Decisions

The choices that shape this codebase, and the reasoning behind them. Recorded
because several look like arbitrary constraints and would be "fixed" by anyone
who did not know why they exist.

Dated 2026-09-02 unless noted.

---

## 1. Use Futmondo's private API, documented from the compiled client

**Context.** Futmondo publishes no API. The question was whether the app could
get structured data at all.

**Decision.** Extract the API surface from `app.futmondo.com/main.dart.js` — the
compiled Flutter bundle — by grepping endpoint literals and their query shapes,
then cross-check against community clients that run in production. Result: 173
endpoint paths, 163 of them confirmed as live request calls, recorded in
[`futmondo-api.md`](./futmondo-api.md).

**Consequences.** The app has far more data than a scraper would give, including
odds, injuries and per-player round stats. It also depends on an unstable
contract, so every parser is total and every field beyond the observed ones is
optional. The reference doc is the single source of truth; re-deriving it costs
an afternoon.

---

## 2. No third-party stats provider

**Context.** The original version used API-Football via RapidAPI for fixture
difficulty, needing a key and capped at 10 teams per run.

**Decision.** Drop it. Futmondo serves `/5/match/odds` (bookmaker odds),
`/2/team/unavailableplayers` (injuries and suspensions) and `/2/league/matches`
(fixtures with kickoff times) itself.

**Consequences.** One less credential, one less rate limit, better data — odds
beat any homemade difficulty heuristic. The only genuinely external need is
"will he actually start", which Futmondo does not have.

---

## 3. Store history locally, because the API has none

**Context.** The API reports only the present. Value trends, real form and rival
funds are all comparisons over time.

**Decision.** Neon Postgres, provisioned through the Vercel Marketplace, written
by idempotent cron jobs.

**Consequences.** The app gets better the longer it runs, and **worse advice is
unavoidable early on** — which is why the UI states its own data coverage rather
than presenting a confident number from one day of snapshots. History cannot be
backfilled, so a sync outage is permanent data loss.

**Rejected:** JSON snapshots committed to the repo (works, but cross-day
analysis becomes hand-written JS and the repo grows unbounded) and Vercel Blob
(no SQL, so every aggregation is manual).

---

## 4. Automate only what is reversible

**Context.** The user's goal is spending less time on the game. Maximum time
saving would mean automating bids and clause payments too.

**Decision.** Automate setting the lineup and blocking clauses. Keep bids,
clause payments and sales as Telegram buttons requiring two taps, with
affordability re-checked against live funds at execution.

**Reasoning.** The boundary is reversibility, not convenience. A wrong XI can be
changed again before kickoff and a block lifted with one call, so a bug costs
nothing. A wrong bid spends real budget with no way back, and this app computes
prices from an inferred API and an estimated model.

**Consequences.** Still requires a few taps a week. Judged the right trade for
money that cannot be recovered. The user was offered full automation and chose
this.

---

## 5. Never guess a write payload — hence no automatic formation changes

**Context.** The optimiser often wants a different formation than the one set.
Changing it requires a write whose payload could not be established with
confidence from the bundle: `/5/userteam/multichanges` takes `modified`,
`current` and `changes`, whose contents are obfuscated.

**Decision.** Automation optimises *within* whatever formation is already set,
using `/2/userteam/moveplayer` (a shape we could verify) plus
`/2/userteam/clicktosave`. A better shape is reported for the user to switch by
hand.

**Reasoning.** Read shapes can be inferred safely — a wrong guess returns empty
data. A wrong write guess corrupts a lineup, and would do so silently right
before a deadline.

**Consequences.** Some expected points are left on the table when the current
shape is not the best one. The lineup page and the Telegram report both say so
with the exact gain. Revisit only if the payload can be confirmed from a working
client.

---

## 6. Expected points, not a composite score

**Context.** The original engine produced a 0-100 score from a weighted sum of
normalised form, fixture, value and consistency, with role-specific weights.

**Decision.** Replace it with `startProbability x pointsPerStart x
fixtureFactor`, in real points.

**Reasoning.** Three problems with the weighted sum. It was uninterpretable — a
"score 78" tells you nothing you can act on. Its weights were unjustifiable, and
its normalisation ranges were hardcoded guesses (`normalize(average, 2, 10)`).
And it could not convert to money, which is the actual objective: prize money is
60.000€ per point.

A product of three estimated factors is also structurally right. Whether a
player is on the pitch dominates everything else, and a product captures that a
0% start chance means zero points regardless of quality — a weighted sum cannot.

**Consequences.** Every number in the app is now readable, and every
recommendation carries "+1.4 pts/round, about 84k".

---

## 7. Shrink small samples towards a prior

**Context.** Early in a season a player may have one round of data. Taking it at
face value makes a single 20-point week look like a certainty.

**Decision.** Blend observed points-per-start with a per-role prior, weighted
`rounds / (rounds + 2)`. Shrink start rate towards 0.5 the same way.

**Consequences.** Advice is usable from round one and stops over-reacting, at
the cost of slightly under-rating a genuine breakout for a couple of rounds.
`sampleRounds` is carried on every player so the UI can say how much evidence
there is.

---

## 8. Try every legal formation

**Context.** The original picked a hardcoded 4-3-3.

**Decision.** Evaluate every formation `/5/strategy/availables` permits and keep
the best total.

**Reasoning.** This league disables multiposition, so roles are disjoint. For a
fixed formation the optimum is therefore just the best N per role, which makes
enumerate-and-compare **exactly optimal rather than heuristic**. Cost is trivial
— seven shapes, four sorted lists.

**Consequences.** If the league ever enables multiposition, this stops being
optimal and `pickLineup` needs a real assignment algorithm. The reasoning is
recorded in the file's header comment.

---

## 9. Field an unavailable player rather than leave a slot empty

**Decision.** An injured player is never picked while a fit replacement exists,
but is used to fill an otherwise empty slot.

**Reasoning.** Futmondo scores a missing place as zero. An unfit body might not.

---

## 10. Judge market and clause moves against the player they would replace

**Context.** The original ranked the market in isolation and recommended the
highest scorer.

**Decision.** Score a candidate by the upgrade over the weakest current starter
in the same role, and surface only positive upgrades.

**Reasoning.** A brilliant forward is not a buy if your forwards are already
better. Absolute ranking produces confident-looking noise, which is worse than
saying nothing.

**Consequences.** Some days the honest answer is "nothing worth doing", and the
app says it.

---

## 11. Reconstruct rival funds, and label them an estimate

**Context.** The league hides rival funds. Knowing who can afford a clause is
the decisive information edge — it determines both which steals are contested
and which of our own players need blocking.

**Decision.** Derive `budget - spent + received + prizes` from the transfer
ledger and prize events. Present it as an estimate, show the working, and flag
teams with thin data.

**Reasoning.** Two assumptions do not hold perfectly: equal starting budgets,
and a complete ledger. Pressroom pagination is non-deterministic, so some old
rows may never be returned.

**Consequences.** The ordering is dependable and the amounts are not. The
wording in the UI and Telegram output is deliberate and should not be tightened
into a claim of fact.

---

## 12. Ledgers are append-only

**Decision.** `transfers` and `money_events` are never deleted by a sync, only
inserted with `ON CONFLICT DO NOTHING`.

**Reasoning.** Pagination returns different subsets on different calls
(confirmed independently by the Futmondo-Tracking project). A row absent from
this sync is not evidence it did not happen, so a reconciling delete would
destroy real data.

**Consequences.** Coverage improves with repeated syncs and never regresses.

---

## 13. `num()` refuses ambiguous number formats

**Decision.** Accept numbers and plain numeric strings. Reject anything with
separators.

**Reasoning.** `"1.500"` is ambiguous between 1500 and 1.5. These values are
euros used to price bids, so a wrong guess mis-prices a purchase by three orders
of magnitude. Refusing to parse is the safe answer.

**Consequences.** A future payload using formatted numbers would read as absent
rather than wrong, and the total parsers would degrade that feature visibly.
Making this lenient would be a regression.

---

## 14. Serialise all Futmondo calls through one throttle

**Decision.** A module-level promise chain with a minimum gap
(`FUTMONDO_MIN_INTERVAL_MS`, default 300ms), shared across every client
instance.

**Reasoning.** Clause discovery is one `/1/player/summary` per player; a 14-team
league is hundreds of calls. Every community client that survives long-term
throttles in this range.

**Consequences.** Expensive jobs are bounded per run (`clauses` 60 players,
`roundPoints` 5 rounds) so they fit inside a function timeout, and successive
runs rotate through the backlog.

---

## 15. Cache the session token in Postgres

**Context.** The original logged in on every request, across four pages.

**Decision.** Persist the token; re-login only on `futmondo.access.denied`, and
retry the failed call exactly once.

**Reasoning.** Serverless functions lose module state on cold start, so an
in-memory cache alone would still log in constantly, risking a lock.

---

## 16. Drop scraped matches below 0.8 confidence

**Decision.** Name matching runs ordered strategies (override, exact, surname +
club, league-unique surname) each with a confidence. Anything under 0.8 is
discarded and reported as unmatched.

**Reasoning.** A wrong match attributes one player's injury to another and
benches a fit starter. That is worse than having no scrape at all. Unmatched
names surface as warnings so they can be fixed with
`FUTMONDO_NAME_OVERRIDES`.

---

## 17. Scrape the fitness page, not the probable-lineup page

**Context.** The obvious source is FútbolFantasy's "posibles alineaciones", but
it is client-rendered and needs a browser.

**Decision.** Scrape `/laliga/lesionados` instead, which is server-rendered and
publishes a **start percentage per doubtful player**, refreshed daily.

**Reasoning.** Only players with a fitness question appear there — about 65
across the league — and that is exactly the useful set. For everyone else,
recent minutes from Futmondo's own round data are a better signal than a scrape.
No browser dependency, and one regex pass.

**Consequences.** No full probable XIs. Judged the better trade: the decisions
that lose points are about doubtful players, not about whether a regular starter
starts.

---

## 18. Render pages on the server

**Context.** Pages were client components fetching `/api/analyze` on mount.

**Decision.** Server components call `runAnalysis()` directly and pass the report
to a client component that only re-fetches on demand.

**Reasoning.** Removes an HTTP round trip, removes the loading flash, and
removes a fetch-on-mount effect that React's own lint rule flags. `runAnalysis`
is server-only anyway.

**Consequences.** Every page is `force-dynamic`, which is correct — the report
reads live state and must never be prerendered.

---

## 19. `CRON_SECRET` absent means disabled, not open

**Decision.** Protected routes deny when the secret is unset. `TELEGRAM_CHAT_ID`
behaves the same way: an empty allowlist obeys nobody.

**Reasoning.** These endpoints write to Futmondo and can spend money. Failing
closed is the only defensible default.

---

## 20. Raw SQL, no ORM

**Decision.** `@neondatabase/serverless` with hand-written SQL and a small
migration runner.

**Reasoning.** Thirteen stable tables and a handful of queries. The queries that
matter — de-margining odds, form over closed rounds, ledger reconstruction — are
set-based SQL that an ORM would obscure rather than help. One fewer dependency
and one fewer build step.

**Consequences.** The `UNNEST` casts cannot be type-checked, which is exactly
why `scripts/db-smoke.ts` exists. It has already earned its place by catching
two date bugs unit tests all passed.

---

## 21. Grade availability, do not treat it as a boolean

**Decision.** `src/lib/engine/availability.ts` maps every Futmondo absence
reason to one of `out` / `doubt` / `fit` and a multiplier applied to whatever
start probability the player would otherwise have had. `out` is zero, `doubt` is
0.45, and **anything unrecognised is `doubt`**.

**Reasoning.** `doubt` and `injured` arrive in the same field and do not mean the
same thing: most doubtful players start. Zeroing both forced three of a
fifteen-player squad out of contention, left ten fit outfield players for eleven
shirts so no formation could be filled, and produced advice to sell a fit 17M
forward as "dead capital". A multiplier also expresses something a boolean
cannot — a doubtful player who starts 90% of the time is a better bet than a fit
player who starts 30% of the time.

**Consequences.** 0.45 is a guess and is named as one. It wants the measured
share of `doubt` players who actually started, which only became collectable
with the start record from `/1/player/summary`. The unrecognised-reason rule is
the load-bearing half: a new Futmondo wording must never be able to empty a
position silently.

---

## 22. A rule's zero must be distinguishable from its absence

**Decision.** `DEFAULT_RULES.pricePerPoint` is 0, not 60.000, and every consumer
tests `paysForPoints(rules)` before printing a money sentence rather than
printing "0€".

**Reasoning.** The configuration parser read a key that does not exist, so
`pointBonus` was undefined and `config.pointBonus ?? DEFAULT.pricePerPoint`
substituted an invented rate. Every "worth about 84k a round in prize money"
line the app ever printed was fiction, and it read as authoritative because the
arithmetic was right. This league's `moneyPerPoint` is genuinely 0.

**Consequences.** Decisions rank on expected points and say nothing about money
until `rankingMode: "flop"` is understood well enough to convert a ranking
payout into a per-point rate. That is a real loss of expressiveness, and it is
better than a confident wrong number.

---

## 23. Gate clause advice on the clause date, and never derive it

**Decision.** `clause.date` is stored on the snapshot and read directly. A
clause dated in the future produces no steal and no exposure, in either
direction, and the report says when the window opens instead.

**Reasoning.** Two different formulas are visible in the same league on the same
day — acquisition + 5 days to the millisecond for drafted players,
end-of-local-day + 2 for bought ones — so any rule reconciling them would be a
guess. Rule 3 forbids guessing a write payload; the same caution applies to a
rule deciding whether to spend five million euros.

**Consequences.** Steal and block advice goes quiet for the first days after a
draft. That is correct: nothing was takeable. The window note keeps it from
reading as "nothing to plan".

---

## 24. Treat our own audit log as the record of a clause block

**Decision.** `runClauses` reads successful `lock` rows from `action_log` and
treats those players as blocked.

**Reasoning.** No Futmondo payload carries lock state — the clause object is
exactly `{price, date, transferred, suggestedClause}` everywhere it appears. So
the engine cannot observe the effect of its own write, `alreadyLocked` was
permanently false, and with a cap of five the same top five targets would have
been re-locked every day forever while the other ten were never reached.

**Consequences.** This can be wrong in the dangerous direction: a rival's clause
payment or an admin recalculation clears a block with no trace here, and we
would believe a player is protected who is not. It is bounded to recent history
for that reason, and every automated block is now stated in the Telegram report
so the action is at least visible. If lock state ever becomes readable, that
reading should replace this outright.

---

## 25. Rank buys by absolute upgrade while cash is abundant

**Decision.** `runMarket` ranks affordable candidates by absolute expected-points
upgrade, and falls back to points per million only when the best candidate on
the market is out of reach.

**Reasoning.** Efficiency is the right objective when funds bind. It is the wrong
one when they do not: with 202M idle in a 210M budget and no yield whatsoever on
cash, ranking by points per million put a 1.0M defender at the top of the list
and left the money doing nothing. Cash exists here only to be converted into
points.

**Consequences.** The regime is decided from the candidates in front of us
rather than a fixed threshold, computed once over the list so the comparator
stays a total order.

---

## 26. Bid above the asking price, in the auction's own increment

**Decision.** Every buy carries a ceiling (what the player is worth to us) and a
bid (the asking price plus whole `increment` steps inside that ceiling), both
shown. The increment is read per listing from
`/1/market/playerauctionsummary`.

**Reasoning.** The asking price is the auction's floor, so bidding it loses every
contested listing by construction — the single bid ever placed through this app
was an asking price. An off-step bid may be rejected outright, so the step has
to be the real one rather than an assumed constant.

**Consequences.** The markup between ask and ceiling is a stated placeholder.
The honest input is a clearing-price model fitted to what listings actually sold
for, and 21 rows in `transfers` is not a model. Both numbers are shown so the
two-tap confirmation is an informed decision rather than a number to trust —
and nothing about bidding is automated.

---

## 27. Keep both crons, and accept a ten-hour lead on market close

**Decision.** Market listings expire around 03:50Z; the decision cron stays at
18:00Z and the pre-close work is folded into it. No third cron, no external
trigger, for now.

**Reasoning.** Vercel Hobby allows two cron jobs at once a day and both are
used. The alternatives were an external GitHub Actions trigger against the
already-`CRON_SECRET`-protected route, or Vercel Pro. Neither is worth taking on
yet, because **bids are sealed**: `numberOfBids` is `"-"` in the market list and
the bidder is blanked on our own listings, so a bid placed ten hours before
close has almost the same information as one placed at close.

**Consequences.** The result of a bid is learned about two hours after
resolution rather than at it. Revisit if `numberOfBids` turns out to carry real
information (OPEN-3), which would make bidding late genuinely better than
bidding early. Whichever option is chosen, it must not put the 06:00Z data sync
at risk: a day that job does not run is a day of history lost permanently.
