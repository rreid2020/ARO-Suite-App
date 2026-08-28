import { app } from './app';

/**
 * Vercel Node functions treat `export default (req, res)` as the Node API and
 * ignore a returned Fetch Response. Named HTTP methods use the Web handler
 * signature Hono implements via `app.fetch`.
 */
export const GET = app.fetch.bind(app);
export const POST = app.fetch.bind(app);
export const PUT = app.fetch.bind(app);
export const DELETE = app.fetch.bind(app);
export const PATCH = app.fetch.bind(app);
export const OPTIONS = app.fetch.bind(app);
export const HEAD = app.fetch.bind(app);

export const runtime = 'nodejs';
export const maxDuration = 30;
