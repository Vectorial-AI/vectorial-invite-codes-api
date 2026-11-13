import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { generateRandomInviteCode, normalizeInviteCode } from '../config/constants.js';
import { isInviteCodeAdmin } from '../config/env.js';

export interface InviteCodeRecord {
  id: string;
  code: string;
  note: string | null;
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
  claimedByUserId: string | null;
  claimedByEmail: string | null;
  claimedAt: Date | null;
  createdByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_NOTE_LENGTH = 280;
const MAX_CODE_LENGTH = 64;

export function sanitizeNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim().slice(0, MAX_NOTE_LENGTH);
  return trimmed || null;
}

function mapRow(row: InviteCodeRow): InviteCodeRecord {
  return {
    id: row.id,
    code: row.code,
    note: row.note ?? null,
    claimedByUserId: row.claimedByUserId ?? null,
    claimedByEmail: row.claimedByEmail ?? null,
    claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : null,
    createdByEmail: row.createdByEmail ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function findClaimedInviteCodeForUser(
  prisma: PrismaClient,
  userId: string,
  email?: string | null,
): Promise<InviteCodeRecord | null> {
  const normalizedEmail = email?.trim().toLowerCase() || null;

  const rows = normalizedEmail
    ? await prisma.$queryRaw<InviteCodeRow[]>`
        SELECT
          "id",
          "code",
          "note",
          "claimedByUserId",
          "claimedByEmail",
          "claimedAt",
          "createdByEmail",
          "createdAt",
          "updatedAt"
        FROM "InviteCode"
        WHERE "claimedByUserId" = ${userId}
           OR LOWER(COALESCE("claimedByEmail", '')) = ${normalizedEmail}
        LIMIT 1
      `
    : await prisma.$queryRaw<InviteCodeRow[]>`
        SELECT
          "id",
          "code",
          "note",
          "claimedByUserId",
          "claimedByEmail",
          "claimedAt",
          "createdByEmail",
          "createdAt",
          "updatedAt"
        FROM "InviteCode"
        WHERE "claimedByUserId" = ${userId}
        LIMIT 1
      `;

  const row = rows[0];
  return row ? mapRow(row) : null;
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

  // Check if user already claimed an invite code
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

  // Atomic claim: only succeeds if the code exists and is unclaimed
  const claimedRows = await prisma.$queryRaw<InviteCodeRow[]>`
    UPDATE "InviteCode"
    SET
      "claimedByUserId" = ${input.userId},
      "claimedByEmail" = ${normalizedEmail},
      "claimedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE UPPER("code") = ${normalizedCode}
      AND "claimedByUserId" IS NULL
    RETURNING
      "id",
      "code",
      "note",
      "claimedByUserId",
      "claimedByEmail",
      "claimedAt",
      "createdByEmail",
      "createdAt",
      "updatedAt"
  `;

  if (claimedRows[0]) {
    return {
      ok: true,
      record: mapRow(claimedRows[0]),
    };
  }

  // Inspect why the atomic update did not match
  const lookupRows = await prisma.$queryRaw<InviteCodeRow[]>`
    SELECT
      "id",
      "code",
      "note",
      "claimedByUserId",
      "claimedByEmail",
      "claimedAt",
      "createdByEmail",
      "createdAt",
      "updatedAt"
    FROM "InviteCode"
    WHERE UPPER("code") = ${normalizedCode}
    LIMIT 1
  `;

  const matched = lookupRows[0];
  if (!matched) {
    return {
      ok: false,
      reason: 'invalid_code',
      message: 'Invalid invite code. Please check the code and try again.',
    };
  }

  if (matched.claimedByUserId === input.userId) {
    return {
      ok: true,
      record: mapRow(matched),
      alreadyClaimedBySelf: true,
    };
  }

  return {
    ok: false,
    reason: 'already_claimed',
    message: 'This invite code has already been claimed by another account.',
  };
}

export async function listInviteCodes(prisma: PrismaClient): Promise<InviteCodeRecord[]> {
  const rows = await prisma.$queryRaw<InviteCodeRow[]>`
    SELECT
      "id",
      "code",
      "note",
      "claimedByUserId",
      "claimedByEmail",
      "claimedAt",
      "createdByEmail",
      "createdAt",
      "updatedAt"
    FROM "InviteCode"
    ORDER BY
      CASE WHEN "claimedByUserId" IS NULL THEN 0 ELSE 1 END ASC,
      "createdAt" DESC
  `;
  return rows.map(mapRow);
}

export async function createInviteCodes(
  prisma: PrismaClient,
  input: {
    count?: number;
    customCode?: string | null;
    note?: string | null;
    createdByEmail?: string | null;
  },
): Promise<{ created: InviteCodeRecord[]; error?: string }> {
  const sanitizedNote = sanitizeNote(input.note);
  const createdByEmail = input.createdByEmail?.trim() || null;

  if (input.customCode && input.customCode.trim()) {
    const customNormalized = normalizeInviteCode(input.customCode);
    if (customNormalized.length < 3 || customNormalized.length > MAX_CODE_LENGTH) {
      return {
        created: [],
        error: `Custom code must be between 3 and ${MAX_CODE_LENGTH} characters.`,
      };
    }

    const id = crypto.randomUUID();
    const inserted = await prisma.$queryRaw<InviteCodeRow[]>`
      INSERT INTO "InviteCode" (
        "id",
        "code",
        "note",
        "createdByEmail",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${id},
        ${customNormalized},
        ${sanitizedNote},
        ${createdByEmail},
        NOW(),
        NOW()
      )
      ON CONFLICT ("code") DO NOTHING
      RETURNING
        "id",
        "code",
        "note",
        "claimedByUserId",
        "claimedByEmail",
        "claimedAt",
        "createdByEmail",
        "createdAt",
        "updatedAt"
    `;

    if (!inserted[0]) {
      return {
        created: [],
        error: `Invite code "${customNormalized}" already exists.`,
      };
    }

    return { created: [mapRow(inserted[0])] };
  }

  const targetCount = Math.min(Math.max(Number(input.count) || 1, 1), 50);
  const created: InviteCodeRecord[] = [];
  let attempts = 0;

  while (created.length < targetCount && attempts < targetCount * 4) {
    attempts += 1;
    const candidate = generateRandomInviteCode();
    const id = crypto.randomUUID();
    const inserted = await prisma.$queryRaw<InviteCodeRow[]>`
      INSERT INTO "InviteCode" (
        "id",
        "code",
        "note",
        "createdByEmail",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${id},
        ${candidate},
        ${sanitizedNote},
        ${createdByEmail},
        NOW(),
        NOW()
      )
      ON CONFLICT ("code") DO NOTHING
      RETURNING
        "id",
        "code",
        "note",
        "claimedByUserId",
        "claimedByEmail",
        "claimedAt",
        "createdByEmail",
        "createdAt",
        "updatedAt"
    `;
    if (inserted[0]) {
      created.push(mapRow(inserted[0]));
    }
  }

  return { created };
}

export type UpdateInviteCodeResult =
  | { ok: true; record: InviteCodeRecord }
  | {
      ok: false;
      reason: 'not_found' | 'claimed_locked' | 'invalid_code' | 'duplicate_code';
      message: string;
    };

export async function updateUnclaimedInviteCode(
  prisma: PrismaClient,
  id: string,
  updates: {
    code?: string;
    note?: string | null;
  },
): Promise<UpdateInviteCodeResult> {
  const existingRows = await prisma.$queryRaw<InviteCodeRow[]>`
    SELECT
      "id",
      "code",
      "note",
      "claimedByUserId",
      "claimedByEmail",
      "claimedAt",
      "createdByEmail",
      "createdAt",
      "updatedAt"
    FROM "InviteCode"
    WHERE "id" = ${id}
    LIMIT 1
  `;

  const existing = existingRows[0];
  if (!existing) {
    return {
      ok: false,
      reason: 'not_found',
      message: 'Invite code not found.',
    };
  }

  if (existing.claimedByUserId) {
    return {
      ok: false,
      reason: 'claimed_locked',
      message:
        'Claimed invite codes are locked to an account and cannot be edited (only deleted).',
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

  const nextNote =
    updates.note !== undefined ? sanitizeNote(updates.note) : existing.note;

  if (nextCode !== existing.code) {
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

  const updatedRows = await prisma.$queryRaw<InviteCodeRow[]>`
    UPDATE "InviteCode"
    SET
      "code" = ${nextCode},
      "note" = ${nextNote},
      "updatedAt" = NOW()
    WHERE "id" = ${id}
      AND "claimedByUserId" IS NULL
    RETURNING
      "id",
      "code",
      "note",
      "claimedByUserId",
      "claimedByEmail",
      "claimedAt",
      "createdByEmail",
      "createdAt",
      "updatedAt"
  `;

  if (!updatedRows[0]) {
    return {
      ok: false,
      reason: 'claimed_locked',
      message: 'Invite code was already claimed and cannot be edited.',
    };
  }

  return {
    ok: true,
    record: mapRow(updatedRows[0]),
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
