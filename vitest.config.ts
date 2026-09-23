import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@cc/shared": fileURLToPath(new URL("./shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["shared/src/**/*.test.ts", "server/src/**/*.test.ts", "agent/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["shared/src/**", "server/src/**", "agent/src/**"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/dist/**"],
      thresholds: { lines: 75 },
    },
  },
});
