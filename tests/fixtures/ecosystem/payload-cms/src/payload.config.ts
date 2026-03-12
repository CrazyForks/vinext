import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Users } from './collections/Users'
import { Posts } from './collections/Posts'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// The D1 binding lives on the cloudflare:workers `env` object. We can't import
// it at the top level because payload.config.ts may be evaluated before the
// miniflare D1 binding is fully wired up. Instead, we use a Proxy that lazily
// resolves the real D1 binding on first property access (which happens inside
// connect() during payload.init(), well within a Workers request context).
//
// The Proxy stores the resolved binding so resolution only happens once.
let _resolvedBinding: any = null
const d1BindingProxy = new Proxy(
  {},
  {
    get(_target, prop, receiver) {
      if (!_resolvedBinding) {
        // cloudflare:workers is intercepted by @cloudflare/vite-plugin's module
        // runner and returns the stable worker env. In production this is a real
        // Workers binding. The `env` export is synchronously available here.
        // We use a dynamic import promise chain but since connect() is async we
        // can just resolve synchronously using the module cache via import().
        // Actually: in the Workers module runner, `import()` of built-in virtual
        // modules is synchronous (already in cache). This works in practice.
        throw new Error(
          '[payload-cms fixture] D1 binding accessed before cloudflare:workers env was ready. ' +
          'This should not happen — connect() is called after Workers env is available.'
        )
      }
      return Reflect.get(_resolvedBinding, prop, receiver)
    },
  },
)

// Initialize the D1 binding lazily when connect() is first called.
// We monkey-patch the adapter after creation to intercept connect().
// But since we can't easily do that, we instead pass an async binding getter
// via a small shim object that connect.js can unwrap.
//
// Actually, the cleanest approach: pass a Promise that resolves to the binding.
// But drizzle(binding) is synchronous...
//
// Final approach: use top-level await to resolve cloudflare:workers once at
// module evaluation time. The module runner has env available immediately.
const { env } = await import('cloudflare:workers')
const d1Binding = (env as any).D1

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
  db: sqliteD1Adapter({ binding: d1Binding }),
})
