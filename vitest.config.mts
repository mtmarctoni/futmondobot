import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The transport throttle is read at module load; disable it so the suite
    // is not paced by the real inter-request delay.
    env: { FUTMONDO_MIN_INTERVAL_MS: "0" },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      // Only the code a unit test can reach without a database or the network.
      // src/lib/db, src/lib/sync and automation.ts need both, so including them
      // would make the global number a measure of how much of the app is
      // integration-shaped rather than how well the logic is tested.
      include: ["src/lib/engine/**", "src/lib/futmondo/**", "src/lib/providers/**"],
      exclude: ["**/*.test.ts"],
      /**
       * A ratchet, not a target. Each floor sits just under the coverage
       * measured when these gates were added, so the numbers cannot drift
       * down unnoticed; raise them when a change pushes them up.
       *
       * The parsers carry the highest floor on purpose. Every real bug in this
       * codebase has been a parser reading the wrong key, and unlike the engine
       * they can be tested completely from captured payloads, so there is no
       * excuse for an untested branch there.
       */
      thresholds: {
        "src/lib/futmondo/**": { statements: 78, branches: 72, functions: 66 },
        "src/lib/providers/**": { statements: 84, branches: 68, functions: 72 },
        "src/lib/engine/**": { statements: 38, branches: 30, functions: 32 },
      },
    },
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
