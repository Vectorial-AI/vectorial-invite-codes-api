import { Router } from 'express';
import { getPrismaClient } from '../db/prisma.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const startedAt = Date.now();
  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      success: true,
      service: 'vectorial-invite-codes-api',
      status: 'ok',
      dbLatencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      service: 'vectorial-invite-codes-api',
      status: 'degraded',
      error: err instanceof Error ? err.message : 'Database connection check failed',
      timestamp: new Date().toISOString(),
    });
  }
});
