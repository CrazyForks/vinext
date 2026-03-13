import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Users } from './collections/Users'
import { Posts } from './collections/Posts'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Detect the runtime context:
//  - CLI: payload bin.js (migrate:create, generate:types, etc.) — use getPlatformProxy for D1
//  - generate:importmap: only walks the config, never connects to DB — skip D1 entirely
//  - Workers runtime: cloudflare:workers provides D1 directly (Vite dev or production)
const argv = process.argv
const isCLI = argv.some(
  (v) => v.endsWith('/payload/bin.js') || v.endsWith('\\payload\\bin.js'),
)
const isImportMapGen = isCLI && argv.includes('generate:importmap')

let d1Binding: any

if (isImportMapGen) {
  // Import map generation only walks the config object — no DB connection needed.
  d1Binding = undefined
} else if (isCLI) {
  // Other CLI commands (migrate, generate:types, etc.) need a real D1 binding.
  const { getPlatformProxy } = await import('wrangler')
  const proxy = await getPlatformProxy()
  d1Binding = (proxy.env as any).D1
} else {
  // Workers runtime mode (Vite dev or deployed Workers).
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
    // Disable automatic dev schema push — drizzle-kit/api cannot run inside
    // miniflare's Workers sandbox. Migrations are applied via onInit below.
    push: false,
    prodMigrations: migrations as any,
  }),
  // Always run pending migrations on startup (idempotent — skips already-applied ones).
  // connect.js only auto-runs prodMigrations when NODE_ENV=production; onInit covers dev too.
  onInit: async (payload) => {
    await (payload.db as any).migrate({ migrations })
  },
})
