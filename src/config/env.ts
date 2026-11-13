import 'dotenv/config';
import { z } from 'zod';
import {
  INVITE_CODE_DEFAULT_ADMIN_EMAIL,
  INVITE_CODE_DEFAULT_TENANT,
} from './constants.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4050),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PRISMA_DATABASE_URL: z.string().optional(),
  APP_DIRECT_DATABASE_URL: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default(
      'http://localhost:3000,https://app.runvectorial.com,https://beta.runvectorial.com,https://www.figma.com',
    ),
  ALLOW_EXTENSION_AND_FIGMA_ORIGINS: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .default('true')
    .transform((val) => val === 'true' || val === '1'),
  INVITE_INTERNAL_API_KEY: z.string().optional(),
  INVITE_ADMIN_API_KEY: z.string().optional(),
  INVITE_CODE_ADMIN_EMAILS: z.string().default(INVITE_CODE_DEFAULT_ADMIN_EMAIL),
  INVITE_CODE_TENANT: z.string().default(INVITE_CODE_DEFAULT_TENANT),
  VECTORIAL_AUTH_API_PROD: z
    .string()
    .url()
    .default('https://prod.us-west-2.auth-api.vectorialapi.com'),
  VECTORIAL_AUTH_API_BETA: z.string().url().default('https://auth-api.vectorialapi.com'),
});

export type AppEnv = z.infer<typeof envSchema> & {
  resolvedDatabaseUrl: string;
};

let cachedEnv: AppEnv | null = null;

/**
 * Resolves the App Tenant database URL:
 * 1. APP_PRISMA_DATABASE_URL (Prisma Accelerate, preferred on Vercel)
 * 2. APP_DIRECT_DATABASE_URL (Direct PostgreSQL connection)
 */
export function resolveAppTenantDatabaseUrl(raw: z.infer<typeof envSchema>): string {
  const candidates = [
    raw.APP_PRISMA_DATABASE_URL,
    raw.APP_DIRECT_DATABASE_URL,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) {
      return candidate.trim();
    }
  }
  throw new Error(
    'Missing required database URL. Set APP_PRISMA_DATABASE_URL or APP_DIRECT_DATABASE_URL.',
  );
}

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }

  const resolvedDatabaseUrl = resolveAppTenantDatabaseUrl(parsed.data);
  process.env.APP_PRISMA_DATABASE_URL =
    process.env.APP_PRISMA_DATABASE_URL || resolvedDatabaseUrl;

  cachedEnv = {
    ...parsed.data,
    resolvedDatabaseUrl,
  };
  return cachedEnv;
}

export function getAdminEmailSet(): Set<string> {
  const rawEmails = process.env.INVITE_CODE_ADMIN_EMAILS || INVITE_CODE_DEFAULT_ADMIN_EMAIL;
  return new Set(
    rawEmails
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isInviteCodeAdmin(email?: string | null): boolean {
  if (!email) return false;
  return getAdminEmailSet().has(email.trim().toLowerCase());
}

export function isAppTenantSubdomain(subdomain?: string | null): boolean {
  const targetTenant = (
    process.env.INVITE_CODE_TENANT || INVITE_CODE_DEFAULT_TENANT
  )
    .trim()
    .toLowerCase();
  if (!subdomain) return false;
  return subdomain.trim().toLowerCase() === targetTenant;
}
