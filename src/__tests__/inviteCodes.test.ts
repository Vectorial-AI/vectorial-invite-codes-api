import { describe, expect, it } from 'vitest';
import {
  generateRandomInviteCode,
  INITIAL_SEED_INVITE_CODES,
  normalizeInviteCode,
} from '../config/constants.js';
import {
  isAppTenantSubdomain,
  isInviteCodeAdmin,
  resolveAppTenantDatabaseUrl,
} from '../config/env.js';
import { isAllowedOrigin } from '../app.js';
import { sanitizeNote } from '../services/inviteCodeService.js';

describe('vectorial-invite-codes-api', () => {
  it('normalizes and generates VEC-XXXX-XXXX invite codes', () => {
    expect(normalizeInviteCode('  vec-a7k9-m2p4 ')).toBe('VEC-A7K9-M2P4');
    const code = generateRandomInviteCode();
    expect(code).toMatch(/^VEC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(INITIAL_SEED_INVITE_CODES).toHaveLength(10);
  });

  it('recognizes admin emails and app tenant subdomains', () => {
    expect(isInviteCodeAdmin('harvinder@runvectorial.com')).toBe(true);
    expect(isInviteCodeAdmin('HARVINDER@RUNVECTORIAL.COM')).toBe(true);
    expect(isInviteCodeAdmin('user@example.com')).toBe(false);

    expect(isAppTenantSubdomain('app')).toBe(true);
    expect(isAppTenantSubdomain('APP')).toBe(true);
    expect(isAppTenantSubdomain('beta')).toBe(false);
    expect(isAppTenantSubdomain(null)).toBe(false);
  });

  it('resolves app tenant database URL with APP_PRISMA_DATABASE_URL priority over APP_DIRECT_DATABASE_URL', () => {
    const url = resolveAppTenantDatabaseUrl({
      PORT: 4050,
      NODE_ENV: 'test',
      APP_PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.prisma-data.net/?api_key=abc',
      APP_DIRECT_DATABASE_URL: 'postgresql://direct-app-db',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      ALLOW_EXTENSION_AND_FIGMA_ORIGINS: true,
      INVITE_CODE_ADMIN_EMAILS: 'harvinder@runvectorial.com',
      INVITE_CODE_TENANT: 'app',
      VECTORIAL_AUTH_API_PROD: 'https://prod.us-west-2.auth-api.vectorialapi.com',
      VECTORIAL_AUTH_API_BETA: 'https://auth-api.vectorialapi.com',
    });
    expect(url).toBe('prisma+postgres://accelerate.prisma-data.net/?api_key=abc');
  });

  it('allows CORS from Chrome Extensions, Figma Plugin iframes ("null" / figma.com), localhost / *.localhost, and *.runvectorial.com', () => {
    const allowedList = ['http://localhost:3000', 'https://app.runvectorial.com'];
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnop', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('null', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('https://www.figma.com', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('https://app.runvectorial.com', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('http://app.localhost:3000', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('http://beta.localhost:3000', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('http://localhost:3001', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', allowedList, true)).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com', allowedList, true)).toBe(false);
    expect(isAllowedOrigin('https://localhost.evil.example.com', allowedList, true)).toBe(false);
  });

  it('sanitizes and truncates invite code notes', () => {
    expect(sanitizeNote('  VIP Partner  ')).toBe('VIP Partner');
    expect(sanitizeNote('   ')).toBeNull();
    expect(sanitizeNote(null)).toBeNull();
    expect(sanitizeNote('x'.repeat(400))?.length).toBe(280);
  });
});
