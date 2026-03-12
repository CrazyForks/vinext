import { test, chromium } from "@playwright/test";

test("quick debug", async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  
  const errors: string[] = [];
  const consoleLogs: string[] = [];
  page.on("pageerror", err => errors.push(err.message + "\n" + err.stack));
  page.on("console", msg => {
    if (msg.type() === "error" || msg.text().includes("ServerFunctions") || msg.text().includes("provider")) {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  
  // Navigate as unauthenticated user
  await page.goto("http://localhost:4180/admin/login", { timeout: 30000 }).catch(e => console.log('goto error:', e.message));
  
  // Wait for any React hydration
  await page.waitForTimeout(5000);
  
  console.log("URL:", page.url());
  console.log("\n=== Page errors ===");
  errors.forEach(e => console.log(e.slice(0, 1000)));
  console.log("\n=== Console errors ===");
  consoleLogs.forEach(e => console.log(e));
  
  // Try to see what's on screen
  const inputs = await page.locator('input').count();
  console.log("\nInput count:", inputs);
  
  const bodyHtml = await page.locator('body').innerHTML().catch(() => '(error)');
  console.log("\nBody HTML (first 2000):", bodyHtml.slice(0, 2000));
  
  await browser.close();
});
