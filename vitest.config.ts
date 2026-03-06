import { randomUUID } from "node:crypto";
import { defineConfig } from "vitest/config";

/**
 * Integration test files that spin up Vite dev servers against shared fixture
 * directories. These must run serially to avoid Vite deps optimizer cache
 * races (node_modules/.vite/*) that produce "outdated pre-bundle" 500s.
 *
 * When adding a new test file that calls startFixtureServer(), createServer()
 * from Vite, or spawns a dev server subprocess, add it here.
 */
const integrationTests = [
  "tests/app-router.test.ts",
  "tests/pages-router.test.ts",
  "tests/features.test.ts",
  "tests/cjs.test.ts",
  "tests/ecosystem.test.ts",
  "tests/static-export.test.ts",
  "tests/postcss-resolve.test.ts",
  "tests/nextjs-compat/**/*.test.ts",
];

// GitHub Actions reporter adds inline failure annotations in PR diffs.
const reporters: string[] = process.env.CI
  ? ["default", "github-actions"]
  : ["default"];

const env = {
  // Mirrors the Vite `define` in index.ts that inlines a build-time UUID.
  // Setting it here means tests exercise the same code path as production.
  __VINEXT_DRAFT_SECRET: randomUUID(),
};

export default defineConfig({
  test: {
    reporters,
    // fileParallelism is a global setting in vitest 3.x (cannot be set
    // per-project). Integration tests need serial execution, so we keep
    // it disabled globally. The win from the project split is that
    // `vitest run --project unit` lets you skip integration tests entirely
    // for a fast feedback loop (~seconds vs ~2 minutes).
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: integrationTests,
          env,
        },
      },
      {
        test: {
          name: "integration",
          include: integrationTests,
          testTimeout: 30000,
          env,
        },
      },
    ],
  },
});
