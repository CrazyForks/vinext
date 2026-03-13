/**
 * PayloadCMS ecosystem integration tests — verifies PayloadCMS works with vinext.
 *
 * Starts the Vite dev server (with @cloudflare/vite-plugin / workerd) as a child
 * process and makes HTTP requests to assert correct behavior.
 *
 * Run with: pnpm test tests/payload-cms.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "ecosystem", "payload-cms");
const PORT = 4410;
const BASE_URL = `http://localhost:${PORT}`;
const TIMEOUT = 20000; // per-request timeout

// ── helpers ───────────────────────────────────────────────────────────────────

async function startFixture(): Promise<{ process: ChildProcess; output: () => string }> {
  // Clear persisted wrangler state so every run starts with a fresh empty DB.
  try {
    rmSync(path.join(FIXTURE_DIR, ".wrangler", "state"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const proc = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: FIXTURE_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    detached: process.platform !== "win32",
  });

  let _allOutput = "";

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`PayloadCMS fixture did not start within 120s.\nOutput:\n${_allOutput}`));
    }, 120_000);

    const onData = (data: Buffer) => {
      const text = data.toString();
      _allOutput += text;
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
        reject(new Error(`PayloadCMS fixture exited with code ${code}.\nOutput:\n${_allOutput}`));
      }
    });
  });

  // Poll until the server is actually ready to serve requests.
  // PayloadCMS runs D1 migrations on first request, so we wait until
  // GET /api/posts returns 200 (indicating the DB is initialized).
  const pollStart = Date.now();
  const pollTimeout = 120_000;
  while (Date.now() - pollStart < pollTimeout) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/posts`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) break;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { process: proc, output: () => _allOutput };
}

function killProcess(proc: ChildProcess | null) {
  if (!proc || proc.killed) return;
  if (process.platform === "win32") {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    return;
  }
  const pid = proc.pid;
  if (pid == null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

async function get(pathname: string, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();
  return { res, status: res.status, body, contentType };
}

async function post(pathname: string, data: unknown, extra?: RequestInit) {
  const { headers: extraHeaders, ...restExtra } = extra ?? {};
  return get(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extraHeaders as Record<string, string> ?? {}) },
    body: JSON.stringify(data),
    ...restExtra,
  });
}

// ── describe ──────────────────────────────────────────────────────────────────

describe("payload-cms", () => {
  let proc: ChildProcess | null = null;
  let adminToken: string | null = null;
  let getOutput: (() => string) | null = null;

  beforeAll(async () => {
    const fixture = await startFixture();
    proc = fixture.process;
    getOutput = fixture.output;
  }, 120_000);

  afterAll(() => {
    // Print server output to help debug failures
    if (getOutput) {
      const out = getOutput();
      // Filter out RSC/admin UI noise, show only API-related lines
      const lines = out.split("\n");
      const apiLines = lines.filter(l => 
        (l.includes("posts") || l.includes("api") || l.includes("500") || l.includes("err") || l.includes("stack") || l.includes("TypeError") || l.includes("Cannot")) &&
        !l.includes("Functions cannot be passed") &&
        !l.includes("modulepreload")
      );
      if (apiLines.length > 0) {
        console.log("=== Server API/error output ===\n" + apiLines.slice(0, 50).join("\n"));
      }
    }
    killProcess(proc);
  });

  // ── Frontend page ─────────────────────────────────────────────────────────

  it("frontend / renders PayloadCMS + vinext heading", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    expect(body as string).toContain("PayloadCMS + vinext");
  });

  it("frontend / shows Posts count section", async () => {
    const { body } = await get("/");
    // Renders "Posts count: N" — React may inject a comment node between text and number
    expect(body as string).toMatch(/Posts count:[\s\S]*?\d+/);
  });

  it("frontend / links to admin panel", async () => {
    const { body } = await get("/");
    expect(body as string).toContain('href="/admin"');
  });

  // ── REST API — basic connectivity ─────────────────────────────────────────

  it("GET /api/users returns JSON with application/json content-type", async () => {
    const { status, contentType } = await get("/api/users");
    // 401 = unauthorized (no token) — that is the correct behavior
    expect([200, 401, 403]).toContain(status);
    expect(contentType).toContain("application/json");
  });

  it("GET /api/posts returns JSON (public read access)", async () => {
    const { status, body } = await get("/api/posts");
    // Posts collection has read: () => true, so 200 expected
    expect(status).toBe(200);
    expect((body as any).docs).toBeDefined();
    expect(typeof (body as any).totalDocs).toBe("number");
  });

  // ── First user registration ───────────────────────────────────────────────

  it("POST /api/users/first-register creates the first admin user", async () => {
    const { status, body } = await post("/api/users/first-register", {
      email: "admin@example.com",
      password: "Admin1234!",
    });
    // 200/201 = created; 403 = already exists (unexpected on clean DB)
    expect([200, 201]).toContain(status);
    const data = body as any;
    // PayloadCMS returns { user, token } or { doc, token }
    const email = data.user?.email ?? data.doc?.email;
    expect(email).toBe("admin@example.com");
    expect(data.token).toBeDefined();
    adminToken = data.token as string;
  });

  // ── Login flow ────────────────────────────────────────────────────────────

  it("POST /api/users/login returns token + user object", async () => {
    const { status, body } = await post("/api/users/login", {
      email: "admin@example.com",
      password: "Admin1234!",
    });
    expect(status).toBe(200);
    const data = body as any;
    expect(data.token).toBeDefined();
    expect(data.user?.email).toBe("admin@example.com");
    // Keep the token updated in case first-register didn't return one
    if (data.token) adminToken = data.token as string;
  });

  // ── Authenticated API access ──────────────────────────────────────────────

  it("GET /api/users returns user list when authenticated", async () => {
    expect(adminToken).toBeTruthy();
    const { status, body } = await get("/api/users", {
      headers: { Authorization: `JWT ${adminToken}` },
    });
    expect(status).toBe(200);
    const data = body as any;
    expect(Array.isArray(data.docs)).toBe(true);
    expect(data.docs.length).toBeGreaterThan(0);
    expect(data.docs[0].email).toBe("admin@example.com");
  });

  // ── CRUD: create a post ───────────────────────────────────────────────────

  it("POST /api/posts creates a post (authenticated)", async () => {
    expect(adminToken).toBeTruthy();
    const { status, body } = await post(
      "/api/posts",
      { title: "Hello from vinext", content: "This post was created by the test suite.", status: "published" },
      { headers: { Authorization: `JWT ${adminToken}` } },
    );
    if (status !== 200 && status !== 201) {
      console.error("POST /api/posts failed:", status, JSON.stringify(body));
    }
    expect([200, 201]).toContain(status);
    const data = body as any;
    const doc = data.doc ?? data;
    expect(doc.title).toBe("Hello from vinext");
  });

  it("GET /api/posts lists the created post", async () => {
    const { status, body } = await get("/api/posts");
    expect(status).toBe(200);
    const data = body as any;
    expect(data.totalDocs).toBeGreaterThan(0);
    const post = data.docs.find((d: any) => d.title === "Hello from vinext");
    expect(post).toBeDefined();
  });

  it("frontend / shows the created post in the list", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    // The frontend page re-fetches posts; should now show count ≥ 1
    expect(body as string).toMatch(/Posts count:[\s\S]*?[1-9]/);
    expect(body as string).toContain("Hello from vinext");
  });

  // ── Admin UI ──────────────────────────────────────────────────────────────

  it("GET /admin redirects to /admin/login when unauthenticated", async () => {
    // Without following redirects: /admin should return 307 to /admin/login
    const res = await fetch(`${BASE_URL}/admin`, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("/admin/login");
  });

  it("GET /admin/login returns 200 with PayloadCMS RSC UI", async () => {
    // Fetch the RSC stream directly — the admin UI is fully client-rendered via RSC.
    // The initial HTML is a minimal shell; content arrives via the RSC hydration stream.
    // We verify the RSC stream is valid: correct status, PayloadCMS components referenced,
    // and no fatal server-side TypeErrors in the rendered output.
    const res = await fetch(`${BASE_URL}/admin/login`, {
      redirect: "follow",
      headers: { Accept: "text/x-component" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res.status).toBe(200);
    const rsc = await res.text();

    // PayloadCMS UI components should be referenced (RootProvider from @payloadcms/ui)
    expect(rsc).toContain("@payloadcms/ui");

    // The RSC stream should contain the admin client config with login route
    // createUnauthenticatedClientConfig returns { admin: { routes: {...} }, ... }
    expect(rsc).toContain("/login");

    // No fatal TypeError from PayloadCMS components in the RSC stream
    // (e.g. "Cannot destructure property 'routes' of '{}'" would indicate broken config)
    expect(rsc).not.toContain("Cannot destructure property");
    expect(rsc).not.toContain("Internal Server Error");
  });

  it("GET /admin returns 200 with PayloadCMS dashboard when authenticated (cookie-based)", async () => {
    // PayloadCMS admin UI uses cookie-based auth for the browser session.
    // We simulate a browser login: POST to /api/users/login, capture the Set-Cookie header,
    // then GET /admin with that cookie. The admin dashboard RSC should render without errors.
    expect(adminToken).toBeTruthy();

    // Login to get session cookie
    const loginRes = await fetch(`${BASE_URL}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "Admin1234!" }),
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(loginRes.status).toBe(200);

    // Collect all Set-Cookie headers from the login response
    const setCookieHeaders = loginRes.headers.getSetCookie?.() ?? [];
    // getSetCookie may not exist in all environments; fall back to get
    const cookieHeader = setCookieHeaders.length > 0
      ? setCookieHeaders.map(c => c.split(";")[0]).join("; ")
      : (loginRes.headers.get("set-cookie") ?? "").split(",").map(c => c.split(";")[0].trim()).join("; ");

    // Fetch the authenticated admin dashboard RSC stream
    const adminRes = await fetch(`${BASE_URL}/admin`, {
      redirect: "follow",
      headers: {
        Accept: "text/x-component",
        Cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(adminRes.status).toBe(200);
    const rsc = await adminRes.text();

    // PayloadCMS UI components should be referenced
    expect(rsc).toContain("@payloadcms/ui");

    // No fatal serialization errors from RegExp/function props
    expect(rsc).not.toContain("Classes or null prototypes are not supported");
    expect(rsc).not.toContain("Event handlers cannot be passed");
    expect(rsc).not.toContain("Cannot destructure property");
    expect(rsc).not.toContain("Internal Server Error");
  });
});
