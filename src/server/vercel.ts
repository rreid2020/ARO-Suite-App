import { handle } from 'hono/vercel';
import { app } from './app';

const handler = handle(app);

export default handler;
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const config = { runtime: 'nodejs' };
