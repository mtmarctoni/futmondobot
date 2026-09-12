# Continuous integration

What each check is for, and what to do when it fails. Read this before
weakening a gate: every rule here exists because something specific went wrong
or would have gone wrong quietly.

Run everything CI runs, locally, in one command:

```bash
pnpm verify     # typecheck, lint, guards, tests
pnpm build      # the one CI runs separately because it is slow
```

## Why the checks look like this

Type checking and unit tests cannot see this project's characteristic bug. Six
times now, a parser has read a key the API does not send: `role()` missing
`CENTROCAMPISTA` deleted every midfielder in the league, `parseMatch` reading
`home`/`away` instead of `h`/`a` left all 380 fixtures without a team id. None
of them threw, none of them failed a test, and the reports stayed plausible.
The suite was green throughout, because the fixtures were written from the same
wrong assumption as the code.

So the gates are in three tiers:

| Tier | Runs on | Secrets | Catches |
| --- | --- | --- | --- |
| Static | every pull request | none | does not compile, does not lint, tests fail, coverage dropped |
| House rules | every pull request | none | violations of the AGENTS.md hard rules |
| Live | manual or scheduled | yes | wrong SQL casts, a changed payload shape, a production that stopped working |

## Tier 1: static gates

`.github/workflows/ci.yml`, no credentials, safe on a pull request from
anywhere.

- **Types** — `pnpm typecheck`.
- **Lint** — `pnpm lint`.
- **Tests and coverage** — `pnpm test:coverage`. Coverage floors live in
  `vitest.config.mts` as a ratchet: each is set just under the level measured
  when the gate was added, so the number cannot drift down unnoticed. The
  parsers carry the highest floor, because unlike the engine they can be tested
  completely from captured payloads.
- **Build** — `pnpm build`, with no environment variables on purpose. Every page
  is `force-dynamic` and the database client is built lazily, so a build that
  starts needing a secret means something now runs at build time that should
  not.
- **Workflow and shell lint** — `actionlint` over `.github/workflows/`, which
  checks expression syntax and action inputs and runs shellcheck across every
  `run:` block, plus `shellcheck` over `scripts/*.sh`. It earned its place by
  catching a malformed expression in `ci.yml` on the day it was written, which
  would otherwise have surfaced as a failed run on main.
- **Install** — every job installs with `--frozen-lockfile`, which fails when
  `package.json` and `pnpm-lock.yaml` disagree. Never relax it to make a build
  pass; run `pnpm install` and commit the lockfile.

`CI` is an aggregate job that passes only when all of the above pass. Require
that one in branch protection and adding a gate will not mean editing the
repository settings.

## Tier 2: house rules

`pnpm guards` (`scripts/ci-guards.ts`). Each rule is a hard rule from
`AGENTS.md` expressed as something a machine can refuse, and each prints the
rule it enforces when it fails.

| Rule | Refuses |
| --- | --- |
| `no-emoji` | Emoji or pictographs in code, comments or copy. The plain check and cross marks the Telegram reports already use are allowed. |
| `pnpm-only` | A second lockfile, or `npm`/`yarn` commands in tracked files. |
| `no-tracked-secrets` | A tracked `.env` file, or something shaped like a token, database URL or key. |
| `money-writes-confined` | `placeBid`, `modifyBid`, `payClause` or `putOnMarket` called anywhere but the confirmed-tap Telegram route, and the raw market endpoints outside the client. |
| `mondo-writes-disabled` | `lockPlayer` anywhere but the verified wrapper in `client.ts` (plus its test, `AGENTS.md` prose and docs). Blocking costs 200 mondos a player a week and is intentionally uncalled — the Telegram route is excluded too, so a lock button cannot be wired back. |
| `requests-through-transport` | The Futmondo host referenced outside `transport.ts`. Failure arrives as HTTP 200, and `postEnvelope` is the only code that reads `answer.error`. |
| `ledger-append-only` | `DELETE FROM` or `TRUNCATE` against `transfers` or `money_events`. |
| `dates-through-helpers` | `toISOString()` on anything but a freshly constructed `Date`, outside `repo.ts`. Date columns arrive as local-time objects and formatting one by hand reports the previous day. |
| `no-type-escapes` | `any`, `@ts-ignore`, or an eslint suppression. The codebase has none, so a new one is a regression rather than a local exception. |
| `no-focused-tests` | A committed `.only` or `.skip`, which leaves the suite reporting green on less than it claims. |
| `no-stray-files` | A dot-prefixed probe script at the root, build caches, generated output. |
| `migrations-forward-only` | Editing or deleting a migration that has already run. Add a new numbered one. |
| `parser-change-needs-fixture` | Changing a `pick()` lookup in `parse.ts` without touching a test under `src/lib/futmondo/`. |

The last one is the important one. It cannot check that a fixture is real, only
that you went and looked at the tests. **A fixture invented to match the code
proves nothing.** Capture the payload from the live API.

### If a guard is wrong

Say so in the pull request and change the rule in the same commit. Do not work
around it: the suite is only worth having while a failure always means
something, and a rule that gets routinely bypassed is worse than no rule.

### House rules can fail

`pnpm guards:verify` injects one real violation per rule and asserts the
matching rule catches it. A guard that has only ever passed is
indistinguishable from a guard whose pattern silently stopped matching, so CI
runs this too. **Adding a rule to `ci-guards.ts` means adding a case to
`scripts/verify-guards.sh`.**

It reverts tracked files to undo each injection, so it refuses to run against a
dirty tree rather than discarding work in progress.

## Tier 3: live checks

`.github/workflows/live-checks.yml`. Two jobs, both needing real credentials,
neither reachable from a pull request.

**That last part is deliberate.** This repository is public and pull requests
are expected from an agent. A PR-triggered job runs the pull request's own copy
of the workflow file, so any trigger a contributor can cause is a trigger that
can be rewritten to print the secrets it was handed. The jobs therefore run
only from the Actions tab or on a schedule.

- **Database smoke** — the 29 assertions in `scripts/db-smoke.ts`. This is the
  only thing that checks the `UNNEST` casts in `src/lib/db/repo.ts`, which no
  unit test can reach, and it has already caught two real date bugs. It writes
  only `smoke-` prefixed rows and cleans up on failure. **Run it for any change
  to `repo.ts`.**
- **Production canary** — asks the deployed app to exercise every Futmondo
  endpoint and report each separately. Runs daily at 07:00 UTC, an hour after
  the sync cron, because history cannot be backfilled: a day the sync silently
  failed is a day of value trends lost permanently. It prints per-endpoint
  status only, never the payload, since the response carries funds and squad
  names and these logs are public.

### One-time setup

Both jobs use a GitHub environment named `live`. Create it under
**Settings - Environments**, add yourself as a required reviewer so a run pauses
for approval before secrets are handed over, and add three secrets to it:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | the Neon connection string |
| `APP_URL` | the deployed base URL, no trailing path |
| `CRON_SECRET` | the same value the deployment uses |

Until they exist the jobs fail with a message saying which is missing, rather
than passing on having checked nothing.

### The gap worth knowing about

The database smoke test is not a pull request gate, so a change to `repo.ts`
can merge without its `UNNEST` casts ever being exercised. Running it on a PR
would mean giving PR code the production database URL, which is the trade this
setup refuses.

The way to close it properly is an ephemeral database per pull request instead
of the real one. That needs a Neon branch (which reintroduces an API key on
the PR path) or a Postgres service container fronted by
`ghcr.io/neondatabase/wsproxy`, because `@neondatabase/serverless` speaks
Neon's own protocol rather than plain Postgres. Until then: run the Live checks
workflow by hand on any pull request touching `src/lib/db/`.

## Security scanning

`.github/workflows/codeql.yml` runs CodeQL with the `security-and-quality`
queries on every pull request and weekly. Free on public repositories.

Two things worth enabling in **Settings - Code security** that no workflow can
do for you:

- **Secret scanning** and **push protection** — rejects a commit containing a
  recognised credential at push time. `no-tracked-secrets` catches the shapes
  it knows about; this catches the ones it does not.
- **Dependabot alerts** — `.github/dependabot.yml` groups routine updates into
  one pull request a month, but security advisories only arrive if alerts are
  on.
