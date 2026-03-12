import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import path from "path";
import { buildConfig } from "payload";
import { fileURLToPath } from "url";

import { Posts } from "./src/collections/Posts.js";
import { Users } from "./src/collections/Users.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Posts],
  editor: lexicalEditor(),
  secret: "payload-test-secret-32-characters!!",
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
  db: sqliteAdapter({
    client: {
      // Use an in-memory SQLite database so tests leave no files on disk
      // and the git working tree stays clean.
      url: ":memory:",
    },
    // push: true lets Payload auto-create/update the schema on startup.
    // Required for in-memory DBs since there are no migration files to run.
    push: true,
  }),
  telemetry: false,
});
