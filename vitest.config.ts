import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],

    // No real mailserver, no files on disk: SQLite runs in memory and the
    // key is throwaway.
    env: {
      MASTER_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      DATABASE_PATH: ":memory:",
    },
  },
});
