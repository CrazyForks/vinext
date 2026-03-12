/**
 * Tests for runStaticExport() — the high-level orchestrator that
 * takes a project root, starts a temporary Vite dev server, scans routes,
 * runs the appropriate static export (Pages or App Router), and returns
 * a StaticExportResult.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { StaticExportResult } from "../packages/vinext/src/build/static-export.js";
import { runStaticExport } from "../packages/vinext/src/build/static-export.js";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
const HYBRID_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/hybrid-basic");

// ─── Pages Router ────────────────────────────────────────────────────────────

describe("runStaticExport — Pages Router", () => {
  let result: StaticExportResult;
  const outDir = path.resolve(PAGES_FIXTURE, "out-run-static-pages");

  beforeAll(async () => {
    result = await runStaticExport({
      root: PAGES_FIXTURE,
      outDir,
      // trailingSlash: false → pages are written as about.html, not about/index.html
      configOverride: { output: "export", trailingSlash: false },
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
    const gsspErrors = result.errors.filter((e) => e.error.includes("getServerSideProps"));
    expect(gsspErrors.length).toBeGreaterThan(0);
  });

  it("returns warnings array (possibly empty)", () => {
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ─── App Router ──────────────────────────────────────────────────────────────
//
// Uses hybrid-basic fixture (app/ + pages/) but only exercises App Router
// assertions here. The minimal fixture has no external deps so App Router
// pages render successfully, unlike the larger app-basic fixture where
// app/ pages return 500 due to its complex dependency setup.

describe("runStaticExport — App Router", () => {
  let result: StaticExportResult;
  const outDir = path.resolve(HYBRID_FIXTURE, "out-run-static-app");

  beforeAll(async () => {
    result = await runStaticExport({
      root: HYBRID_FIXTURE,
      outDir,
      // trailingSlash: false → pages are written as about.html, not about/index.html
      configOverride: { output: "export", trailingSlash: false },
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

  it("returns no errors for the core static pages", () => {
    // index and about are plain server components — no dynamic API, no errors expected.
    const coreRouteErrors = result.errors.filter((e) => e.route === "/" || e.route === "/about");
    expect(coreRouteErrors).toEqual([]);
  });

  it("returns warnings array (possibly empty)", () => {
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ─── Hybrid (app/ + pages/) ───────────────────────────────────────────────────

describe("runStaticExport — Hybrid (app/ + pages/)", () => {
  // hybrid-basic has both app/ and pages/ directories.
  // app/page.tsx and app/about/page.tsx are plain server components.
  // pages/legacy.tsx is a plain static page (no getServerSideProps).
  let result: StaticExportResult;
  const outDir = path.resolve(HYBRID_FIXTURE, "out-run-static-hybrid");

  beforeAll(async () => {
    result = await runStaticExport({
      root: HYBRID_FIXTURE,
      outDir,
      configOverride: { output: "export", trailingSlash: false },
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("exports App Router pages", () => {
    expect(result.files).toContain("index.html");
    expect(result.files).toContain("about.html");
    expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
  });

  it("exports Pages Router pages", () => {
    expect(result.files).toContain("legacy.html");
    expect(fs.existsSync(path.join(outDir, "legacy.html"))).toBe(true);
  });

  it("page count includes both routers", () => {
    // At minimum: index + about from app/, legacy from pages/
    expect(result.pageCount).toBeGreaterThanOrEqual(3);
  });

  it("emits no errors for plain static pages from either router", () => {
    const coreErrors = result.errors.filter(
      (e) => e.route === "/" || e.route === "/about" || e.route === "/legacy",
    );
    expect(coreErrors).toEqual([]);
  });

  it("does not emit the old 'pages/ is skipped' warning", () => {
    const skipWarning = result.warnings.find((w) => w.includes("pages/ is skipped"));
    expect(skipWarning).toBeUndefined();
  });
});

// ─── trailingSlash: true ──────────────────────────────────────────────────────

describe("runStaticExport — trailingSlash: true", () => {
  let result: StaticExportResult;
  const outDir = path.resolve(PAGES_FIXTURE, "out-run-static-trailing-slash");

  beforeAll(async () => {
    result = await runStaticExport({
      root: PAGES_FIXTURE,
      outDir,
      // trailingSlash: true → pages are written as about/index.html, not about.html
      configOverride: { output: "export", trailingSlash: true },
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("writes about/index.html instead of about.html", () => {
    expect(result.files).toContain("about/index.html");
    expect(fs.existsSync(path.join(outDir, "about/index.html"))).toBe(true);
    // about.html should NOT be present
    expect(result.files).not.toContain("about.html");
    expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(false);
  });

  it("writes index.html at root (unchanged for trailingSlash)", () => {
    expect(result.files).toContain("index.html");
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
  });

  it("every listed file exists on disk", () => {
    for (const file of result.files) {
      const fullPath = path.join(outDir, file);
      expect(fs.existsSync(fullPath), `expected ${file} to exist`).toBe(true);
    }
  });
});
