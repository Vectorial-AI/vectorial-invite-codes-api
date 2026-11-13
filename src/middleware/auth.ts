import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getEnv, isInviteCodeAdmin } from '../config/env.js';
import { INVITE_CODE_DEFAULT_TENANT } from '../config/constants.js';

export interface AuthenticatedActor {
  mode: 'admin_key' | 'internal_key' | 'bearer_or_cookie';
  userId?: string;
  email?: string;
  enterpriseName?: string;
  tenantSubdomain: string;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: AuthenticatedActor;
    }
  }
}

function timingSafeMatch(candidate: string | undefined, secret: string | undefined): boolean {
  if (!candidate || !secret) return false;
  const bufA = Buffer.from(candidate, 'utf8');
  const bufB = Buffer.from(secret, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Extracts auth token from:
 * 1. `Authorization: Bearer <token>` (Chrome extension, Figma plugin, mobile/CLI clients)
 * 2. `X-Auth-Token` header
 * 3. `auth-token` cookie (Next.js web frontend with `credentials: 'include'`)
 */
export function extractAuthTokenFromRequest(req: Request): string | null {
  const authHeader = req.header('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const xAuthToken = req.header('x-auth-token')?.trim();
  if (xAuthToken) return xAuthToken;

  const cookieHeader = req.header('cookie') || '';
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const part of cookies) {
      const [rawKey, ...rest] = part.trim().split('=');
      if (rawKey === 'auth-token') {
        const rawValue = rest.join('=').trim();
        if (rawValue) {
          try {
            return decodeURIComponent(rawValue);
          } catch {
            return rawValue;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the tenant subdomain from explicit headers/query or defaults to 'app'
 * (so standalone clients like Chrome extensions and Figma plugins work out of the box).
 */
export function resolveTenantSubdomain(req: Request): string {
  const explicitHeader =
    req.header('x-tenant-subdomain')?.trim() ||
    req.header('x-tenant-id')?.trim() ||
    (typeof req.query.tenant === 'string' ? req.query.tenant.trim() : '');

  if (explicitHeader) {
    return explicitHeader.toLowerCase();
  }

  return INVITE_CODE_DEFAULT_TENANT;
}

interface VectorialAuthUser {
  userId: string;
  email: string;
  enterpriseName: string;
}

async function verifyVectorialToken(
  token: string,
  tenantHint: string,
): Promise<VectorialAuthUser | null> {
  const env = getEnv();
  const isBeta = tenantHint === 'beta';
  const authBaseUrl = isBeta ? env.VECTORIAL_AUTH_API_BETA : env.VECTORIAL_AUTH_API_PROD;

  try {
    const response = await fetch(`${authBaseUrl}/api/auth/authorize`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) return null;

    const raw = (await response.json()) as Record<string, unknown>;
    const userId = String(raw.userId || raw.user_id || '').trim();
    const email = String(raw.email || '').trim();
    const enterpriseName = String(
      raw.enterpriseName ||
        raw.enterprise_name ||
        raw.enterprise ||
        raw.organization ||
        raw.organizationName ||
        raw.tenant ||
        raw.tenantName ||
        tenantHint ||
        INVITE_CODE_DEFAULT_TENANT,
    )
      .trim()
      .toLowerCase();

    if (!userId) return null;
    return { userId, email, enterpriseName };
  } catch {
    return null;
  }
}

export async function authenticateRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const env = getEnv();
  const tenantSubdomain = resolveTenantSubdomain(req);

  // 1. Admin API key
  const adminKeyHeader = req.header('x-invite-admin-key');
  if (env.INVITE_ADMIN_API_KEY && timingSafeMatch(adminKeyHeader, env.INVITE_ADMIN_API_KEY)) {
    const email = req.header('x-actor-email')?.trim() || 'harvinder@runvectorial.com';
    req.actor = {
      mode: 'admin_key',
      userId: req.header('x-user-id')?.trim() || 'admin-key',
      email,
      enterpriseName: tenantSubdomain,
      tenantSubdomain,
      isAdmin: true,
    };
    next();
    return;
  }

  // 2. Internal service API key
  const internalKeyHeader = req.header('x-invite-internal-key');
  if (
    env.INVITE_INTERNAL_API_KEY &&
    timingSafeMatch(internalKeyHeader, env.INVITE_INTERNAL_API_KEY)
  ) {
    const email =
      req.header('x-user-email')?.trim() || req.header('x-actor-email')?.trim() || undefined;
    req.actor = {
      mode: 'internal_key',
      userId: req.header('x-user-id')?.trim(),
      email,
      enterpriseName: tenantSubdomain,
      tenantSubdomain,
      isAdmin: isInviteCodeAdmin(email),
    };
    next();
    return;
  }

  // 3. Bearer token or auth-token cookie verified against Vectorial Auth API
  const token = extractAuthTokenFromRequest(req);
  if (token) {
    const user = await verifyVectorialToken(token, tenantSubdomain);
    if (user) {
      req.actor = {
        mode: 'bearer_or_cookie',
        userId: user.userId,
        email: user.email,
        enterpriseName: user.enterpriseName,
        tenantSubdomain,
        isAdmin: isInviteCodeAdmin(user.email),
      };
      next();
      return;
    }
  }

  res.status(401).json({
    success: false,
    error: 'Authentication required',
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.actor?.userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }

  if (!req.actor.isAdmin) {
    res.status(403).json({
      success: false,
      error: 'Forbidden: Admin access required',
    });
    return;
  }

  next();
}
