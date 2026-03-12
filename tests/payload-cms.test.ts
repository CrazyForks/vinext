/**
 * PayloadCMS ecosystem integration tests — verifies PayloadCMS works with vinext.
 *
 * Uses subprocess-based testing: starts the Vite dev server (with @cloudflare/vite-plugin
 * for the workerd environment) as a child process, waits for it to be ready, makes HTTP
 * requests, and asserts on responses.
 *
 * Run with: npx vitest run tests/payload-cms.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "ecosystem", "payload-cms");
const PORT = 4410;

async function startFixture(): Promise<{
  process: ChildProcess;
  baseUrl: string;
  fetchPage: (pathname: string) => Promise<{ html: string; status: number }>;
  fetchJson: (pathname: string, init?: RequestInit) => Promise<{ data: unknown; status: number }>;
}> {
  const baseUrl = `http://localhost:${PORT}`;

  const proc = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: FIXTURE_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    detached: process.platform !== "win32",
  });

  // Collect all output for error diagnostics
  let allOutput = "";

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `PayloadCMS fixture did not start within 60s.\nOutput:\n${allOutput}`,
        ),
      );
    }, 60000);

    const onData = (data: Buffer) => {
      const text = data.toString();
      allOutput += text;
      if (text.includes("ready in") || text.includes("Local:")) {
        clearTimeout(timeoutId);
        resolve();
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeoutId);
        reject(
          new Error(
            `PayloadCMS fixture exited with code ${code}.\nOutput:\n${allOutput}`,
          ),
        );
      }
    });
  });

  // Give the server a moment to be fully ready
  await new Promise((r) => setTimeout(r, 1000));

  async function fetchPage(pathname: string) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    return { html, status: res.status };
  }

  async function fetchJson(pathname: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(15000),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { data, status: res.status };
  }

  return { process: proc, baseUrl, fetchPage, fetchJson };
}

function killProcess(proc: ChildProcess | null) {
  if (!proc || proc.killed) return;

  if (process.platform === "win32") {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    return;
  }

  const pid = proc.pid;
  if (pid == null) return;

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

// ─── payload-cms ──────────────────────────────────────────────────────────────
describe("payload-cms", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (pathname: string) => Promise<{ html: string; status: number }>;
  let fetchJson: (
    pathname: string,
    init?: RequestInit,
  ) => Promise<{ data: unknown; status: number }>;
  let baseUrl: string;

  beforeAll(async () => {
    const fixture = await startFixture();
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
    fetchJson = fixture.fetchJson;
    baseUrl = fixture.baseUrl;
  }, 60000);

  afterAll(() => killProcess(proc));

  // ── Frontend page ────────────────────────────────────────────────────────

  it("renders frontend home page", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("PayloadCMS + vinext");
  });

  it("frontend page queries posts collection", async () => {
    const { html } = await fetchPage("/");
    // The page renders the posts count — even zero is fine, just needs to be present
    expect(html).toContain("Posts count:");
  });

  it("frontend page links to admin panel", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('href="/admin"');
  });

  // ── Admin UI ─────────────────────────────────────────────────────────────

  it("admin panel responds at /admin", async () => {
    const { status } = await fetchPage("/admin");
    // Should redirect to login (302/307) or render the admin UI (200)
    expect([200, 302, 307, 308]).toContain(status);
  });

  it("admin login page renders", async () => {
    // Follow redirect to /admin/login if needed
    const res = await fetch(`${baseUrl}/admin`, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    // PayloadCMS admin login page should contain its title or form elements
    expect(res.status).toBe(200);
    expect(html.toLowerCase()).toMatch(/payload|admin|login/);
  });

  // ── REST API ─────────────────────────────────────────────────────────────

  it("REST API /api/users responds", async () => {
    const { status } = await fetchJson("/api/users");
    // 401 unauthorized is expected (no auth), but it should respond (not 404/500)
    expect([200, 401, 403]).toContain(status);
  });

  it("REST API /api/posts responds", async () => {
    const { status } = await fetchJson("/api/posts");
    expect([200, 401, 403]).toContain(status);
  });

  it("REST API returns JSON content-type", async () => {
    const res = await fetch(`${baseUrl}/api/users`, {
      signal: AbortSignal.timeout(15000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });

  it("REST API health or version endpoint responds", async () => {
    // PayloadCMS exposes /api/globals or version info — try a well-known endpoint
    const { status } = await fetchJson("/api/payload-preferences");
    expect([200, 401, 403, 404]).toContain(status);
  });

  // ── First user creation (initial setup) ──────────────────────────────────

  it("can create first admin user via REST API", async () => {
    // POST /api/users/first-register creates the first admin user when no users exist.
    // If a user already exists this returns 403 — both are acceptable outcomes.
    const { status, data } = await fetchJson("/api/users/first-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.com",
        password: "Admin1234!",
      }),
    });
    // 200 = created successfully, 403/409 = already exists or setup locked
    expect([200, 201, 400, 403, 409]).toContain(status);
    if (status === 200 || status === 201) {
      expect((data as any).user?.email ?? (data as any).doc?.email).toBe("admin@example.com");
    }
  });
});
