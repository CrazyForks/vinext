/**
 * Tests for Phase 2 of static pre-rendering.
 *
 * Tests:
 * 1. Production server serving pre-rendered HTML from dist/server/pages/
 * 2. prerenderStaticPages() function existence and return type
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");

// ─── Production server — serves pre-rendered HTML ─────────────────────────────

describe("Production server — serves pre-rendered HTML", () => {
  const outDir = path.resolve(PAGES_FIXTURE, "dist");
  const serverEntryPath = path.join(outDir, "server", "entry.js");
  const pagesDir = path.join(outDir, "server", "pages");
  const prerenderedFile = path.join(pagesDir, "prerendered-test.html");
  const hasServerEntry = fs.existsSync(serverEntryPath);

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    if (!hasServerEntry) return;

    // Create a fake pre-rendered HTML file at dist/server/pages/prerendered-test.html
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(
      prerenderedFile,
      `<!DOCTYPE html><html><head><title>Pre-rendered</title></head><body><div id="__next">Pre-rendered test content</div></body></html>`,
      "utf-8",
    );

    const { startProdServer } = await import(
      "../packages/vinext/src/server/prod-server.js"
    );
    server = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Clean up the fake pre-rendered file and pages directory
    if (fs.existsSync(prerenderedFile)) {
      fs.rmSync(prerenderedFile);
    }
    if (fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length === 0) {
      fs.rmdirSync(pagesDir);
    }
  });

  it.skipIf(!hasServerEntry)(
    "serves pre-rendered HTML for /prerendered-test",
    async () => {
      const res = await fetch(`${baseUrl}/prerendered-test`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pre-rendered test content");
    },
  );

  it.skipIf(!hasServerEntry)(
    "serves pre-rendered HTML with text/html content type",
    async () => {
      const res = await fetch(`${baseUrl}/prerendered-test`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    },
  );

  it.skipIf(!hasServerEntry)(
    "falls back to SSR when no pre-rendered file exists",
    async () => {
      // /about is a real page in pages-basic but has no pre-rendered file
      const res = await fetch(`${baseUrl}/about`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("About");
    },
  );

  it.skipIf(!hasServerEntry)(
    "serves nested pre-rendered HTML (e.g. /blog/hello-world)",
    async () => {
      // Create a nested pre-rendered file simulating a dynamic route
      const nestedDir = path.join(pagesDir, "blog");
      const nestedFile = path.join(nestedDir, "hello-world.html");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(
        nestedFile,
        `<!DOCTYPE html><html><body>Blog post content</body></html>`,
        "utf-8",
      );

      try {
        const res = await fetch(`${baseUrl}/blog/hello-world`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Blog post content");
      } finally {
        fs.rmSync(nestedFile);
        if (fs.existsSync(nestedDir) && fs.readdirSync(nestedDir).length === 0) {
          fs.rmdirSync(nestedDir);
        }
      }
    },
  );

  it.skipIf(!hasServerEntry)(
    "serves pre-rendered index.html for /",
    async () => {
      const indexFile = path.join(pagesDir, "index.html");
      fs.writeFileSync(
        indexFile,
        `<!DOCTYPE html><html><body>Pre-rendered home</body></html>`,
        "utf-8",
      );

      try {
        const res = await fetch(`${baseUrl}/`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Pre-rendered home");
      } finally {
        fs.rmSync(indexFile);
      }
    },
  );
});

// ─── prerenderStaticPages — function exists ───────────────────────────────────

describe("prerenderStaticPages — function exists", () => {
  it("prerenderStaticPages is exported as a function", async () => {
    const mod = await import("../packages/vinext/src/build/static-export.js");
    expect(typeof mod.prerenderStaticPages).toBe("function");
  });

  it("PrerenderResult type is returned", async () => {
    // This will fail because prerenderStaticPages doesn't exist yet
    const { prerenderStaticPages } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    // Call with the pages-basic fixture which has a built dist/
    const result = await prerenderStaticPages({ root: PAGES_FIXTURE });
    expect(result).toHaveProperty("pageCount");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("skipped");
  });
});
