import { createRequire } from "node:module";
import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import vinext from "vinext";

/**
 * Resolve a package from within the @payloadcms/next dependency subtree.
 *
 * pnpm's strict hoisting means that packages like `ajv`, `deepmerge`, and
 * `pluralize` are only reachable from the real (symlink-resolved) directory
 * of a package that depends on them. We walk the @payloadcms/next chain and
 * resolve each package so that we can tell Vite where to find it.
 *
 * This is necessary because these CJS-only packages are imported at runtime
 * by `payload/dist/**` files that are served as individual `/@fs/` modules
 * to the browser (they're excluded from pre-bundling on the server side but
 * must still be pre-bundled for the client). Without `resolve.alias` +
 * `optimizeDeps.include`, Vite serves the raw CJS file to the browser and
 * the browser fails with "does not provide an export named 'default'".
 */
function resolveFromPayloadNext(pkg: string): string | null {
  try {
    const root = import.meta.dirname;
    const nextLink = path.join(root, "node_modules/@payloadcms/next");
    if (!existsSync(nextLink)) return null;
    const nextReal = realpathSync(nextLink);
    const nextReq = createRequire(path.join(nextReal, "package.json"));
    return nextReq.resolve(pkg);
  } catch {
    return null;
  }
}

/**
 * Resolve a package from within @payloadcms/ui's dependency subtree.
 *
 * @payloadcms/ui lives nested under @payloadcms/next in pnpm's virtual store.
 * Some packages (like bson-objectid) are deps of @payloadcms/ui specifically
 * and aren't accessible directly from @payloadcms/next.
 */
function resolveFromPayloadUi(pkg: string): string | null {
  try {
    const root = import.meta.dirname;
    const nextLink = path.join(root, "node_modules/@payloadcms/next");
    if (!existsSync(nextLink)) return null;
    const nextReal = realpathSync(nextLink);
    const nextReq = createRequire(path.join(nextReal, "package.json"));
    const uiEntry = nextReq.resolve("@payloadcms/ui");
    const uiReal = realpathSync(path.dirname(uiEntry));
    const uiReq = createRequire(path.join(uiReal, "package.json"));
    return uiReq.resolve(pkg);
  } catch {
    return null;
  }
}

// CJS-only packages that need resolve.alias + optimizeDeps.include so that
// Vite pre-bundles them into proper ESM wrappers for the browser.
//
// These packages are imported by payload/dist/**/*.js files that are served
// as individual /@fs/ modules to the browser (payload is in optimizeDeps.exclude
// for server reasons, but its browser-side modules still need their CJS deps
// pre-bundled for the client).
//
// All packages use resolve.alias pointing to an absolute path or local shim,
// plus optimizeDeps.include to ensure pre-bundling. The alias makes them
// resolvable despite pnpm's strict hoisting.
//
// For UMD packages (like pluralize) that use `root.pluralize = fn()` where
// root=this, we point the alias to a local ESM shim that inlines the factory
// function directly — this works in both SSR and browser without the UMD wrapper.
const cjsPackages: Record<string, string | null> = {
  // Imported by @payloadcms/ui chunks and payload/dist/fields/validations.js
  "bson-objectid": resolveFromPayloadUi("bson-objectid"),
  // Imported by payload/dist/fields/validations.js
  ajv: resolveFromPayloadNext("ajv"),
  // Imported by payload/dist/utilities/deepMerge.js
  deepmerge: resolveFromPayloadNext("deepmerge"),
  // Imported by payload/dist/utilities/formatLabels.js; UMD module that uses
  // `root.pluralize = fn()` where root=this — crashes in ESM strict mode.
  // We alias to a local ESM shim that inlines the factory call directly.
  pluralize: path.join(import.meta.dirname, "src/shims/pluralize.js"),
};

// @payloadcms/ui is needed for optimizeDeps.include but must NOT go into
// resolve.alias, because adding it to resolve.alias makes Vite try to load
// it in the SSR environment (Node), where its .scss imports cause
// "Unknown file extension" errors.
//
// Instead, we resolve it once here and pass it ONLY to
// optimizeDeps.esbuildOptions.alias so esbuild can find and pre-bundle it
// without affecting Vite's SSR module resolution.
const payloadcmsUiPath = resolveFromPayloadNext("@payloadcms/ui");

// Build the alias map: only include packages we successfully resolved
const cjsAlias = Object.fromEntries(
  Object.entries(cjsPackages).filter((entry): entry is [string, string] => entry[1] !== null),
);

// Build the include list for optimizeDeps
const cjsInclude = Object.keys(cjsAlias);

export default defineConfig({
  plugins: [
    vinext(),
    // @payloadcms/ui is not hoisted to the workspace root by pnpm, so Vite's
    // dep optimizer cannot find it by bare specifier. We need it pre-bundled
    // so that @vitejs/plugin-rsc's client-package-proxy virtual module can
    // re-export from it in the browser.
    //
    // Adding @payloadcms/ui to the top-level resolve.alias breaks SSR because
    // @payloadcms/ui's dist files import .scss files that Node's ESM loader
    // cannot handle. Instead, we register a resolveId hook that ONLY runs in
    // the client (browser) environment, redirecting @payloadcms/ui to its
    // absolute path so the dep optimizer and browser module graph can find it.
    ...(payloadcmsUiPath
      ? [
          {
            name: "resolve-payload-ui-client-only",
            applyToEnvironment(env: { name: string }) {
              return env.name === "client";
            },
            resolveId(id: string) {
              if (id === "@payloadcms/ui") {
                return { id: payloadcmsUiPath!, external: false };
              }
            },
          },
        ]
      : []),
  ],
  resolve: {
    // Map CJS bare specifiers to absolute paths so esbuild can pre-bundle them
    // despite pnpm's strict hoisting (they're not in the workspace root
    // node_modules, only in the pnpm virtual store under @payloadcms/next).
    alias: cjsAlias,
  },
  ssr: {
    // Keep ssr.external as an ARRAY (not `true`).
    // vinext only sets noExternal:true for the RSC environment when userSsrExternal
    // is an array — if it's `true`, noExternal is skipped and everything is
    // externalized (including @payloadcms/ui), so Node's native loader hits the
    // .css import before vinext's built-in stub can intercept it.
    //
    // Packages listed here are loaded natively by Node (bypassing Vite transform):
    //   - @payloadcms/db-sqlite / better-sqlite3: native C++ addon
    //   - undici: lazily require('node:sqlite') inside SqliteCacheStore,
    //     which becomes a static import when Vite transforms it
    //   - graphql / graphql-http / graphql-scalars: CJS/UMD bundles
    //   - pino / pino-pretty: use worker_threads + native addons
    //   - busboy: CJS streams package
    //   - ws: CJS with UMD-style exports
    //
    // Note: pluralize is NOT listed here. We alias it to a local ESM shim
    // (src/shims/pluralize.js) that works in both SSR and browser without the
    // UMD `this` issue. The shim is a local project file, so Vite transforms
    // it safely in all environments.
    external: [
      "@payloadcms/db-sqlite",
      "better-sqlite3",
      "undici",
      "graphql",
      "graphql-http",
      "graphql-scalars",
      "pino",
      "pino-pretty",
      "busboy",
      "ws",
      "console-table-printer",
    ],
  },
  optimizeDeps: {
    // Exclude packages that use Node.js APIs, native addons, or have export map
    // issues that break esbuild's dep pre-bundling.
    exclude: [
      "graphql",
      "@payloadcms/graphql",
      "graphql-http",
      "graphql-scalars",
      "payload",
      "@payloadcms/next",
      "@payloadcms/db-sqlite",
      "@payloadcms/richtext-lexical",
      "file-type",
    ],
    // Pre-bundle packages needed by the browser.
    //
    // cjsInclude contains all entries from cjsPackages (those successfully
    // resolved). The resolve.alias entries above make these findable by
    // Vite's dep scanner despite pnpm's strict hoisting.
    //
    // @payloadcms/ui specifically must be pre-bundled because
    // @vitejs/plugin-rsc's client-package-proxy load hook generates:
    //   export { Button, ... } from "@payloadcms/ui"
    // Without pre-bundling, the browser can't resolve that re-export.
    // We DON'T add it to resolve.alias (it would break SSR due to .scss imports);
    // instead we only alias it inside esbuildOptions so the optimizer can find it.
    include: [
      "@payloadcms/ui",
      "react/compiler-runtime",
      ...cjsInclude,
    ],
    esbuildOptions: {
      // Aliases applied ONLY during dep pre-bundling (esbuild step).
      // This lets esbuild find @payloadcms/ui (not hoisted to workspace root)
      // without affecting Vite's SSR module resolution at runtime.
      alias: payloadcmsUiPath
        ? { "@payloadcms/ui": payloadcmsUiPath }
        : undefined,
      plugins: [
        // @payloadcms/ui imports .scss files from its component files.
        // esbuild (used by Vite's dep optimizer) does not understand .scss,
        // so we stub all .scss imports with empty modules during pre-bundling.
        // Vite handles actual CSS at serve time via its own CSS transform
        // pipeline; these stubs only apply to the esbuild dep scanner/bundler.
        {
          name: "stub-styles-for-optimizer",
          setup(build) {
            build.onLoad({ filter: /\.(scss|css)$/ }, () => ({
              contents: "",
              loader: "empty" as const,
            }));
          },
        },
      ],
    },
  },
});
