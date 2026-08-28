import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app } from './app';

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`ARO API listening on http://localhost:${port}`);
});
