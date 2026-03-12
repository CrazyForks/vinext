import { test, expect, chromium } from "@playwright/test";

/**
 * Payload CMS admin UI — Playwright E2E tests.
 *
 * These tests exercise the actual browser-rendered admin SPA, which cannot
 * be tested via SSR fetch: the Payload config object contains functions
 * (validators, hooks, access handlers) that React RSC refuses to serialise
 * across the server→client boundary. The SPA bootstraps on the client and
 * renders the login form entirely via client-side JavaScript.
 *
 * Test flow:
 *  1. Register the first admin user via REST (idempotent — skipped if already exists).
 *  2. Navigate to /admin and wait for the login form to render.
 *  3. Fill in credentials and submit — assert redirect to the dashboard.
 *  4. Navigate to the Posts collection list in the admin UI.
 */

const BASE = "http://localhost:4180";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "test-password-123456";

/**
 * Wait for the dev server to become healthy (returns non-500 on a GET to /admin).
 * Vite may return 500 "Outdated Optimize Dep" on the first request after the
 * dep cache is invalidated; this retries until the server is ready.
 */
async function waitForServer(maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/admin`, { redirect: "follow" });
      if (res.status !== 500 && res.status !== 503) return;
    } catch {
      // Connection refused — server not up yet, keep retrying
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Dev server at ${BASE} did not become healthy within ${maxMs}ms`);
}

/** Register the first admin user via REST (no-op if already registered). */
async function ensureAdminUser() {
  const res = await fetch(`${BASE}/api/users/first-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  // 201 = created, 200 = ok, 400/403/409 = already exists — all acceptable.
  const ok = res.status === 200 || res.status === 201;
  const alreadyExists = res.status === 400 || res.status === 403 || res.status === 409;
  if (!ok && !alreadyExists) {
    throw new Error(`Unexpected status from /api/users/first-register: ${res.status}`);
  }
}

test.describe("Payload CMS admin UI", () => {
  // Give the beforeAll enough headroom: server startup + dep optimization +
  // warm-up page load can take up to 2 minutes on a cold cache.
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    // Vite's dep optimizer may discover new CJS dependencies on the first
    // browser page-load and trigger a 504/500 "Outdated Optimize Dep" response.
    // Pre-warm the server: open a headless browser page and wait for Vite to
    // finish re-optimization before running any test.
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      // Navigate and wait — ignore errors (the page may 504/500 during warm-up)
      await page.goto(`${BASE}/admin/login`, { timeout: 30_000 }).catch(() => {});
      // Give Vite time to complete re-optimization and the browser time to
      // receive the HMR reload signal
      await page.waitForTimeout(10_000);
    } finally {
      await browser.close();
    }

    // Now wait for the server to stabilise (no more 500s from stale deps)
    await waitForServer(60_000);

    await ensureAdminUser();
  });

  test("admin login page renders with email and password fields", async ({ page }) => {
    await page.goto(`${BASE}/admin`);

    // Payload redirects /admin → /admin/login. Wait for the SPA to hydrate
    // and render the login form.
    const emailInput = page.locator('input[name="email"], input[name="emailOrUsername"]');
    const passwordInput = page.locator('input[name="password"]');

    await expect(emailInput).toBeVisible({ timeout: 15_000 });
    await expect(passwordInput).toBeVisible();
  });

  test("admin login succeeds and redirects to dashboard", async ({ page }) => {
    await page.goto(`${BASE}/admin/login`);

    const emailInput = page.locator('input[name="email"], input[name="emailOrUsername"]');
    const passwordInput = page.locator('input[name="password"]');

    await expect(emailInput).toBeVisible({ timeout: 15_000 });
    await emailInput.fill(ADMIN_EMAIL);
    await passwordInput.fill(ADMIN_PASSWORD);

    // Submit — Payload renders a <button type="submit"> inside the login form
    await page.locator('form button[type="submit"]').click();

    // After successful login Payload redirects to /admin (the dashboard)
    await expect(page).toHaveURL(/\/admin(\/|$)/, { timeout: 15_000 });

    // The dashboard heading should be visible
    await expect(page.locator("h1, [class*='dashboard']")).toBeVisible({ timeout: 10_000 });
  });

  test("admin dashboard shows collections in nav", async ({ page }) => {
    // Log in via REST to get a cookie, then navigate directly to dashboard
    const loginRes = await fetch(`${BASE}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(loginRes.ok).toBe(true);
    const { token } = await loginRes.json();
    expect(token).toBeDefined();

    // Set the auth cookie so the browser request is authenticated
    await page.context().addCookies([
      {
        name: "payload-token",
        value: token as string,
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(`${BASE}/admin`);

    // The nav should contain links to the Posts and Users collections
    await expect(page.locator('nav a[href*="/admin/collections/posts"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('nav a[href*="/admin/collections/users"]')).toBeVisible();
  });

  test("admin posts collection list is accessible", async ({ page }) => {
    const loginRes = await fetch(`${BASE}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    const { token } = await loginRes.json();

    await page.context().addCookies([
      {
        name: "payload-token",
        value: token as string,
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(`${BASE}/admin/collections/posts`);

    // The collection list page should render a table or list UI
    await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("h1")).toContainText(/posts/i);
  });
});
