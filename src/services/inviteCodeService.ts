import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { generateRandomInviteCode, normalizeInviteCode } from '../config/constants.js';
import { isInviteCodeAdmin } from '../config/env.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface InviteCodeClaimRecord {
  userId: string;
  email: string | null;
  claimedAt: string;
}

export interface InviteCodeRecord {
  id: string;
  code: string;
  note: string | null;
  /** Maximum number of accounts that may claim this code. null = unlimited. */
  maxClaims: number | null;
  claimCount: number;
  /** null when the code is unlimited. */
  remainingClaims: number | null;
  isAvailable: boolean;
  /** Every account that claimed this code (oldest first). Empty unless claims were requested. */
  claims: InviteCodeClaimRecord[];
  /** Legacy fields: the first account that claimed this code. */
  claimedByUserId: string | null;
  claimedByEmail: string | null;
  claimedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InviteCodeRow {
  id: string;
  code: string;
  note: string | null;
  maxClaims: number | null;
  claimCount: number;
  firstClaimUserId: string | null;
  firstClaimEmail: string | null;
  firstClaimedAt: Date | null;
  createdByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InviteCodeClaimRow {
  inviteCodeId: string;
  userId: string;
  email: string | null;
  claimedAt: Date;
}

const MAX_NOTE_LENGTH = 280;
const MAX_CODE_LENGTH = 64;
const MAX_CLAIMS_LIMIT = 1_000_000;

export function sanitizeNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim().slice(0, MAX_NOTE_LENGTH);
  return trimmed || null;
}

/**
 * Parses an admin-supplied maxClaims value.
 * Returns `undefined` when not provided, `null` for unlimited, or a positive integer.
 */
export function parseMaxClaims(
  value: unknown,
): { ok: true; value: number | null | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === 'unlimited') return { ok: true, value: null };
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_CLAIMS_LIMIT
  ) {
    return {
      ok: false,
      message: `maxClaims must be a whole number between 1 and ${MAX_CLAIMS_LIMIT}, or null for unlimited.`,
    };
  }
  return { ok: true, value: parsed };
}

function mapRow(row: InviteCodeRow, claims: InviteCodeClaimRow[] = []): InviteCodeRecord {
  const claimCount = Number(row.claimCount) || 0;
  const remainingClaims =
    row.maxClaims === null ? null : Math.max(row.maxClaims - claimCount, 0);
  return {
    id: row.id,
    code: row.code,
    note: row.note ?? null,
    maxClaims: row.maxClaims ?? null,
    claimCount,
    remainingClaims,
    isAvailable: remainingClaims === null || remainingClaims > 0,
    claims: claims.map((claim) => ({
      userId: claim.userId,
      email: claim.email ?? null,
      claimedAt: new Date(claim.claimedAt).toISOString(),
    })),
    claimedByUserId: row.firstClaimUserId ?? null,
    claimedByEmail: row.firstClaimEmail ?? null,
    claimedAt: row.firstClaimedAt ? new Date(row.firstClaimedAt).toISOString() : null,
    createdByEmail: row.createdByEmail ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function loadInviteCodes(
  db: DbClient,
  options: { ids?: string[]; includeClaims?: boolean } = {},
): Promise<InviteCodeRecord[]> {
  if (options.ids && options.ids.length === 0) return [];

  const whereClause = options.ids
    ? Prisma.sql`WHERE c."id" IN (${Prisma.join(options.ids)})`
    : Prisma.empty;

  const rows = await db.$queryRaw<InviteCodeRow[]>`
    SELECT
      c."id",
      c."code",
      c."note",
      c."maxClaims",
      (SELECT COUNT(*)::int FROM "InviteCodeClaim" cc WHERE cc."inviteCodeId" = c."id") AS "claimCount",
      first_claim."userId" AS "firstClaimUserId",
      first_claim."email" AS "firstClaimEmail",
      first_claim."claimedAt" AS "firstClaimedAt",
      c."createdByEmail",
      c."createdAt",
      c."updatedAt"
    FROM "InviteCode" c
    LEFT JOIN LATERAL (
      SELECT cc."userId", cc."email", cc."claimedAt"
      FROM "InviteCodeClaim" cc
      WHERE cc."inviteCodeId" = c."id"
      ORDER BY cc."claimedAt" ASC
      LIMIT 1
    ) first_claim ON TRUE
    ${whereClause}
    ORDER BY c."createdAt" DESC
  `;

  if (!options.includeClaims || rows.length === 0) {
    return rows.map((row) => mapRow(row));
  }

  const claimRows = await db.$queryRaw<InviteCodeClaimRow[]>`
    SELECT "inviteCodeId", "userId", "email", "claimedAt"
    FROM "InviteCodeClaim"
    WHERE "inviteCodeId" IN (${Prisma.join(rows.map((row) => row.id))})
    ORDER BY "claimedAt" ASC
  `;
  const claimsByCode = new Map<string, InviteCodeClaimRow[]>();
  for (const claim of claimRows) {
    const list = claimsByCode.get(claim.inviteCodeId) ?? [];
    list.push(claim);
    claimsByCode.set(claim.inviteCodeId, list);
  }

  return rows.map((row) => mapRow(row, claimsByCode.get(row.id)));
}

async function loadInviteCode(
  db: DbClient,
  id: string,
  includeClaims = false,
): Promise<InviteCodeRecord | null> {
  const [record] = await loadInviteCodes(db, { ids: [id], includeClaims });
  return record ?? null;
}

/**
 * Single-claim clients read `claimedByUserId` / `claimedByEmail` / `claimedAt` as "my claim",
 * so user-facing responses report the caller's own claim in those fields.
 */
function withClaimer(
  record: InviteCodeRecord,
  claim: { userId: string; email: string | null; claimedAt: Date | null },
): InviteCodeRecord {
  return {
    ...record,
    claimedByUserId: claim.userId,
    claimedByEmail: claim.email ?? null,
    claimedAt: claim.claimedAt ? new Date(claim.claimedAt).toISOString() : record.claimedAt,
  };
}

/**
 * Finds the invite code claimed by a user (by user ID or email). Also checks the legacy
 * single-claim columns so users who claimed before the multi-use migration keep access
 * even if the backfill has not run yet.
 */
export async function findClaimedInviteCodeForUser(
  db: DbClient,
  userId: string,
  email?: string | null,
): Promise<InviteCodeRecord | null> {
  const normalizedEmail = email?.trim().toLowerCase() || null;

  const matches = await db.$queryRaw<
    { id: string; userId: string; email: string | null; claimedAt: Date | null }[]
  >`
    SELECT "inviteCodeId" AS "id", "userId", "email", "claimedAt"
    FROM "InviteCodeClaim"
    WHERE "userId" = ${userId}
       OR LOWER("email") = ${normalizedEmail}
    UNION ALL
    SELECT "id", "claimedByUserId" AS "userId", "claimedByEmail" AS "email", "claimedAt"
    FROM "InviteCode"
    WHERE "claimedByUserId" = ${userId}
       OR LOWER("claimedByEmail") = ${normalizedEmail}
    LIMIT 1
  `;

  const match = matches[0];
  if (!match) return null;
  const record = await loadInviteCode(db, match.id);
  return record ? withClaimer(record, match) : null;
}

export async function getUserInviteStatus(
  prisma: PrismaClient,
  userId: string,
  email?: string | null,
): Promise<{
  required: boolean;
  claimed: boolean;
  isAdmin: boolean;
  code: string | null;
}> {
  if (isInviteCodeAdmin(email)) {
    return {
      required: false,
      claimed: true,
      isAdmin: true,
      code: null,
    };
  }

  const existing = await findClaimedInviteCodeForUser(prisma, userId, email);
  return {
    required: true,
    claimed: Boolean(existing),
    isAdmin: false,
    code: existing?.code ?? null,
  };
}

export type ClaimInviteCodeResult =
  | { ok: true; record: InviteCodeRecord; alreadyClaimedBySelf?: boolean }
  | {
      ok: false;
      reason: 'invalid_code' | 'already_claimed' | 'user_already_has_code';
      message: string;
    };

export async function claimInviteCode(
  prisma: PrismaClient,
  input: {
    code: string;
    userId: string;
    email?: string | null;
  },
): Promise<ClaimInviteCodeResult> {
  const normalizedCode = normalizeInviteCode(input.code);
  if (!normalizedCode || normalizedCode.length > MAX_CODE_LENGTH) {
    return {
      ok: false,
      reason: 'invalid_code',
      message: 'Please enter a valid invite code.',
    };
  }

  // Each account can only ever hold one invite code.
  const existingForUser = await findClaimedInviteCodeForUser(
    prisma,
    input.userId,
    input.email,
  );
  if (existingForUser) {
    return {
      ok: true,
      record: existingForUser,
      alreadyClaimedBySelf: true,
    };
  }

  const normalizedEmail = input.email?.trim() || null;

  return prisma.$transaction(async (tx): Promise<ClaimInviteCodeResult> => {
    // Row lock serializes concurrent claims on the same code so maxClaims cannot be exceeded.
    const lockedRows = await tx.$queryRaw<{ id: string; maxClaims: number | null }[]>`
      SELECT "id", "maxClaims"
      FROM "InviteCode"
      WHERE UPPER("code") = ${normalizedCode}
      LIMIT 1
      FOR UPDATE
    `;

    const target = lockedRows[0];
    if (!target) {
      return {
        ok: false,
        reason: 'invalid_code',
        message: 'Invalid invite code. Please check the code and try again.',
      };
    }

    // Count a legacy claim on this code that hasn't been backfilled yet.
    await tx.$executeRaw`
      INSERT INTO "InviteCodeClaim" ("id", "inviteCodeId", "userId", "email", "claimedAt")
      SELECT ${crypto.randomUUID()}, "id", "claimedByUserId", "claimedByEmail", COALESCE("claimedAt", "updatedAt")
      FROM "InviteCode"
      WHERE "id" = ${target.id}
        AND "claimedByUserId" IS NOT NULL
      ON CONFLICT ("userId") DO NOTHING
    `;

    const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count"
      FROM "InviteCodeClaim"
      WHERE "inviteCodeId" = ${target.id}
    `;

    if (target.maxClaims !== null && count >= target.maxClaims) {
      return {
        ok: false,
        reason: 'already_claimed',
        message:
          target.maxClaims === 1
            ? 'This invite code has already been claimed by another account.'
            : 'This invite code has reached its maximum number of uses.',
      };
    }

    const inserted = await tx.$queryRaw<
      { userId: string; email: string | null; claimedAt: Date }[]
    >`
      INSERT INTO "InviteCodeClaim" ("id", "inviteCodeId", "userId", "email", "claimedAt")
      VALUES (${crypto.randomUUID()}, ${target.id}, ${input.userId}, ${normalizedEmail}, NOW())
      ON CONFLICT ("userId") DO NOTHING
      RETURNING "userId", "email", "claimedAt"
    `;

    if (!inserted[0]) {
      // The same user claimed a code concurrently; return whatever they ended up with.
      const concurrent = await findClaimedInviteCodeForUser(tx, input.userId, input.email);
      if (concurrent) {
        return { ok: true, record: concurrent, alreadyClaimedBySelf: true };
      }
      return {
        ok: false,
        reason: 'user_already_has_code',
        message: 'This account has already claimed an invite code.',
      };
    }

    await tx.$executeRaw`
      UPDATE "InviteCode" SET "updatedAt" = NOW() WHERE "id" = ${target.id}
    `;

    const record = await loadInviteCode(tx, target.id);
    return { ok: true, record: withClaimer(record!, inserted[0]) };
  });
}

export async function listInviteCodes(prisma: PrismaClient): Promise<InviteCodeRecord[]> {
  const records = await loadInviteCodes(prisma, { includeClaims: true });
  // Codes that can still be claimed first, newest first within each group.
  return records.sort((a, b) => Number(b.isAvailable) - Number(a.isAvailable));
}

export async function createInviteCodes(
  prisma: PrismaClient,
  input: {
    count?: number;
    customCode?: string | null;
    note?: string | null;
    /** null = unlimited. Defaults to 1 (single-use). */
    maxClaims?: number | null;
    createdByEmail?: string | null;
  },
): Promise<{ created: InviteCodeRecord[]; error?: string }> {
  const sanitizedNote = sanitizeNote(input.note);
  const createdByEmail = input.createdByEmail?.trim() || null;
  const maxClaims = input.maxClaims === undefined ? 1 : input.maxClaims;

  const insertCode = async (code: string): Promise<string | null> => {
    const inserted = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "InviteCode" (
        "id",
        "code",
        "note",
        "maxClaims",
        "createdByEmail",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${crypto.randomUUID()},
        ${code},
        ${sanitizedNote},
        ${maxClaims},
        ${createdByEmail},
        NOW(),
        NOW()
      )
      ON CONFLICT ("code") DO NOTHING
      RETURNING "id"
    `;
    return inserted[0]?.id ?? null;
  };

  if (input.customCode && input.customCode.trim()) {
    const customNormalized = normalizeInviteCode(input.customCode);
    if (customNormalized.length < 3 || customNormalized.length > MAX_CODE_LENGTH) {
      return {
        created: [],
        error: `Custom code must be between 3 and ${MAX_CODE_LENGTH} characters.`,
      };
    }

    const id = await insertCode(customNormalized);
    if (!id) {
      return {
        created: [],
        error: `Invite code "${customNormalized}" already exists.`,
      };
    }

    return { created: await loadInviteCodes(prisma, { ids: [id] }) };
  }

  const targetCount = Math.min(Math.max(Number(input.count) || 1, 1), 50);
  const createdIds: string[] = [];
  let attempts = 0;

  while (createdIds.length < targetCount && attempts < targetCount * 4) {
    attempts += 1;
    const id = await insertCode(generateRandomInviteCode());
    if (id) {
      createdIds.push(id);
    }
  }

  return { created: await loadInviteCodes(prisma, { ids: createdIds }) };
}

export type UpdateInviteCodeResult =
  | { ok: true; record: InviteCodeRecord }
  | {
      ok: false;
      reason: 'not_found' | 'claimed_locked' | 'invalid_code' | 'duplicate_code';
      message: string;
    };

/**
 * Updates an invite code. The note and maxClaims can always be changed; the code string
 * itself is locked once any account has claimed it.
 */
export async function updateInviteCode(
  prisma: PrismaClient,
  id: string,
  updates: {
    code?: string;
    note?: string | null;
    /** null = unlimited. */
    maxClaims?: number | null;
  },
): Promise<UpdateInviteCodeResult> {
  const existing = await loadInviteCode(prisma, id);
  if (!existing) {
    return {
      ok: false,
      reason: 'not_found',
      message: 'Invite code not found.',
    };
  }

  const nextCode =
    updates.code !== undefined ? normalizeInviteCode(updates.code) : existing.code;
  if (!nextCode || nextCode.length < 3 || nextCode.length > MAX_CODE_LENGTH) {
    return {
      ok: false,
      reason: 'invalid_code',
      message: `Invite code must be between 3 and ${MAX_CODE_LENGTH} characters.`,
    };
  }

  const isRenaming = nextCode !== existing.code;
  if (isRenaming && existing.claimCount > 0) {
    return {
      ok: false,
      reason: 'claimed_locked',
      message: 'Claimed invite codes cannot be renamed (the note and max uses can still be edited).',
    };
  }

  if (isRenaming) {
    const duplicateCheck = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "InviteCode"
      WHERE UPPER("code") = ${nextCode}
        AND "id" <> ${id}
      LIMIT 1
    `;
    if (duplicateCheck[0]) {
      return {
        ok: false,
        reason: 'duplicate_code',
        message: `Another invite code with "${nextCode}" already exists.`,
      };
    }
  }

  const nextNote =
    updates.note !== undefined ? sanitizeNote(updates.note) : existing.note;
  const nextMaxClaims =
    updates.maxClaims !== undefined ? updates.maxClaims : existing.maxClaims;

  const updatedRows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "InviteCode"
    SET
      "code" = ${nextCode},
      "note" = ${nextNote},
      "maxClaims" = ${nextMaxClaims},
      "updatedAt" = NOW()
    WHERE "id" = ${id}
      AND (
        "code" = ${nextCode}
        OR (
          "claimedByUserId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "InviteCodeClaim" WHERE "inviteCodeId" = ${id})
        )
      )
    RETURNING "id"
  `;

  if (!updatedRows[0]) {
    return {
      ok: false,
      reason: 'claimed_locked',
      message: 'Invite code was claimed in the meantime and can no longer be renamed.',
    };
  }

  const record = await loadInviteCode(prisma, id, true);
  return {
    ok: true,
    record: record!,
  };
}

export async function deleteInviteCode(
  prisma: PrismaClient,
  id: string,
): Promise<boolean> {
  const deletedRows = await prisma.$queryRaw<{ id: string }[]>`
    DELETE FROM "InviteCode"
    WHERE "id" = ${id}
    RETURNING "id"
  `;
  return Boolean(deletedRows[0]);
}
