import { createRequire } from "node:module";
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
const payloadMain = _require.resolve("payload");
const payloadPkgRoot = payloadMain.split("/node_modules/payload/")[0] + "/node_modules/payload";
const payloadRequire = createRequire(payloadPkgRoot + "/index.js");
const fileTypeIndexPath = payloadRequire.resolve("file-type");

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
  ],
  resolve: {
    conditions: ["node", "import", "module", "browser", "default"],
    alias: {
      // Map "file-type" to the absolute path of index.js so both Vite's resolver
      // and esbuild's dep optimizer always get the full Node.js API entry point.
      "file-type": fileTypeIndexPath,
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
  // @payloadcms/db-d1-sqlite imports drizzle-kit/api at init time; drizzle-kit is not available
  // in miniflare's fallback service, so exclude the adapter and its drizzle deps too.
  environments: {
    rsc: {
      optimizeDeps: {
        exclude: [
          "@next/env",
          "@payloadcms/ui",
          "@payloadcms/next",
          "prettier",
          "@payloadcms/db-d1-sqlite",
          "@payloadcms/drizzle",
          "drizzle-kit",
        ],
        esbuildOptions: {
          conditions: ["node", "import", "module", "browser", "default"],
        },
      },
    },
  },
});
