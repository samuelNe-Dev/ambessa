import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reports print local times; pin the zone so tests read the same everywhere.
    env: { TZ: "UTC" },
  },
});
