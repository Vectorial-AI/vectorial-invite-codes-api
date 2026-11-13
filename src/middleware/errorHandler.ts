import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    const firstMessage = err.issues[0]?.message || 'Invalid request payload';
    res.status(400).json({
      success: false,
      error: firstMessage,
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  console.error('[vectorial-invite-codes-api] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}
