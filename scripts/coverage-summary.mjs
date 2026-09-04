/**
 * Renders coverage/coverage-summary.json as a markdown table on stdout, for
 * the GitHub step summary. A separate file rather than an inline `node -e` so
 * the JavaScript template literals are not fighting shell quoting.
 */
import { readFileSync } from "node:fs";

const path = "coverage/coverage-summary.json";

let total;
try {
  total = JSON.parse(readFileSync(path, "utf8")).total;
} catch {
  // The run may have failed before coverage was written. Say so rather than
  // exiting non-zero: this step only reports, it does not gate.
  console.log("No coverage summary was produced.");
  process.exit(0);
}

const rows = ["statements", "branches", "functions", "lines"]
  .map((k) => `| ${k} | ${total[k].pct}% | ${total[k].covered}/${total[k].total} |`)
  .join("\n");

console.log("## Coverage\n");
console.log("Floors are a ratchet per directory, set in `vitest.config.mts`.\n");
console.log("| metric | pct | covered |");
console.log("| --- | --- | --- |");
console.log(rows);
