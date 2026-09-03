# Documentation

Start here depending on what you need.

| Read this | When |
|---|---|
| [`../README.md`](../README.md) | You want the short version: what it is and how to run it |
| [`BEHAVIOUR.md`](./BEHAVIOUR.md) | You want to know **what the app does** and how it decides |
| [`CONFIGURATION.md`](./CONFIGURATION.md) | You are setting it up, changing a setting, or diagnosing something |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | You are about to change the code |
| [`DECISIONS.md`](./DECISIONS.md) | Something looks like an arbitrary constraint and you want to know why it is there |
| [`futmondo-api.md`](./futmondo-api.md) | You are touching `src/lib/futmondo/`. **Not optional** |
| [`../AGENTS.md`](../AGENTS.md) | You are an AI agent working in this repo. Read it first |

## The three things worth knowing before anything else

1. **Futmondo reports failure as HTTP 200**, with `answer.error: true`. Nothing
   here infers success from a status code, and neither should you.

2. **The app automates only what is reversible** — setting the lineup, blocking
   clauses. Anything that spends money needs a human tap. The boundary is
   deliberate; see [decision 4](./DECISIONS.md).

3. **History cannot be backfilled.** The API only reports the present, so every
   day the sync does not run is a permanent gap in the value trends that make
   the advice good.
