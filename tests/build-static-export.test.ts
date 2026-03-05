/**
 * Failing tests for runStaticExport() — the high-level orchestrator that
 * takes a project root, starts a temporary Vite dev server, scans routes,
 * runs the appropriate static export (Pages or App Router), and returns
 * a StaticExportResult.
 *
 * runStaticExport() does NOT exist yet. These tests define the contract
 * and should fail with an import error until the implementation lands.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { StaticExportResult } from "../packages/vinext/src/build/static-export.js";
import { runStaticExport } from "../packages/vinext/src/build/static-export.js";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
const APP_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-basic");

// ─── Pages Router ────────────────────────────────────────────────────────────

describe("runStaticExport — Pages Router", () => {
  let result: StaticExportResult;
  const outDir = path.resolve(PAGES_FIXTURE, "out-run-static-pages");

  beforeAll(async () => {
    result = await runStaticExport({
      root: PAGES_FIXTURE,
      outDir,
      configOverride: { output: "export" },
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("produces HTML files in outDir", () => {
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.files.length).toBeGreaterThan(0);

    // Every listed file should physically exist on disk
    for (const file of result.files) {
      const fullPath = path.join(outDir, file);
      expect(fs.existsSync(fullPath), `expected ${file} to exist`).toBe(true);
    }
  });

  it("generates index.html", () => {
    expect(result.files).toContain("index.html");
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
  });

  it("generates about.html", () => {
    expect(result.files).toContain("about.html");
    expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
  });

  it("generates 404.html", () => {
    expect(result.files).toContain("404.html");
    expect(fs.existsSync(path.join(outDir, "404.html"))).toBe(true);
  });

  it("expands dynamic routes via getStaticPaths", () => {
    // pages-basic/pages/blog/[slug].tsx defines hello-world and getting-started
    expect(result.files).toContain("blog/hello-world.html");
    expect(result.files).toContain("blog/getting-started.html");
  });

  it("reports errors for getServerSideProps pages, not crashes", () => {
    // pages-basic has pages that use getServerSideProps (e.g. ssr.tsx).
    // These should appear as structured errors, not thrown exceptions.
    const gsspErrors = result.errors.filter((e) =>
      e.error.includes("getServerSideProps"),
    );
    expect(gsspErrors.length).toBeGreaterThan(0);
  });

  it("returns warnings array (possibly empty)", () => {
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ─── App Router ──────────────────────────────────────────────────────────────

describe("runStaticExport — App Router", () => {
  let result: StaticExportResult;
  const outDir = path.resolve(APP_FIXTURE, "out-run-static-app");

  beforeAll(async () => {
    result = await runStaticExport({
      root: APP_FIXTURE,
      outDir,
      configOverride: { output: "export" },
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("produces HTML files in outDir", () => {
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.files.length).toBeGreaterThan(0);

    for (const file of result.files) {
      const fullPath = path.join(outDir, file);
      expect(fs.existsSync(fullPath), `expected ${file} to exist`).toBe(true);
    }
  });

  it("generates index.html", () => {
    expect(result.files).toContain("index.html");
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
  });

  it("generates about.html", () => {
    expect(result.files).toContain("about.html");
    expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
  });

  it("expands dynamic routes via generateStaticParams", () => {
    // app-basic/app/blog/[slug]/page.tsx defines hello-world, getting-started, advanced-guide
    expect(result.files).toContain("blog/hello-world.html");
    expect(result.files).toContain("blog/getting-started.html");
    expect(result.files).toContain("blog/advanced-guide.html");
  });

  it("generates 404.html", () => {
    expect(result.files).toContain("404.html");
    expect(fs.existsSync(path.join(outDir, "404.html"))).toBe(true);
  });

  it("produces a warning (not error) for empty generateStaticParams", () => {
    // If a dynamic route's generateStaticParams returns [], it should be a
    // warning — the route is simply skipped — not a hard error.
    // This is tested structurally: warnings are strings, errors have { route, error }.
    // The existing staticExportApp already handles this as a warning.
    for (const w of result.warnings) {
      expect(typeof w).toBe("string");
    }
    for (const e of result.errors) {
      expect(e).toHaveProperty("route");
      expect(e).toHaveProperty("error");
      // No error should mention "empty" generateStaticParams — that goes in warnings
      expect(e.error).not.toMatch(/returned empty array/);
    }
  });

  it("returns no errors for the core static pages", () => {
    // index and about are plain server components — no dynamic API, no errors expected.
    const coreRouteErrors = result.errors.filter(
      (e) => e.route === "/" || e.route === "/about",
    );
    expect(coreRouteErrors).toEqual([]);
  });
});
