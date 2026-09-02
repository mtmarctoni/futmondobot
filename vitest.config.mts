import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The transport throttle is read at module load; disable it so the suite
    // is not paced by the real inter-request delay.
    env: { FUTMONDO_MIN_INTERVAL_MS: "0" },
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
