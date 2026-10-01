import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import path from 'path';
import { buildConfig } from 'payload';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

import { Users } from '@/cms/collections/Users';
import { Posts } from '@/cms/collections/Posts';
import { Media } from '@/cms/collections/Media';
import { Categories } from '@/cms/collections/Categories';

// Merged app (DR-017): Payload lives inside frontend/web, whose own root is now the
// server root. `Media.staticDir` is resolved against that root, so uploads land
// in `frontend/web/media/` — the same relationship the blog had with its own
// `media/` directory, and the file that already existed there was moved across
// so no upload URL changes.

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  // Merged app (DR-017): the dashboard owns `/admin` (the tier-gated control
  // panel) and `/api/*`, so Payload's admin and REST API are relocated under the
  // blog's prefix. Payload requires both values to be ROOT-RELATIVE and to start
  // with `/`, which is why this is a route move rather than a mount at an
  // arbitrary depth.
  routes: {
    admin: '/blog/cms/admin',
    api: '/blog/cms/api',
  },
  collections: [Users, Posts, Media, Categories],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || '',
    },
  }),
  sharp,
  // The blog no longer has its own origin (DR-017): it is served by the same
  // app as the dashboard, so Payload's own CORS/CSRF allowlists list the
  // dashboard's origins and nothing else.
  cors: ['https://fc.dwirijal.my.id', 'http://localhost:3000', 'http://localhost:3100'],
  csrf: ['https://fc.dwirijal.my.id', 'http://localhost:3000', 'http://localhost:3100'],
});