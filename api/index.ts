import { createApp } from '../src/app.js';

/**
 * Vercel Serverless Function entrypoint.
 * `vercel.json` rewrites all routes (`/(.*)`) to `/api/index`.
 */
const app = createApp();

export default app;
