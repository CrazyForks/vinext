import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

// file-type@19 splits its API across two entry points:
//   - "default" condition → core.js  (no fileTypeFromFile — browser-safe subset)
//   - "node" condition    → index.js  (has fileTypeFromFile — Node.js full API)
//
// payload@3 imports { fileTypeFromFile } from 'file-type', which means it
// requires the "node" entry. Vite's dep optimizer runs esbuild, which uses the
// "default" condition (core.js) and thus can't find fileTypeFromFile.
//
// The fix is to resolve "file-type" to its absolute index.js path, bypassing
// the exports map entirely. Since file-type is not directly resolvable from the
// fixture root (pnpm doesn't hoist it), we resolve it transitively via payload:
//   1. Resolve payload's main entry (payload IS a direct fixture dep)
//   2. Extract payload's package root from that path
//   3. Use createRequire from payload's root to resolve file-type (which payload
//      depends on), getting the absolute path to index.js
const _require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const payloadMain = _require.resolve("payload");
const payloadPkgRoot = payloadMain.split("/node_modules/payload/")[0] + "/node_modules/payload";
const payloadRequire = createRequire(payloadPkgRoot + "/index.js");
const fileTypeIndexPath = payloadRequire.resolve("file-type");

// blake3-wasm@2.x has a "module" field pointing to esm/index.js, which does
//   export * from './node.js'
// but ./node.js doesn't exist in the esm/ directory. It's a placeholder that
// Rollup/Webpack are expected to replace via a build plugin. esbuild (used by
// Vite's dep optimizer) picks up the "module" field and fails to resolve the
// ./node.js import.
// Fix: alias blake3-wasm to its CJS dist entry (dist/index.js) which works fine.
const blake3WasmDistPath = payloadRequire.resolve("blake3-wasm");

// Vite plugin that stubs drizzle-kit/api with no-op exports in the RSC environment.
//
// @payloadcms/db-d1-sqlite references drizzle-kit/api inside requireDrizzleKit(),
// which is only called from pushDevSchema() (disabled via push: false). But even
// with push: false, if the module is pre-bundled by esbuild, the static import is
// included in the bundle and miniflare tries to resolve it — failing with
// "no match for module: drizzle-kit/api".
//
// By stubbing drizzle-kit/api as a virtual module, miniflare never needs to find
// the real package. The no-op exports are safe because requireDrizzleKit() is never
// actually called at runtime (push: false).
const DRIZZLE_KIT_STUB_EXPORTS = [
  "generateDrizzleJson",
  "generateMigration",
  "generateMySQLDrizzleJson",
  "generateMySQLMigration",
  "generateSQLiteDrizzleJson",
  "generateSQLiteMigration",
  "generateSingleStoreDrizzleJson",
  "generateSingleStoreMigration",
  "pushMySQLSchema",
  "pushSQLiteSchema",
  "pushSchema",
  "pushSingleStoreSchema",
  "startStudioMySQLServer",
  "startStudioPostgresServer",
  "startStudioSQLiteServer",
  "startStudioSingleStoreServer",
  "upPgSnapshot",
];

const DRIZZLE_KIT_STUB_ID = "\0virtual:drizzle-kit/api";

const stubDrizzleKitPlugin = {
  name: "stub-drizzle-kit-api",
  resolveId(id: string) {
    if (id === "drizzle-kit/api" || id.startsWith("drizzle-kit/api?")) {
      return DRIZZLE_KIT_STUB_ID;
    }
  },
  load(id: string) {
    if (id === DRIZZLE_KIT_STUB_ID) {
      const exports = DRIZZLE_KIT_STUB_EXPORTS.map(
        (name) => `export const ${name} = () => { throw new Error('drizzle-kit/api is not available in Workers runtime'); };`
      ).join("\n");
      return exports + "\nexport default {};\n";
    }
  },
};

// esbuild plugin that marks drizzle-kit/api as external during dep pre-bundling.
// This prevents esbuild from inlining drizzle-kit/api when pre-bundling
// @payloadcms/db-d1-sqlite, so the reference passes through to the Vite module
// graph where the stubDrizzleKitPlugin above can intercept and stub it.
const drizzleKitExternalPlugin = {
  name: "drizzle-kit-external",
  setup(build: any) {
    build.onResolve({ filter: /^drizzle-kit/ }, (args: any) => ({
      path: args.path,
      external: true,
    }));
  },
};

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      // The worker entry runs in the RSC environment, with SSR as a child.
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
    // Stub drizzle-kit/api so miniflare never tries to load the real package.
    // Must come after cloudflare() so the RSC environment is already configured.
    stubDrizzleKitPlugin,
  ],
  resolve: {
    conditions: ["node", "import", "module", "browser", "default"],
    alias: {
      // Map "file-type" to the absolute path of index.js so both Vite's resolver
      // and esbuild's dep optimizer always get the full Node.js API entry point.
      "file-type": fileTypeIndexPath,
      // Map "blake3-wasm" to its CJS dist entry to avoid the broken esm/index.js
      // which does `export * from './node.js'` (a placeholder that doesn't exist).
      "blake3-wasm": blake3WasmDistPath,
      // @payload-config is the conventional alias for the user's payload.config.ts.
      // Mirrors the tsconfig.json paths entry so Vite resolves it correctly.
      "@payload-config": resolve(__dirname, "src/payload.config.ts"),
    },
  },
  optimizeDeps: {
    // @next/env is a CJS bundle (ncc-compiled) that uses __dirname.
    // Excluding it from pre-bundling prevents esbuild from converting it to ESM
    // and stripping __dirname, which would cause a ReferenceError at runtime.
    exclude: ["@next/env"],
    esbuildOptions: {
      conditions: ["node", "import", "module", "browser", "default"],
    },
  },
  // Per-environment dep optimizer config: the RSC environment (Cloudflare Workers runner)
  // has its own dep optimizer that must also exclude @next/env, and must not pre-bundle
  // @payloadcms/ui or @payloadcms/next (which contain "use client" components). Pre-bundling
  // those collapses the "use client" boundary and runs createContext at module init in the
  // RSC environment, where React's server build doesn't export it.
  // prettier uses node:os which is unavailable in the Workers dep fallback service, so exclude it too.
  environments: {
    rsc: {
      optimizeDeps: {
        exclude: [
          "@next/env",
          "@payloadcms/ui",
          "@payloadcms/next",
          "@payloadcms/next/layouts",
          "@payloadcms/next/views",
          "prettier",
          // drizzle-kit is excluded to prevent Vite from creating a deps_rsc/drizzle-kit/api
          // chunk. @payloadcms/db-d1-sqlite references it via createRequire (inside
          // requireDrizzleKit), but we disable push:false in payload.config.ts so it's
          // never actually called. The esbuildOptions plugin below marks it external when
          // bundling @payloadcms/db-d1-sqlite so the reference is preserved as an import
          // rather than being inlined. Together, exclude+plugin mean: no pre-bundled chunk
          // is created AND the import is kept as an external (never-called) reference.
          "drizzle-kit",
        ],
        esbuildOptions: {
          conditions: ["node", "import", "module", "browser", "default"],
          // Mark drizzle-kit/api as external so esbuild doesn't try to bundle it when
          // pre-bundling @payloadcms/db-d1-sqlite. Combined with drizzle-kit being in
          // exclude, this prevents any deps_rsc chunk for drizzle-kit from being created.
          plugins: [drizzleKitExternalPlugin],
        },
      },
    },
  },
});
