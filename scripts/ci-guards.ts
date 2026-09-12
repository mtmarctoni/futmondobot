/**
 * The load-bearing rules from AGENTS.md, made machine-checkable.
 *
 * This file exists because every real bug in this codebase has had the same
 * shape: a change that looks correct, type checks, passes the unit suite, and
 * silently produces wrong advice. `role()` missing CENTROCAMPISTA deleted every
 * midfielder in the league and the suite stayed green. Nothing a compiler or a
 * test runner can see would have caught it.
 *
 * So the checks here are not style rules. Each one is a rule from AGENTS.md
 * whose violation would be expensive and quiet, expressed as something a
 * machine can refuse. A check that cannot be traced to such a rule does not
 * belong in this file: the value of the suite is that a failure always means
 * something, so it is never routine to override one.
 *
 * Run with `pnpm guards`. Diff-scoped rules need history; set GUARDS_BASE to
 * pick the comparison ref, otherwise the origin default branch is used and the
 * rules are skipped (not failed) when no base can be resolved.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

type Severity = "error" | "warn";

interface Violation {
  file: string;
  line?: number;
  detail: string;
}

interface Rule {
  name: string;
  /** The AGENTS.md rule this enforces, and the bug it prevents. */
  why: string;
  severity: Severity;
  run: (ctx: Context) => Violation[];
}

interface Context {
  /** Every file git tracks, repo-relative. */
  tracked: string[];
  /** Tracked text files worth scanning line by line. */
  scannable: string[];
  /** Files changed against the merge base, or null when there is no base. */
  changed: string[] | null;
  /** The resolved merge base commit, or null. */
  base: string | null;
  text: (file: string) => string;
  /** Added and removed lines for one file in the diff against the base. */
  diffLines: (file: string) => string[];
}

// --------------------------------------------------------------------------
// git plumbing
// --------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitQuiet(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/**
 * Resolves the ref this branch should be compared against. On a pull request
 * GitHub sets GITHUB_BASE_REF; locally the default branch is the useful
 * answer. Returns the merge base commit so a branch behind main is not
 * reported as having changed everything main changed.
 */
function resolveBase(): string | null {
  const candidates: string[] = [];
  if (process.env.GUARDS_BASE) candidates.push(process.env.GUARDS_BASE);
  if (process.env.GITHUB_BASE_REF) {
    candidates.push(`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF);
  }
  candidates.push("origin/main", "main");

  for (const ref of candidates) {
    if (!gitQuiet(["rev-parse", "--verify", "--quiet", ref])) continue;
    const mergeBase = gitQuiet(["merge-base", ref, "HEAD"]);
    if (mergeBase?.trim()) return mergeBase.trim();
  }
  return null;
}

// --------------------------------------------------------------------------
// scanning helpers
// --------------------------------------------------------------------------

const SCANNABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|sql|md|json|ya?ml|css)$/;

/** Never scanned: generated, vendored, or intentionally verbatim. */
const NOT_SCANNED = [
  "pnpm-lock.yaml",
  "skills-lock.json",
  ".env.example", // documents placeholder credentials on purpose
];

/**
 * Vendored third-party content. These are agent skill definitions written by
 * other people and pinned by skills-lock.json; this project's conventions do
 * not apply to them and editing them to satisfy a guard would fight the lock.
 */
const VENDORED = [".agents/", ".claude/"];

function isScannable(file: string): boolean {
  if (NOT_SCANNED.includes(file)) return false;
  if (file.startsWith("public/")) return false;
  if (VENDORED.some((dir) => file.startsWith(dir))) return false;
  return SCANNABLE.test(file);
}

/** Reports every line of `files` matching `pattern`. */
function scan(
  ctx: Context,
  files: string[],
  pattern: RegExp,
  detail: (match: string, line: string) => string,
): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const lines = ctx.text(file).split("\n");
    lines.forEach((line, i) => {
      // Fresh regex per line: a global pattern carries lastIndex between calls.
      const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      const m = re.exec(line);
      if (m) out.push({ file, line: i + 1, detail: detail(m[0], line) });
    });
  }
  return out;
}

/** The scannable files not covered by an allowlist of exact paths or prefixes. */
function outside(ctx: Context, allowed: string[]): string[] {
  return ctx.scannable.filter(
    (f) => !allowed.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a)),
  );
}

// --------------------------------------------------------------------------
// the rules
// --------------------------------------------------------------------------

/**
 * Emoji code point ranges. Written as escapes so this file does not itself
 * contain what it forbids. Arrows and the legacy symbol blocks are left out:
 * they have non-decorative uses and would produce false positives.
 *
 * The dingbat check and cross marks (U+2713, U+2714, U+2717, U+2718) are
 * carved back out. They render as plain glyphs rather than colour emoji, and
 * the Telegram copy already uses them as status marks alongside a bullet. The
 * rule bans decoration, not the typographic marks the reports are built from.
 */
const EMOJI = new RegExp(
  "(?![\\u{2713}\\u{2714}\\u{2717}\\u{2718}])" +
    "[" +
    "\\u{1F000}-\\u{1FAFF}" + // pictographs, emoticons, transport, flags, supplements
    "\\u{2600}-\\u{27BF}" + // misc symbols and dingbats
    "\\u{2B00}-\\u{2BFF}" + // misc symbols and arrows (stars, ballots)
    "\\u{FE0F}" + // variation selector 16, the emoji presentation marker
    "]",
  "u",
);

const MONEY_METHODS = /\b(placeBid|modifyBid|payClause|putOnMarket)\b/;

/** Endpoints that move money. Sourced from src/lib/futmondo/client.ts. */
const MONEY_ENDPOINTS =
  /\/(?:1|5)\/market\/(?:bid|modifybid|rosterclause|putonmarket)\b/;

const rules: Rule[] = [
  {
    name: "no-emoji",
    why: "No emojis in code, comments, commit messages or UI copy (AGENTS.md conventions).",
    severity: "error",
    run: (ctx) =>
      scan(ctx, ctx.scannable, EMOJI, (m) => {
        const point = m.codePointAt(0)?.toString(16).toUpperCase() ?? "?";
        return `emoji or pictograph U+${point}`;
      }),
  },

  {
    name: "pnpm-only",
    why: "pnpm only, never npm (AGENTS.md conventions). A second lockfile splits the dependency tree between local and CI.",
    severity: "error",
    run: (ctx) => {
      const out: Violation[] = [];
      for (const lock of ["package-lock.json", "yarn.lock", "bun.lockb", "npm-shrinkwrap.json"]) {
        if (ctx.tracked.includes(lock)) {
          out.push({ file: lock, detail: "foreign lockfile is tracked; delete it and use pnpm-lock.yaml" });
        }
      }
      if (!ctx.tracked.includes("pnpm-lock.yaml")) {
        out.push({ file: "pnpm-lock.yaml", detail: "missing; CI installs with --frozen-lockfile and needs it committed" });
      }
      out.push(
        ...scan(
          ctx,
          ctx.scannable.filter((f) => f !== "docs/CI.md" && f !== "scripts/ci-guards.ts"),
          /\b(?:npm (?:install|ci|run|test|exec)|yarn (?:install|add|run))\b/,
          (m) => `${m} in a tracked file; this project builds with pnpm`,
        ),
      );
      return out;
    },
  },

  {
    name: "no-tracked-secrets",
    why: "Credentials reach Futmondo and a live database. A leaked one is not revocable by reverting the commit.",
    severity: "error",
    run: (ctx) => {
      const out: Violation[] = [];
      for (const file of ctx.tracked) {
        const name = file.split("/").pop() ?? file;
        if (name.startsWith(".env") && name !== ".env.example") {
          out.push({ file, detail: "environment file is tracked; only .env.example may be committed" });
        }
      }
      const patterns: Array<[RegExp, string]> = [
        [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "Telegram bot token"],
        [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{6,}@/, "Postgres URL with an inline password"],
        [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
        [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
        [/\bsk-[A-Za-z0-9]{24,}\b/, "API secret key"],
      ];
      for (const [pattern, label] of patterns) {
        out.push(...scan(ctx, ctx.scannable, pattern, () => `looks like a ${label}`));
      }
      return out;
    },
  },

  {
    name: "money-writes-confined",
    why:
      "Hard rule 2: an action that spends money may only reach Futmondo from an explicit human tap. " +
      "Bids, clause payments and sales are irreversible, so the call sites are an allowlist, not a convention.",
    severity: "error",
    run: (ctx) => {
      // The wrapper definitions, their test, and the one confirmed-tap route.
      const callers = [
        "src/lib/futmondo/client.ts",
        "src/lib/futmondo/client.test.ts",
        "src/app/api/telegram/route.ts",
      ];
      // The raw endpoint strings belong only where the wrappers are defined,
      // plus the test that pins the path and the snake_case write keys.
      const endpoints = [
        "src/lib/futmondo/client.ts",
        "src/lib/futmondo/client.test.ts",
        "docs/futmondo-api.md",
      ];
      return [
        ...scan(
          ctx,
          outside(ctx, [...callers, "docs/", "scripts/ci-guards.ts"]),
          MONEY_METHODS,
          (m) => `${m}() spends money and may only be called from ${callers[2]}`,
        ),
        ...scan(
          ctx,
          outside(ctx, [...endpoints, "scripts/ci-guards.ts"]),
          MONEY_ENDPOINTS,
          (m) => `${m} is a money-spending endpoint; go through the client wrapper`,
        ),
      ];
    },
  },

  {
    name: "mondo-writes-disabled",
    why:
      "Hard rule 2, extended: blocking a clause now costs 200 mondos a player a week, and the policy is to " +
      "spend none of the initial 2000 before the end of the season. lockPlayer may exist only as the verified " +
      "wrapper — even the confirmed-tap route may not call it, so a lock button cannot be brought back by wiring.",
    severity: "error",
    run: (ctx) =>
      scan(
        ctx,
        outside(ctx, [
          "src/lib/futmondo/client.ts",
          "src/lib/futmondo/client.test.ts",
          "AGENTS.md",
          "docs/",
          "scripts/ci-guards.ts",
        ]),
        /\blockPlayer\b/,
        () =>
          "lockPlayer() spends 200 mondos a player a week and is intentionally uncalled; no engine, automation or telegram route may invoke it",
      ),
  },

  {
    name: "requests-through-transport",
    why:
      "Hard rule 1: Futmondo reports failure as HTTP 200, and postEnvelope is the only code that reads " +
      "answer.error. A request built anywhere else cannot tell success from failure.",
    severity: "error",
    run: (ctx) =>
      scan(
        ctx,
        outside(ctx, [
          "src/lib/futmondo/transport.ts",
          "docs/",
          ".env.example",
          "README.md",
          "scripts/ci-guards.ts",
        ]),
        /\bapi\.futmondo\.com\b/,
        () => "Futmondo host referenced outside the transport; use postEnvelope",
      ),
  },

  {
    name: "ledger-append-only",
    why:
      "Hard rule 4: transfers and money_events are never deleted by a sync. Pressroom pagination is " +
      "non-deterministic, so a row missing from this call is not evidence it did not happen.",
    severity: "error",
    run: (ctx) =>
      scan(
        ctx,
        outside(ctx, ["scripts/db-smoke.ts", "docs/", "scripts/ci-guards.ts"]),
        /(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:transfers|money_events)\b/i,
        (m) => `${m.replace(/\s+/g, " ")} destroys ledger history`,
      ),
  },

  {
    name: "dates-through-helpers",
    why:
      "Hard rule 9: date columns come back as local-time Date objects, and toISOString() on one reports " +
      "the previous day under a positive UTC offset. isoDay and isoInstant in repo.ts are the only safe formatters.",
    severity: "error",
    run: (ctx) =>
      scan(
        ctx,
        outside(ctx, ["src/lib/db/repo.ts", "docs/", "scripts/ci-guards.ts"]),
        // A fresh `new Date().toISOString()` is a timestamp, not a column read.
        /(?<!new Date\(\))(?<!new Date\([^)]{0,40}\))\.toISOString\(\)/,
        () => "toISOString() on a value that may be a date column; use isoDay or isoInstant",
      ),
  },

  {
    name: "no-type-escapes",
    why:
      "A silenced type error is how a wrong payload shape reaches the engine. The codebase has no `any` " +
      "and no suppressions today, so any new one is a regression, not a local exception.",
    severity: "error",
    run: (ctx) => {
      const files = outside(ctx, ["docs/", "scripts/ci-guards.ts"]).filter((f) =>
        /\.(ts|tsx|mts)$/.test(f),
      );
      return [
        ...scan(ctx, files, /@ts-ignore\b/, () => "@ts-ignore hides the error; state it with @ts-expect-error and a reason"),
        ...scan(ctx, files, /\bas\s+any\b|:\s*any\b|<any>/, (m) => `${m.trim()} defeats the type check that guards payload shapes`),
        ...scan(ctx, files, /eslint-disable/, () => "eslint suppression; fix the finding or raise it with the user"),
      ];
    },
  },

  {
    name: "no-focused-tests",
    why:
      "A committed .only silently reduces the suite to one test, so the next change is validated by nothing. " +
      "A committed .skip retires a test without saying so.",
    severity: "error",
    run: (ctx) =>
      scan(
        ctx,
        ctx.scannable.filter((f) => /\.test\.ts$/.test(f)),
        /\b(?:it|test|describe)\.(?:only|skip)\b/,
        (m) => `${m} leaves the suite reporting green on less than it claims`,
      ),
  },

  {
    name: "no-stray-files",
    why: "Probe scripts hold live credentials in argv and build output is machine-specific. Neither belongs in history.",
    severity: "error",
    run: (ctx) => {
      const out: Violation[] = [];
      for (const file of ctx.tracked) {
        if (/^\.[a-z0-9-]*\.(?:ts|mts|js|mjs)$/.test(file)) {
          out.push({ file, detail: "dot-prefixed script at the repo root looks like a leftover probe" });
        }
        if (file.endsWith(".tsbuildinfo")) {
          out.push({ file, detail: "build cache is machine-specific; add it to .gitignore" });
        }
        if (file.startsWith("coverage/") || file.startsWith(".next/") || file.startsWith(".vercel/")) {
          out.push({ file, detail: "generated output is tracked" });
        }
      }
      return out;
    },
  },

  {
    name: "migrations-forward-only",
    why:
      "Migrations already ran against the live database and are recorded in schema_migrations. Editing one " +
      "leaves deployed schema and repository disagreeing, with nothing to detect it.",
    severity: "error",
    run: (ctx) => {
      if (!ctx.base) return [];
      const dir = "src/lib/db/migrations/";
      const status = gitQuiet(["diff", "--name-status", ctx.base, "--", dir]);
      if (status === null) return [];
      const out: Violation[] = [];
      for (const row of status.trim().split("\n").filter(Boolean)) {
        const [code, ...rest] = row.split("\t");
        const file = rest[rest.length - 1];
        if (code.startsWith("A")) {
          const name = file.slice(dir.length);
          if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) {
            out.push({ file, detail: "new migration must be named NNN_lower_snake_case.sql" });
          }
          continue;
        }
        out.push({
          file,
          detail:
            code.startsWith("M")
              ? "existing migration modified; add a new numbered migration instead"
              : `existing migration ${code === "D" ? "deleted" : `changed (${code})`}; migrations are forward-only`,
        });
      }
      return out;
    },
  },

  {
    name: "parser-change-needs-fixture",
    why:
      "AGENTS.md: a parser test is worth nothing unless its fixture is a real captured payload. Every parser " +
      "bug so far passed a green suite because the fixture repeated the same wrong assumption as the code.",
    severity: "error",
    run: (ctx) => {
      if (!ctx.changed) return [];
      const parser = "src/lib/futmondo/parse.ts";
      if (!ctx.changed.includes(parser)) return [];

      // Only key-reading logic matters here. A comment or a rename cannot
      // introduce the wrong-key bug, so it should not demand a new fixture.
      const touchesKeys = ctx
        .diffLines(parser)
        .some((line) => /\bpick\s*\(/.test(line));
      if (!touchesKeys) return [];

      const testChanged = ctx.changed.some((f) => /^src\/lib\/futmondo\/.*\.test\.ts$/.test(f));
      if (testChanged) return [];

      return [
        {
          file: parser,
          detail:
            "key lookups changed but no test under src/lib/futmondo/ changed. Add a case whose fixture is a " +
            "payload captured from the live API, not one written from the same assumption as the parser.",
        },
      ];
    },
  },
];

// --------------------------------------------------------------------------
// runner
// --------------------------------------------------------------------------

function buildContext(): Context {
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const scannable = tracked.filter((f) => isScannable(f) && existsSync(f));
  const base = resolveBase();

  const cache = new Map<string, string>();
  const text = (file: string): string => {
    let value = cache.get(file);
    if (value === undefined) {
      value = readFileSync(file, "utf8");
      cache.set(file, value);
    }
    return value;
  };

  // Compared against the working tree, not HEAD, so the rules are useful
  // locally before anything is committed.
  const changed = base
    ? (gitQuiet(["diff", "--name-only", base]) ?? "").split("\n").filter(Boolean)
    : null;

  const diffLines = (file: string): string[] => {
    const patch = gitQuiet(["diff", "--unified=0", base ?? "HEAD", "--", file]) ?? "";
    return patch
      .split("\n")
      .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !/^[+-]{3}/.test(l));
  };

  return { tracked, scannable, changed, base, text, diffLines };
}

function main(): void {
  const ctx = buildContext();

  if (!ctx.base) {
    console.log("note: no comparison base resolved; diff-scoped rules are skipped.");
  }

  let failed = 0;
  let warned = 0;

  for (const rule of rules) {
    let violations: Violation[];
    try {
      violations = rule.run(ctx);
    } catch (err) {
      // A crashing rule must not read as a pass.
      console.log(`FAIL ${rule.name}`);
      console.log(`     rule crashed: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
      continue;
    }

    if (violations.length === 0) {
      console.log(`ok   ${rule.name}`);
      continue;
    }

    const label = rule.severity === "error" ? "FAIL" : "warn";
    console.log(`${label} ${rule.name}`);
    console.log(`     ${rule.why}`);
    for (const v of violations.slice(0, 20)) {
      const at = v.line ? `${v.file}:${v.line}` : v.file;
      console.log(`     ${at}  ${v.detail}`);
    }
    if (violations.length > 20) {
      console.log(`     ... and ${violations.length - 20} more`);
    }
    if (rule.severity === "error") failed += 1;
    else warned += 1;
  }

  const summary = `${rules.length - failed - warned} passed, ${warned} warned, ${failed} failed`;
  console.log(`\n${summary}`);

  if (failed > 0) {
    console.log(
      "\nThese rules encode AGENTS.md. If one is genuinely wrong for a change, say so in the pull\n" +
        "request and change the rule in the same commit; do not work around it.",
    );
    process.exit(1);
  }
}

main();
