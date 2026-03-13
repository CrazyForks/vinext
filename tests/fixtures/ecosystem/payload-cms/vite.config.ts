import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

const _require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Resolve file-type to its Node.js entry (index.js) rather than the browser entry
// (core.js). Vite's esbuild optimizer picks "default" condition which is core.js and
// lacks fileTypeFromFile, which payload needs.
const payloadMain = _require.resolve("payload");
const payloadPkgRoot = payloadMain.split("/node_modules/payload/")[0] + "/node_modules/payload";
const payloadRequire = createRequire(payloadPkgRoot + "/index.js");
const fileTypeIndexPath = payloadRequire.resolve("file-type");

// blake3-wasm's ESM entry (`esm/index.js`) re-exports `./node.js` which doesn't exist —
// it's a build-tool placeholder. Alias to the CJS dist entry instead.
const blake3WasmDistPath = payloadRequire.resolve("blake3-wasm");

// Stub drizzle-kit/api as a no-op virtual module. The DB adapter references it inside
// requireDrizzleKit() which is only called by pushDevSchema() (disabled via push: false).
// Without the stub, miniflare fails to resolve the real drizzle-kit/api package.
const DRIZZLE_KIT_STUB_EXPORTS = [
  "generateDrizzleJson", "generateMigration",
  "generateMySQLDrizzleJson", "generateMySQLMigration",
  "generateSQLiteDrizzleJson", "generateSQLiteMigration",
  "generateSingleStoreDrizzleJson", "generateSingleStoreMigration",
  "pushMySQLSchema", "pushSQLiteSchema", "pushSchema", "pushSingleStoreSchema",
  "startStudioMySQLServer", "startStudioPostgresServer",
  "startStudioSQLiteServer", "startStudioSingleStoreServer",
  "upPgSnapshot",
];

const stubDrizzleKitPlugin = {
  name: "stub-drizzle-kit-api",
  resolveId(id: string) {
    if (id === "drizzle-kit/api" || id.startsWith("drizzle-kit/api?")) {
      return "\0virtual:drizzle-kit/api";
    }
  },
  load(id: string) {
    if (id === "\0virtual:drizzle-kit/api") {
      const exports = DRIZZLE_KIT_STUB_EXPORTS.map(
        (name) => `export const ${name} = () => { throw new Error('drizzle-kit/api is not available in Workers runtime'); };`
      ).join("\n");
      return exports + "\nexport default {};\n";
    }
  },
};

// Mark drizzle-kit/api as external during dep pre-bundling so esbuild doesn't inline it
// into the @payloadcms/db-d1-sqlite bundle (where stubDrizzleKitPlugin can intercept it).
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
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
    stubDrizzleKitPlugin,
  ],
  resolve: {
    conditions: ["node", "import", "module", "browser", "default"],
    alias: {
      "file-type": fileTypeIndexPath,
      "blake3-wasm": blake3WasmDistPath,
      "@payload-config": resolve(__dirname, "src/payload.config.ts"),
    },
  },
  optimizeDeps: {
    exclude: ["@next/env"],
    esbuildOptions: {
      conditions: ["node", "import", "module", "browser", "default"],
    },
  },
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
          "drizzle-kit",
        ],
        esbuildOptions: {
          conditions: ["node", "import", "module", "browser", "default"],
          plugins: [drizzleKitExternalPlugin],
        },
      },
    },
  },
});
