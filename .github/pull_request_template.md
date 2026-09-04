## What this changes

<!-- The behaviour that is different afterwards, not the files touched. -->

## Why

<!-- The decision this improves. If it fixes wrong advice, say what the app
     recommended before and what it recommends now. -->

## How it was verified

<!-- Delete what does not apply. An unticked box is fine; a wrongly ticked one
     is not. CI runs the first four itself. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm guards`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm db:smoke` (required for any change to `src/lib/db/repo.ts`; run the
      Live checks workflow, or locally with credentials)
- [ ] Checked against the live API (`GET /api/futmondo`), for changes to
      `src/lib/futmondo/`

## If this touches a parser

A parser test is worth nothing unless its fixture is a real captured payload.
Every parser bug in this repository passed a green suite because the fixture
repeated the same wrong assumption as the code.

- [ ] The fixture is a payload captured from the live API
- [ ] Where it was captured from: <!-- endpoint, and roughly when -->

## Anything that could not be verified

<!-- Say so plainly. A write payload that could not be confirmed from
     docs/futmondo-api.md must be reported here rather than tried
     (AGENTS.md hard rule 3). -->
