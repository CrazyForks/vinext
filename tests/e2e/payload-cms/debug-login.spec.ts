import { test, chromium } from "@playwright/test";

test("debug login page", async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleLogs: string[] = [];
  const errors: string[] = [];
  const requests: string[] = [];
  const allResponses: Array<{url: string, status: number}> = [];

  page.on("console", msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => errors.push(err.message));
  page.on("requestfailed", req => requests.push(`FAIL: ${req.url()} - ${req.failure()?.errorText}`));
  page.on("response", resp => allResponses.push({url: resp.url(), status: resp.status()}));

  // First register user
  const regResp = await page.request.post("http://localhost:4180/api/users/first-register", {
    data: { email: "admin@example.com", password: "test-password-123456" },
  });
  console.log("Register response:", regResp.status());

  // Fetch the HTML source of /admin/login directly
  const htmlResp = await page.request.get("http://localhost:4180/admin/login");
  const html = await htmlResp.text();
  console.log("Login page status:", htmlResp.status());
  console.log("Login page HTML (first 500):", html.slice(0, 500));

  // Check if virtual proxy module is referenced in HTML
  const proxyRef = html.match(/virtual:vite-rsc\/client-package-proxy[^"']*/g);
  console.log("Virtual proxy refs in HTML:", proxyRef);

  // Check the virtual proxy module directly
  const proxyUrl = "http://localhost:4180/@id/__x00__virtual:vite-rsc/client-package-proxy/@payloadcms/ui";
  const proxyResp = await page.request.get(proxyUrl).catch(e => ({ status: () => -1, text: () => e.message }));
  const proxyStatus = (proxyResp as any).status();
  const proxyText = typeof (proxyResp as any).text === 'function' ? await (proxyResp as any).text() : '(error)';
  console.log("Virtual proxy status:", proxyStatus);
  console.log("Virtual proxy content:", proxyText.slice(0, 500));

  await page.goto("http://localhost:4180/admin/login", { timeout: 30000 }).catch(e => console.log('goto error:', e.message));

  await page.waitForTimeout(15000);

  // Log all responses
  const nonOk = allResponses.filter(r => r.status >= 400);
  console.log("URL:", page.url());
  console.log("Console logs:", consoleLogs.join("\n"));
  console.log("Page errors:", errors.join("\n"));
  console.log("Failed requests:", requests.join("\n"));
  console.log("Error responses:", nonOk.map(r => `${r.status} ${r.url}`).join("\n"));

  // Log page body
  const bodyText = await page.locator("body").innerText().catch(() => "(error)");
  console.log("Body text (first 500):", bodyText.slice(0, 500));

  const emailInput = page.locator('input[name="email"], input[name="emailOrUsername"]');
  const visible = await emailInput.isVisible();
  console.log("Email input visible:", visible);

  await browser.close();
});
