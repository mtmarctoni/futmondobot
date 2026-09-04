#!/usr/bin/env bash
#
# Proves every rule in scripts/ci-guards.ts can actually fail.
#
# A guard suite that has only ever passed is decoration: it is impossible to
# tell a rule that holds from a rule whose pattern silently stopped matching.
# So each case here injects one real violation, asserts the matching rule
# reports FAIL, and reverts. Adding a rule to ci-guards.ts means adding a case
# here.
#
# This reverts tracked files with `git checkout`, so it refuses to run against
# a dirty tree rather than discarding work in progress.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to run: the working tree has uncommitted changes."
  echo "This script reverts tracked files to prove each guard fires, which"
  echo "would discard them. Commit or stash first."
  exit 1
fi

# Pin the comparison base to HEAD so the diff-scoped rules see exactly the
# injections below and nothing else. Without this the result would depend on
# how far the branch has diverged and on the clone depth, and the two rules
# that need a base would silently report "not applicable" in a shallow CI
# checkout -- which this script would then read as a missed detection.
export GUARDS_BASE="${GUARDS_BASE:-HEAD}"

# The guard script exits non-zero when a rule fails, so its output is captured
# rather than piped: pipefail would turn a successful detection into a failure.
run() { pnpm exec tsx scripts/ci-guards.ts 2>/dev/null || true; }

pass=0
missed=0

reset() {
  git checkout -- . 2>/dev/null
  git rm --cached -q .probe.ts 2>/dev/null
  rm -f .probe.ts
}

# check <description> <rule name>
check() {
  local name="$1" rule="$2" out
  out="$(run)"
  if grep -q "^FAIL ${rule}$" <<<"$out"; then
    echo "  fires: ${name}"
    pass=$((pass + 1))
  else
    echo "  MISSED: ${name} -- expected rule '${rule}' to fail"
    missed=$((missed + 1))
  fi
  reset
}

echo "Injecting one violation per rule."
echo

# A pictograph written as bytes so this file does not contain what it forbids.
printf '\n// %b\n' '\xf0\x9f\x9a\x80' >> src/lib/automation.ts
check "pictograph in a source comment" no-emoji

echo 'Run npm install to set up.' >> docs/ARCHITECTURE.md
check "npm install in the docs" pnpm-only

echo '// 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0' >> src/lib/automation.ts
check "Telegram bot token in a source file" no-tracked-secrets

echo 'export const x = () => client.placeBid(scope, {});' >> src/lib/automation.ts
check "placeBid called from the automation routine" money-writes-confined

echo 'const p = "/1/market/rosterclause";' >> src/lib/engine/apply.ts
check "raw clause-payment endpoint in apply.ts" money-writes-confined

echo 'const u = "https://api.futmondo.com/1/x";' >> src/lib/engine/apply.ts
check "Futmondo host reached outside the transport" requests-through-transport

# shellcheck disable=SC2016  # the backticks are literal text in the injected line
echo 'await sql`DELETE FROM transfers WHERE 1=1`;' >> src/lib/db/repo.ts
check "DELETE FROM transfers in the repository" ledger-append-only

echo 'const d = row.snapshot_date.toISOString();' >> src/lib/sync/index.ts
check "toISOString() on a date column" dates-through-helpers

echo 'const v = raw as any;' >> src/lib/engine/apply.ts
check "as any in the engine" no-type-escapes

echo '// @ts-ignore' >> src/lib/engine/apply.ts
check "@ts-ignore suppression" no-type-escapes

echo 'it.only("x", () => {});' >> src/lib/engine/lineup.test.ts
check "committed it.only" no-focused-tests

echo 'const x = 1;' > .probe.ts
git add -f .probe.ts 2>/dev/null
check "tracked probe script at the repo root" no-stray-files

echo '-- edited' >> src/lib/db/migrations/001_init.sql
check "edit to an already-applied migration" migrations-forward-only

echo 'const q = pick(raw, "newKey");' >> src/lib/futmondo/parse.ts
check "new pick() with no fixture change" parser-change-needs-fixture

echo
echo "${pass} rules fired, ${missed} missed"

if [ -n "$(git status --porcelain)" ]; then
  echo "warning: the tree did not come back clean:"
  git status --porcelain
  exit 1
fi

if [ "$missed" -ne 0 ]; then
  echo "A rule that cannot fail is not protecting anything. Fix its pattern."
  exit 1
fi

echo "Every guard fires on a real violation and the tree is clean."
