/** Nested /api/tenants/:id — Vite on Vercel does not catch-all beyond one segment. */
export {
  GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, runtime, maxDuration,
} from '../[[...route]].js';
