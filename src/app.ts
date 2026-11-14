import express from 'express';
import cors from 'cors';
import {
  contentSecurityPolicy,
  crossOriginOpenerPolicy,
  crossOriginResourcePolicy,
  originAgentCluster,
  referrerPolicy,
  strictTransportSecurity,
  xContentTypeOptions,
  xDnsPrefetchControl,
  xDownloadOptions,
  xFrameOptions,
  xPermittedCrossDomainPolicies,
  xPoweredBy,
  xXssProtection,
} from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { getEnv } from './config/env.js';
import { healthRouter } from './routes/health.routes.js';
import { inviteCodesRouter } from './routes/inviteCodes.routes.js';
import { adminInviteCodesRouter } from './routes/adminInviteCodes.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
  allowExtensionAndFigma: boolean,
): boolean {
  // Server-to-server, curl, or same-origin requests without Origin header
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;

  // Allow any *.runvectorial.com, *.vercel.app, or localhost / *.localhost (e.g. http://app.localhost:3000) origin
  try {
    const url = new URL(origin);
    if (
      url.hostname.endsWith('.runvectorial.com') ||
      url.hostname === 'runvectorial.com' ||
      url.hostname.endsWith('.vercel.app') ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      url.hostname === '127.0.0.1'
    ) {
      return true;
    }
  } catch {
    // Non-standard origin string (e.g. "null" from Figma plugin iframe)
  }

  if (allowExtensionAndFigma) {
    // Chrome extensions, Firefox add-ons, Safari extensions, and Figma plugin sandboxed iframes ("null" origin)
    if (
      origin === 'null' ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      origin.startsWith('safari-web-extension://') ||
      origin === 'https://www.figma.com' ||
      origin === 'https://figma.com'
    ) {
      return true;
    }
  }

  return false;
}

export function createApp() {
  const env = getEnv();
  const app = express();

  app.set('trust proxy', 1);

  app.use(contentSecurityPolicy());
  app.use(crossOriginOpenerPolicy());
  app.use(crossOriginResourcePolicy({ policy: 'cross-origin' }));
  app.use(originAgentCluster());
  app.use(referrerPolicy());
  app.use(strictTransportSecurity());
  app.use(xContentTypeOptions());
  app.use(xDnsPrefetchControl());
  app.use(xDownloadOptions());
  app.use(xFrameOptions());
  app.use(xPermittedCrossDomainPolicies());
  app.use(xPoweredBy());
  app.use(xXssProtection());

  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin, allowedOrigins, env.ALLOW_EXTENSION_AND_FIGMA_ORIGINS)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Auth-Token',
        'X-Tenant-Subdomain',
        'X-Tenant-Id',
        'X-Invite-Internal-Key',
        'X-Invite-Admin-Key',
        'X-User-Id',
        'X-User-Email',
        'X-Actor-Email',
      ],
    }),
  );

  app.use(express.json({ limit: '128kb' }));

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: 'Too many requests, please try again shortly.',
    },
  });

  app.use('/api', limiter);
  app.use('/v1', limiter);

  app.use('/health', healthRouter);
  app.use('/api/health', healthRouter);

  // Drop-in Next.js compatible routes (/api/invite-codes/* & /api/admin/invite-codes/*)
  app.use('/api/invite-codes', inviteCodesRouter);
  app.use('/api/admin/invite-codes', adminInviteCodesRouter);

  // Versioned routes for external clients (Chrome Extension, Figma Plugin, etc.)
  app.use('/v1/invite-codes', inviteCodesRouter);
  app.use('/v1/admin/invite-codes', adminInviteCodesRouter);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: 'Endpoint not found',
    });
  });

  app.use(errorHandler);

  return app;
}
