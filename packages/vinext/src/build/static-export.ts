/**
 * Static export for `output: 'export'`.
 *
 * Renders all pages to static HTML files at build time. Produces a directory
 * of HTML + client JS/CSS that can be deployed to any static file host
 * (S3, Cloudflare Pages, GitHub Pages, Nginx, etc.) with no server required.
 *
 * Pages Router:
 *   - Static pages → render to HTML
 *   - getStaticProps pages → call at build time, render with props
 *   - Dynamic routes → call getStaticPaths, render each (fallback: false required)
 *   - Dynamic routes without getStaticPaths → warning, skipped
 *   - getServerSideProps → build error
 *   - API routes → skipped with warning
 *
 * App Router:
 *   - Static pages → run Server Components at build time, render to HTML
 *   - Dynamic routes → call generateStaticParams(), render each
 *   - Dynamic routes without generateStaticParams → warning, skipped
 */
import type { ViteDevServer } from "vite";
import type { Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";
import { loadNextConfig, resolveNextConfig, type ResolvedNextConfig, type NextConfig } from "../config/next-config.js";
import { pagesRouter, apiRouter } from "../routing/pages-router.js";
import { appRouter } from "../routing/app-router.js";
import { safeJsonStringify } from "../server/html.js";
import { escapeAttr } from "../shims/head.js";
import path from "node:path";
import fs from "node:fs";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { createValidFileMatcher, type ValidFileMatcher } from "../routing/file-matcher.js";

const VITE_CONFIG_FILES = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];

/**
 * Create a temporary Vite dev server for a project root.
 * Uses the project's vite config if present, otherwise auto-configures with vinext.
 * Pass `listen: true` to bind an HTTP port (needed for fetching pages).
 */
async function createTempViteServer(
  root: string,
  opts: { listen?: boolean } = {},
): Promise<import("vite").ViteDevServer> {
  const vite = await import("vite");
  const hasViteConfig = VITE_CONFIG_FILES.some((f) => fs.existsSync(path.join(root, f)));

  let serverConfig: import("vite").InlineConfig;
  if (hasViteConfig) {
    serverConfig = {
      root,
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    };
  } else {
    const { default: vinextPlugin } = await import("../index.js");
    serverConfig = {
      root,
      configFile: false,
      plugins: [vinextPlugin({ appDir: root })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    };
  }

  const server = await vite.createServer(serverConfig);
  if (opts.listen) await server.listen();
  return server;
}

function findFileWithExtensions(basePath: string, matcher: ValidFileMatcher): boolean {
  return matcher.dottedExtensions.some((ext) => fs.existsSync(basePath + ext));
}

/**
 * Render a React element to string using renderToReadableStream (Suspense support).
 * Uses Web Streams API — works in Node.js 18+ and Cloudflare Workers.
 */
async function renderToStringAsync(element: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

export interface StaticExportOptions {
  /** Vite dev server (for SSR module loading) */
  server: ViteDevServer;
  /** Discovered page routes (excludes API routes) */
  routes: Route[];
  /** Discovered API routes */
  apiRoutes: Route[];
  /** Pages directory path */
  pagesDir: string;
  /** Output directory for static files */
  outDir: string;
  /** Resolved next.config.js */
  config: ResolvedNextConfig;
}

export interface StaticExportResult {
  /** Number of HTML files generated */
  pageCount: number;
  /** Generated file paths (relative to outDir) */
  files: string[];
  /** Warnings encountered */
  warnings: string[];
  /** Errors encountered (non-fatal, specific pages) */
  errors: Array<{ route: string; error: string }>;
}

/**
 * Run static export for Pages Router.
 *
 * Creates a directory of static HTML files by rendering each route at build time.
 */
export async function staticExportPages(
  options: StaticExportOptions,
): Promise<StaticExportResult> {
  const { server, routes, apiRoutes, pagesDir, outDir, config } = options;
  const fileMatcher = createValidFileMatcher(config.pageExtensions);
  const result: StaticExportResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    errors: [],
  };

  // Ensure output directory exists
  fs.mkdirSync(outDir, { recursive: true });

  // Warn about API routes
  if (apiRoutes.length > 0) {
    result.warnings.push(
      `${apiRoutes.length} API route(s) skipped — API routes are not supported with output: 'export'`,
    );
  }

  // Gather all pages to render (expand dynamic routes via getStaticPaths)
  const pagesToRender: Array<{
    route: Route;
    urlPath: string;
    params: Record<string, string | string[]>;
  }> = [];

  for (const route of routes) {
    // Skip internal pages
    const routeName = path.basename(route.filePath, path.extname(route.filePath));
    if (routeName.startsWith("_")) continue;

    const pageModule = await server.ssrLoadModule(route.filePath);

    // Validate: getServerSideProps is not allowed with static export
    if (typeof pageModule.getServerSideProps === "function") {
      result.errors.push({
        route: route.pattern,
        error: `Page uses getServerSideProps which is not supported with output: 'export'. Use getStaticProps instead.`,
      });
      continue;
    }

    if (route.isDynamic) {
      // Dynamic route — needs getStaticPaths to enumerate params
      if (typeof pageModule.getStaticPaths !== "function") {
        result.warnings.push(
          `Dynamic route ${route.pattern} has no getStaticPaths() — skipping (no pages generated)`,
        );
        continue;
      }

      const pathsResult = await pageModule.getStaticPaths({
        locales: [],
        defaultLocale: "",
      });
      const fallback = pathsResult?.fallback ?? false;

      if (fallback !== false) {
        result.errors.push({
          route: route.pattern,
          error: `getStaticPaths must return fallback: false with output: 'export' (got: ${JSON.stringify(fallback)})`,
        });
        continue;
      }

      const paths: Array<{ params: Record<string, string | string[]> }> =
        pathsResult?.paths ?? [];

      for (const { params } of paths) {
        // Build the URL path from the route pattern and params
        const urlPath = buildUrlFromParams(route.pattern, params);
        pagesToRender.push({ route, urlPath, params });
      }
    } else {
      // Static route — render directly
      pagesToRender.push({ route, urlPath: route.pattern, params: {} });
    }
  }

  // Load shared components (_app, _document, head shim, dynamic shim)
  let AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null = null;
  const appPath = path.join(pagesDir, "_app");
  if (findFileWithExtensions(appPath, fileMatcher)) {
    try {
      const appModule = await server.ssrLoadModule(appPath);
      AppComponent = appModule.default ?? null;
    } catch {
      // _app exists but failed to load
    }
  }

  let DocumentComponent: React.ComponentType | null = null;
  const docPath = path.join(pagesDir, "_document");
  if (findFileWithExtensions(docPath, fileMatcher)) {
    try {
      const docModule = await server.ssrLoadModule(docPath);
      DocumentComponent = docModule.default ?? null;
    } catch {
      // _document exists but failed to load
    }
  }

  const headShim = await server.ssrLoadModule("next/head");
  const dynamicShim = await server.ssrLoadModule("next/dynamic");
  const routerShim = await server.ssrLoadModule("next/router");

  // Render each page
  for (const { route, urlPath, params } of pagesToRender) {
    try {
      const html = await renderStaticPage({
        server,
        route,
        urlPath,
        params,
        pagesDir,
        config,
        AppComponent,
        DocumentComponent,
        headShim,
        dynamicShim,
        routerShim,
      });

      const outputPath = getOutputPath(urlPath, config.trailingSlash);
      const fullPath = path.join(outDir, outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, html, "utf-8");

      result.files.push(outputPath);
      result.pageCount++;
    } catch (e) {
      result.errors.push({
        route: urlPath,
        error: (e as Error).message,
      });
    }
  }

  // Render 404 page
  try {
    const html404 = await renderErrorPage({
      server,
      pagesDir,
      statusCode: 404,
      AppComponent,
      DocumentComponent,
      headShim,
      fileMatcher,
    });
    if (html404) {
      const fullPath = path.join(outDir, "404.html");
      fs.writeFileSync(fullPath, html404, "utf-8");
      result.files.push("404.html");
      result.pageCount++;
    }
  } catch {
    // No custom 404, skip
  }

  return result;
}

interface RenderStaticPageOptions {
  server: ViteDevServer;
  route: Route;
  urlPath: string;
  params: Record<string, string | string[]>;
  pagesDir: string;
  config: ResolvedNextConfig;
  AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null;
  DocumentComponent: React.ComponentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headShim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dynamicShim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routerShim: any;
}

async function renderStaticPage(options: RenderStaticPageOptions): Promise<string> {
  const {
    server,
    route,
    urlPath,
    params,
    config: _config,
    AppComponent,
    DocumentComponent,
    headShim,
    dynamicShim,
    routerShim,
  } = options;

  // Set SSR context for router shim
  if (typeof routerShim.setSSRContext === "function") {
    routerShim.setSSRContext({
      pathname: urlPath,
      query: params,
      asPath: urlPath,
    });
  }

  try {
    const pageModule = await server.ssrLoadModule(route.filePath);
    const PageComponent = pageModule.default;
    if (!PageComponent) {
      throw new Error(`Page ${route.filePath} has no default export`);
    }

    // Collect page props
    let pageProps: Record<string, unknown> = {};

    if (typeof pageModule.getStaticProps === "function") {
      const result = await pageModule.getStaticProps({ params });
      if (result && "props" in result) {
        pageProps = result.props as Record<string, unknown>;
      }
      if (result && "redirect" in result) {
        // Static export can't handle redirects — write a meta redirect
        const redirect = result.redirect as { destination: string };
        return `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${escapeAttr(redirect.destination)}" /></head><body></body></html>`;
      }
      if (result && "notFound" in result && result.notFound) {
        throw new Error(`Page ${urlPath} returned notFound: true`);
      }
    }

    // Build element
    const createElement = React.createElement;
    let element: React.ReactElement;

    if (AppComponent) {
      element = createElement(AppComponent, {
        Component: PageComponent,
        pageProps,
      });
    } else {
      element = createElement(PageComponent, pageProps);
    }

    // Reset head collector and flush dynamic preloads
    if (typeof headShim.resetSSRHead === "function") {
      headShim.resetSSRHead();
    }
    if (typeof dynamicShim.flushPreloads === "function") {
      await dynamicShim.flushPreloads();
    }

    // Render page body
    const bodyHtml = await renderToStringAsync(element);

    // Collect head tags
    const ssrHeadHTML =
      typeof headShim.getSSRHeadHTML === "function"
        ? headShim.getSSRHeadHTML()
        : "";

    // __NEXT_DATA__ for client hydration
    const nextDataScript = `<script>window.__NEXT_DATA__ = ${safeJsonStringify({
      props: { pageProps },
      page: route.pattern,
      query: params,
    })}</script>`;

    // Build HTML shell
    let html: string;

    if (DocumentComponent) {
      const docElement = createElement(DocumentComponent);
      // renderToReadableStream auto-prepends <!DOCTYPE html> when root is <html>
      let docHtml = await renderToStringAsync(docElement);
      docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
      if (ssrHeadHTML) {
        docHtml = docHtml.replace("</head>", `  ${ssrHeadHTML}\n</head>`);
      }
      docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
      if (!docHtml.includes("__NEXT_DATA__")) {
        docHtml = docHtml.replace("</body>", `  ${nextDataScript}\n</body>`);
      }
      html = docHtml;
    } else {
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${ssrHeadHTML}
</head>
<body>
  <div id="__next">${bodyHtml}</div>
  ${nextDataScript}
</body>
</html>`;
    }

    return html;
  } finally {
    // Always clear SSR context, even if rendering throws
    if (typeof routerShim.setSSRContext === "function") {
      routerShim.setSSRContext(null);
    }
  }
}

interface RenderErrorPageOptions {
  server: ViteDevServer;
  pagesDir: string;
  statusCode: number;
  AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null;
  DocumentComponent: React.ComponentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headShim: any;
  fileMatcher: ValidFileMatcher;
}

async function renderErrorPage(
  options: RenderErrorPageOptions,
): Promise<string | null> {
  const { server, pagesDir, statusCode, AppComponent, DocumentComponent, headShim, fileMatcher } =
    options;

  const candidates =
    statusCode === 404
      ? ["404", "_error"]
      : statusCode === 500
        ? ["500", "_error"]
        : ["_error"];

  for (const candidate of candidates) {
    const candidatePath = path.join(pagesDir, candidate);
    if (!findFileWithExtensions(candidatePath, fileMatcher)) continue;

    const errorModule = await server.ssrLoadModule(candidatePath);
    const ErrorComponent = errorModule.default;
    if (!ErrorComponent) continue;

    const createElement = React.createElement;
    const errorProps = { statusCode };

    let element: React.ReactElement;
    if (AppComponent) {
      element = createElement(AppComponent, {
        Component: ErrorComponent,
        pageProps: errorProps,
      });
    } else {
      element = createElement(ErrorComponent, errorProps);
    }

    if (typeof headShim.resetSSRHead === "function") {
      headShim.resetSSRHead();
    }

    const bodyHtml = await renderToStringAsync(element);

    let html: string;
    if (DocumentComponent) {
      const docElement = createElement(DocumentComponent);
      let docHtml = await renderToStringAsync(docElement);
      docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
      docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", "");
      html = docHtml;
    } else {
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="__next">${bodyHtml}</div>
</body>
</html>`;
    }

    return html;
  }

  return null;
}

/**
 * Build a URL path from a route pattern and params.
 * E.g., "/posts/:id" + { id: "42" } → "/posts/42"
 * E.g., "/docs/:slug+" + { slug: ["a", "b"] } → "/docs/a/b"
 */
function buildUrlFromParams(
  pattern: string,
  params: Record<string, string | string[]>,
): string {
  const parts = pattern.split("/").filter(Boolean);
  const result: string[] = [];

  for (const part of parts) {
    if (part.endsWith("+") || part.endsWith("*")) {
      // Catch-all: :slug+ or :slug*
      const paramName = part.slice(1, -1);
      const value = params[paramName];
      if (Array.isArray(value)) {
        result.push(...value);
      } else if (value) {
        result.push(String(value));
      }
    } else if (part.startsWith(":")) {
      // Dynamic segment: :id
      const paramName = part.slice(1);
      const value = params[paramName];
      result.push(String(value));
    } else {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/**
 * Determine the output file path for a given URL.
 * Respects trailingSlash config.
 */
function getOutputPath(urlPath: string, trailingSlash: boolean): string {
  if (urlPath === "/") {
    return "index.html";
  }

  // Normalize and reject path traversal from user-controlled params
  const normalized = path.posix.normalize(urlPath);
  if (normalized.includes("..")) {
    throw new Error(`Route path "${urlPath}" contains path traversal segments`);
  }

  const clean = normalized.replace(/^\//, "");

  if (trailingSlash) {
    return `${clean}/index.html`;
  }
  return `${clean}.html`;
}

/**
 * Resolve parent dynamic segment params for a route.
 *
 * Implements Next.js's top-down params passing for generateStaticParams().
 * Walks up the route hierarchy to find parent dynamic segments that have their
 * own generateStaticParams. Collects parent params by calling each parent's
 * generateStaticParams in order, merging results top-down.
 *
 * Returns an array of parent param combinations. If empty, the child should
 * be called with `{ params: {} }` (bottom-up approach).
 */
async function resolveParentParams(
  childRoute: AppRoute,
  allRoutes: AppRoute[],
  server: ViteDevServer,
): Promise<Record<string, string | string[]>[]> {
  // Extract the dynamic segment names from the pattern
  const patternParts = childRoute.pattern.split("/").filter(Boolean);

  // Identify parent dynamic segments: each :param in the pattern except the last one(s)
  // that belong to the leaf page's directory.
  // Strategy: find ancestor routes (layout-level) that export generateStaticParams.
  // An ancestor route's pattern is a prefix of the child's pattern.

  // Collect parent segments with generateStaticParams by looking at page modules
  // along the ancestor path. We look for pages/layouts that define generateStaticParams
  // at each level of the path hierarchy.
  type ParentSegment = {
    params: string[];
    generateStaticParams: (opts: { params: Record<string, string | string[]> }) => Promise<Record<string, string | string[]>[]>;
  };

  const parentSegments: ParentSegment[] = [];

  // Walk pattern parts to find intermediate dynamic segments
  // For /products/:category/:id, we look for a route or layout at /products/:category
  // that has generateStaticParams
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (!part.startsWith(":")) continue;

    // Check if this is not the last dynamic param (i.e., it's a parent segment)
    const isLastDynamicPart = !patternParts.slice(i + 1).some((p) => p.startsWith(":"));
    if (isLastDynamicPart) break; // This is the child's own segment

    // Build the prefix pattern up to this segment
    const prefixPattern = "/" + patternParts.slice(0, i + 1).join("/");

    // Find a route at this prefix that has generateStaticParams
    const parentRoute = allRoutes.find((r) => r.pattern === prefixPattern);
    if (parentRoute?.pagePath) {
      try {
        const parentModule = await server.ssrLoadModule(parentRoute.pagePath);
        if (typeof parentModule.generateStaticParams === "function") {
          const paramName = part.replace(/^:/, "").replace(/[+*]$/, "");
          parentSegments.push({
            params: [paramName],
            generateStaticParams: parentModule.generateStaticParams,
          });
        }
      } catch {
        // Skip — parent module couldn't be loaded
      }
    }
  }

  if (parentSegments.length === 0) return [];

  // Top-down resolution: call each parent's generateStaticParams in order,
  // accumulating params
  let currentParams: Record<string, string | string[]>[] = [{}];

  for (const segment of parentSegments) {
    const nextParams: Record<string, string | string[]>[] = [];
    for (const parentParams of currentParams) {
      const results = await segment.generateStaticParams({ params: parentParams });
      if (Array.isArray(results)) {
        for (const result of results) {
          nextParams.push({ ...parentParams, ...result });
        }
      }
    }
    currentParams = nextParams;
  }

  return currentParams;
}

/**
 * Expand a dynamic App Router route into concrete URLs via generateStaticParams.
 * Handles parent param resolution (top-down passing).
 * Returns the list of expanded URLs, or an empty array if the route has no params.
 */
async function expandDynamicAppRoute(
  route: AppRoute,
  allRoutes: AppRoute[],
  server: ViteDevServer,
  generateStaticParams: (opts: { params: Record<string, string | string[]> }) => Promise<Record<string, string | string[]>[]>,
): Promise<string[]> {
  const parentParamSets = await resolveParentParams(route, allRoutes, server);

  let paramSets: Record<string, string | string[]>[];
  if (parentParamSets.length > 0) {
    paramSets = [];
    for (const parentParams of parentParamSets) {
      const childResults = await generateStaticParams({ params: parentParams });
      if (Array.isArray(childResults)) {
        for (const childParams of childResults) {
          paramSets.push({ ...parentParams, ...childParams });
        }
      }
    }
  } else {
    paramSets = await generateStaticParams({ params: {} });
  }

  if (!Array.isArray(paramSets)) return [];
  return paramSets.map((params) => buildUrlFromParams(route.pattern, params));
}

// -------------------------------------------------------------------
// App Router static export
// -------------------------------------------------------------------

export interface AppStaticExportOptions {
  /** Base URL of a running dev server (e.g. "http://localhost:5173") */
  baseUrl: string;
  /** Discovered app routes */
  routes: AppRoute[];
  /** App directory path (for loading modules to call generateStaticParams) */
  appDir: string;
  /** Vite dev server (for loading page modules) */
  server: ViteDevServer;
  /** Output directory */
  outDir: string;
  /** Resolved next.config.js */
  config: ResolvedNextConfig;
}

/**
 * Run static export for App Router.
 *
 * Fetches each route from a running dev server and writes the HTML to disk.
 * For dynamic routes, calls generateStaticParams() to expand all paths.
 */
export async function staticExportApp(
  options: AppStaticExportOptions,
): Promise<StaticExportResult> {
  const { baseUrl, routes, server, outDir, config } = options;
  const result: StaticExportResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    errors: [],
  };

  fs.mkdirSync(outDir, { recursive: true });

  // Collect all URLs to render
  const urlsToRender: string[] = [];

  for (const route of routes) {
    // Skip API route handlers — not supported in static export
    if (route.routePath && !route.pagePath) {
      result.warnings.push(
        `Route handler ${route.pattern} skipped — API routes are not supported with output: 'export'`,
      );
      continue;
    }

    if (!route.pagePath) continue;

    if (route.isDynamic) {
      // Dynamic route — must have generateStaticParams
      try {
        const pageModule = await server.ssrLoadModule(route.pagePath);

        if (typeof pageModule.generateStaticParams !== "function") {
          result.warnings.push(
            `Dynamic route ${route.pattern} has no generateStaticParams() — skipping (no pages generated)`,
          );
          continue;
        }

        const expandedUrls = await expandDynamicAppRoute(
          route, routes, server, pageModule.generateStaticParams,
        );

        if (expandedUrls.length === 0) {
          result.warnings.push(
            `generateStaticParams() for ${route.pattern} returned empty array — no pages generated`,
          );
          continue;
        }

        urlsToRender.push(...expandedUrls);
      } catch (e) {
        result.errors.push({
          route: route.pattern,
          error: `Failed to call generateStaticParams(): ${(e as Error).message}`,
        });
      }
    } else {
      // Static route
      urlsToRender.push(route.pattern);
    }
  }

  // Fetch each URL from the dev server and write HTML
  for (const urlPath of urlsToRender) {
    try {
      const res = await fetch(`${baseUrl}${urlPath}`);
      if (!res.ok) {
        result.errors.push({
          route: urlPath,
          error: `Server returned ${res.status}`,
        });
        await res.body?.cancel(); // release connection
        continue;
      }

      const html = await res.text();
      const outputPath = getOutputPath(urlPath, config.trailingSlash);
      const fullPath = path.join(outDir, outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, html, "utf-8");

      result.files.push(outputPath);
      result.pageCount++;
    } catch (e) {
      result.errors.push({
        route: urlPath,
        error: (e as Error).message,
      });
    }
  }

  // Render 404 page
  try {
    const res = await fetch(`${baseUrl}/__nonexistent_page_for_404__`);
    if (res.status === 404) {
      const html = await res.text();
      if (html.length > 0) {
        const fullPath = path.join(outDir, "404.html");
        fs.writeFileSync(fullPath, html, "utf-8");
        result.files.push("404.html");
        result.pageCount++;
      }
    }
  } catch {
    // No custom 404, skip
  }

  return result;
}

// -------------------------------------------------------------------
// High-level orchestrator
// -------------------------------------------------------------------

export interface RunStaticExportOptions {
  root: string;
  outDir?: string;
  configOverride?: Partial<NextConfig>;
}

/**
 * High-level orchestrator for static export.
 *
 * Loads next.config from the project root, detects the router type,
 * starts a temporary Vite dev server, scans routes, runs the appropriate
 * static export (Pages or App Router), and returns the result.
 */
export async function runStaticExport(
  options: RunStaticExportOptions,
): Promise<StaticExportResult> {
  const { root, configOverride } = options;
  const outDir = options.outDir ?? path.join(root, "out");

  // 1. Load and resolve config
  const loadedConfig = await loadNextConfig(root);
  const merged: NextConfig = { ...loadedConfig, ...configOverride };
  const config = await resolveNextConfig(merged);

  // 2. Detect router type
  const appDirCandidates = [
    path.join(root, "app"),
    path.join(root, "src", "app"),
  ];
  const pagesDirCandidates = [
    path.join(root, "pages"),
    path.join(root, "src", "pages"),
  ];

  const appDir = appDirCandidates.find((d) => fs.existsSync(d));
  const pagesDir = pagesDirCandidates.find((d) => fs.existsSync(d));

  if (!appDir && !pagesDir) {
    return {
      pageCount: 0,
      files: [],
      warnings: ["No app/ or pages/ directory found — nothing to export"],
      errors: [],
    };
  }

  // 3. Start a temporary Vite dev server (with listener for HTTP fetching)
  const server = await createTempViteServer(root, { listen: true });

  try {
    // 4. Clean output directory
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    // 5. Scan routes and run export
    if (appDir) {
      const addr = server.httpServer?.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const routes = await appRouter(appDir);
      return await staticExportApp({
        baseUrl,
        routes,
        appDir,
        server,
        outDir,
        config,
      });
    } else {
      // Pages Router
      const routes = await pagesRouter(pagesDir!);
      const apiRoutes = await apiRouter(pagesDir!);
      return await staticExportPages({
        server,
        routes,
        apiRoutes,
        pagesDir: pagesDir!,
        outDir,
        config,
      });
    }
  } finally {
    await server.close();
  }
}

// -------------------------------------------------------------------
// Pre-render static pages (after production build)
// -------------------------------------------------------------------

export interface PrerenderOptions {
  root: string;
  distDir?: string;
}

export interface PrerenderResult {
  pageCount: number;
  files: string[];
  warnings: string[];
  skipped: string[];
}

/**
 * Pre-render static pages after a production build.
 *
 * Starts a temporary production server, detects static routes via a temporary
 * Vite dev server, fetches each static page, and writes the HTML to
 * dist/server/pages/.
 *
 * Only runs for Pages Router builds. App Router builds skip pre-rendering
 * because the App Router prod server delegates entirely to the RSC handler
 * (which manages its own middleware, auth, and streaming pipeline).
 */
export async function prerenderStaticPages(
  options: PrerenderOptions,
): Promise<PrerenderResult> {
  const { root } = options;
  const distDir = options.distDir ?? path.join(root, "dist");

  const result: PrerenderResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    skipped: [],
  };

  // Bail if dist/ doesn't exist
  if (!fs.existsSync(distDir)) {
    result.warnings.push("dist/ directory not found — run `vinext build` first");
    return result;
  }

  // Detect router type from build output
  const appRouterEntry = path.join(distDir, "server", "index.js");
  const pagesRouterEntry = path.join(distDir, "server", "entry.js");
  const isAppRouter = fs.existsSync(appRouterEntry);
  const isPagesRouter = fs.existsSync(pagesRouterEntry);

  if (!isAppRouter && !isPagesRouter) {
    result.warnings.push("No server entry found in dist/ — cannot detect router type");
    return result;
  }

  // App Router prod server delegates entirely to the RSC handler which manages
  // its own middleware, auth, and streaming pipeline. Pre-rendered HTML files
  // would never be served, so skip pre-rendering for App Router builds.
  if (isAppRouter) {
    return result;
  }

  // Collect static routes using a temporary Vite dev server
  const collected = await collectStaticRoutes(root, false);
  result.skipped.push(...collected.skipped);

  if (collected.urls.length === 0) {
    result.warnings.push("No static routes found — nothing to pre-render");
    return result;
  }

  const staticUrls = collected.urls;

  // Start temp production server in-process
  const { startProdServer } = await import("../server/prod-server.js");
  const server = await startProdServer({
    port: 0, // Random available port
    host: "127.0.0.1",
    outDir: distDir,
  });
  const addr = server.address() as import("node:net").AddressInfo;
  const port = addr.port;

  try {
    const pagesOutDir = path.join(distDir, "server", "pages");
    fs.mkdirSync(pagesOutDir, { recursive: true });

    for (const urlPath of staticUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          result.skipped.push(urlPath);
          await res.text(); // consume body
          continue;
        }

        const html = await res.text();
        const outputPath = getOutputPath(urlPath, false);
        const fullPath = path.join(pagesOutDir, outputPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, html, "utf-8");

        result.files.push(outputPath);
        result.pageCount++;
      } catch {
        result.skipped.push(urlPath);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return result;
}

/**
 * Collect static routes by starting a temporary Vite dev server and
 * inspecting page module exports.
 */
interface CollectedRoutes {
  urls: string[];
  skipped: string[];
}

async function collectStaticRoutes(root: string, isAppRouter: boolean): Promise<CollectedRoutes> {
  // Detect source directories
  const appDirCandidates = [
    path.join(root, "app"),
    path.join(root, "src", "app"),
  ];
  const pagesDirCandidates = [
    path.join(root, "pages"),
    path.join(root, "src", "pages"),
  ];

  const appDir = appDirCandidates.find((d) => fs.existsSync(d));
  const pagesDir = pagesDirCandidates.find((d) => fs.existsSync(d));

  if (isAppRouter && !appDir) return { urls: [], skipped: [] };
  if (!isAppRouter && !pagesDir) return { urls: [], skipped: [] };

  // Only need ssrLoadModule for module inspection — no HTTP listener needed
  const server = await createTempViteServer(root);

  try {
    const urls: string[] = [];
    const skipped: string[] = [];

    if (isAppRouter && appDir) {
      const routes = await appRouter(appDir);
      for (const route of routes) {
        // Skip route handlers (API routes)
        if (route.routePath && !route.pagePath) continue;
        if (!route.pagePath) continue;

        try {
          const pageModule = await server.ssrLoadModule(route.pagePath);

          // Skip dynamic/request-dependent pages
          if (pageModule.dynamic === "force-dynamic") {
            skipped.push(`${route.pattern} (force-dynamic)`);
            continue;
          }
          // revalidate: 0 means "always revalidate" (force-dynamic equivalent) — skip.
          // Positive revalidate values (ISR) are fine to pre-render; the revalidation
          // simply won't run without a server.
          if (pageModule.revalidate === 0) {
            skipped.push(`${route.pattern} (revalidate: 0)`);
            continue;
          }

          if (route.isDynamic) {
            // Need generateStaticParams to expand
            if (typeof pageModule.generateStaticParams !== "function") continue;

            const expandedUrls = await expandDynamicAppRoute(
              route, routes, server, pageModule.generateStaticParams,
            );
            urls.push(...expandedUrls);
          } else {
            urls.push(route.pattern);
          }
        } catch (e) {
          skipped.push(`${route.pattern} (failed to load: ${(e as Error).message})`);
        }
      }
    } else if (pagesDir) {
      const routes = await pagesRouter(pagesDir);
      for (const route of routes) {
        // Skip internal pages
        const routeName = path.basename(route.filePath, path.extname(route.filePath));
        if (routeName.startsWith("_")) continue;

        try {
          const pageModule = await server.ssrLoadModule(route.filePath);

          // Skip pages with getServerSideProps
          if (typeof pageModule.getServerSideProps === "function") {
            skipped.push(`${route.pattern} (getServerSideProps)`);
            continue;
          }

          // Skip dynamic pages (getStaticProps with revalidate: 0 means force-dynamic)
          if (typeof pageModule.getStaticProps === "function") {
            try {
              const propsResult = await pageModule.getStaticProps({ params: {} });
              // revalidate: 0 means "always revalidate" (force-dynamic) — skip.
              // Positive values (ISR) are fine to pre-render.
              if (propsResult?.revalidate === 0) {
                skipped.push(`${route.pattern} (revalidate: 0)`);
                continue;
              }
            } catch {
              skipped.push(`${route.pattern} (getStaticProps failed)`);
              continue;
            }
          }

          if (route.isDynamic) {
            // Need getStaticPaths with fallback: false
            if (typeof pageModule.getStaticPaths !== "function") continue;

            const pathsResult = await pageModule.getStaticPaths({
              locales: [],
              defaultLocale: "",
            });
            if (pathsResult?.fallback !== false) continue;

            const paths: Array<{ params: Record<string, string | string[]> }> =
              pathsResult?.paths ?? [];
            for (const { params } of paths) {
              urls.push(buildUrlFromParams(route.pattern, params));
            }
          } else {
            urls.push(route.pattern);
          }
        } catch (e) {
          skipped.push(`${route.pattern} (failed to load: ${(e as Error).message})`);
        }
      }
    }

    return { urls, skipped };
  } finally {
    await server.close();
  }
}

