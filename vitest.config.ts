import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process/env entry shells (cli, serve, node-env) are side-effectful by design and are
      // exercised end-to-end, not by unit tests; coverage gates the pure logic modules.
      exclude: ["src/cli.ts", "src/serve.ts", "src/node-env.ts"],
      reporter: ["text"],
      thresholds: { lines: 90, functions: 90, branches: 70, statements: 90 },
    },
  },
});
