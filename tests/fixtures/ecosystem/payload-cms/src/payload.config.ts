import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Users } from './collections/Users'
import { Posts } from './collections/Posts'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Detect whether we're running in the Payload CLI (e.g., payload migrate:create).
// In that context, cloudflare:workers is not available (no Workers runtime), so we
// fall back to wrangler's getPlatformProxy which provides real D1 bindings from
// the local .wrangler/state directory.
//
// In the Workers module runner (Vite dev / production Workers), cloudflare:workers
// is available and provides the D1 binding directly.
const isCLI = process.argv.some(
  (v) => v.endsWith('/payload/bin.js') || v.endsWith('\\payload\\bin.js'),
)

let d1Binding: any

if (isCLI) {
  // CLI mode: use wrangler's getPlatformProxy to get real D1 bindings.
  // This allows `payload migrate:create`, `payload generate:types`, etc. to work.
  const { getPlatformProxy } = await import('wrangler')
  const proxy = await getPlatformProxy()
  d1Binding = (proxy.env as any).D1
} else {
  // Workers runtime mode (Vite dev or deployed Workers).
  // cloudflare:workers is intercepted by @cloudflare/vite-plugin in dev and is
  // the real Workers runtime in production.
  // Use an indirect specifier to prevent tsx/Node.js static analysis from trying
  // to resolve cloudflare:workers during CLI module loading.
  const specifier = 'cloudflare' + ':workers'
  const { env } = await import(/* @vite-ignore */ specifier)
  d1Binding = (env as any).D1
}

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Posts],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || 'dev-secret-at-least-32-characters-long',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteD1Adapter({
    binding: d1Binding,
    // Disable automatic dev schema push. pushDevSchema() uses drizzle-kit/api which
    // cannot run inside miniflare's Workers sandbox. Instead, run migrations via:
    //   pnpm payload migrate:create  (generates SQL migration files)
    //   wrangler d1 migrations apply payload-cms-fixture --local  (applies them)
    // OR set PAYLOAD_FORCE_DRIZZLE_PUSH=true to re-enable push when running in Node.
    push: false,
  }),
})
