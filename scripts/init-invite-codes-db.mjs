#!/usr/bin/env node
/**
 * Idempotent initialization script for the InviteCode table on the 'app' tenant database.
 * Ensures the "InviteCode" table, unique indexes, and initial seed codes exist.
 * Also ensures the multi-use "InviteCodeClaim" table exists and backfills legacy single-claim
 * data into it. Safe to re-run at any time (e.g. after deploy, to catch claims written by the
 * previous version during rollout).
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const INITIAL_SEED_INVITE_CODES = [
  { code: 'VEC-A7K9-M2P4', note: 'Initial invite code #1' },
  { code: 'VEC-B3N8-Q5R7', note: 'Initial invite code #2' },
  { code: 'VEC-C6T4-W9X2', note: 'Initial invite code #3' },
  { code: 'VEC-D8Y5-J3L6', note: 'Initial invite code #4' },
  { code: 'VEC-E2H7-K4V9', note: 'Initial invite code #5' },
  { code: 'VEC-F9P3-Z6M8', note: 'Initial invite code #6' },
  { code: 'VEC-G4R6-N8Q3', note: 'Initial invite code #7' },
  { code: 'VEC-H5W2-T7Y4', note: 'Initial invite code #8' },
  { code: 'VEC-J7L9-X3C5', note: 'Initial invite code #9' },
  { code: 'VEC-K8V4-M6P2', note: 'Initial invite code #10' },
];

async function main() {
  const connectionString = process.env.APP_DIRECT_DATABASE_URL;

  if (!connectionString) {
    console.error(
      'ERROR: Set APP_DIRECT_DATABASE_URL before running db:init.',
    );
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log('[init-invite-codes-db] Connected to app tenant PostgreSQL. Ensuring InviteCode table...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS "InviteCode" (
        "id" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "note" TEXT,
        "claimedByUserId" TEXT,
        "claimedByEmail" TEXT,
        "claimedAt" TIMESTAMP(3),
        "createdByEmail" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "InviteCode_code_key" ON "InviteCode"("code");
      CREATE UNIQUE INDEX IF NOT EXISTS "InviteCode_claimedByUserId_key" ON "InviteCode"("claimedByUserId");
      CREATE INDEX IF NOT EXISTS "InviteCode_claimedByUserId_idx" ON "InviteCode"("claimedByUserId");
    `);

    await client.query(`
      -- Existing rows are filled with 1 so codes already handed out stay single-use.
      ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "maxClaims" INTEGER DEFAULT 1;

      CREATE TABLE IF NOT EXISTS "InviteCodeClaim" (
        "id" TEXT NOT NULL,
        "inviteCodeId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "email" TEXT,
        "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "InviteCodeClaim_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "InviteCodeClaim_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId")
          REFERENCES "InviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "InviteCodeClaim_userId_key" ON "InviteCodeClaim"("userId");
      CREATE INDEX IF NOT EXISTS "InviteCodeClaim_inviteCodeId_idx" ON "InviteCodeClaim"("inviteCodeId");
      CREATE INDEX IF NOT EXISTS "InviteCodeClaim_email_idx" ON "InviteCodeClaim"("email");
    `);

    // Backfill claims recorded with the legacy single-claim columns.
    const backfill = await client.query(`
      INSERT INTO "InviteCodeClaim" ("id", "inviteCodeId", "userId", "email", "claimedAt")
      SELECT gen_random_uuid()::text, "id", "claimedByUserId", "claimedByEmail", COALESCE("claimedAt", "updatedAt")
      FROM "InviteCode"
      WHERE "claimedByUserId" IS NOT NULL
      ON CONFLICT ("userId") DO NOTHING;
    `);
    if (backfill.rowCount) {
      console.log(`[init-invite-codes-db] Backfilled ${backfill.rowCount} legacy claim(s) into InviteCodeClaim.`);
    }

    for (const item of INITIAL_SEED_INVITE_CODES) {
      await client.query(
        `
        INSERT INTO "InviteCode" ("id", "code", "note", "createdByEmail", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT ("code") DO NOTHING;
        `,
        [crypto.randomUUID(), item.code, item.note, 'harvinder@runvectorial.com'],
      );
    }

    await client.query('COMMIT');
    console.log('[init-invite-codes-db] Successfully verified InviteCode table and initial seed codes.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[init-invite-codes-db] Failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
