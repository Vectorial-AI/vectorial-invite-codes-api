import { Router } from 'express';
import { getPrismaClient } from '../db/prisma.js';
import { isAppTenantSubdomain, isInviteCodeAdmin } from '../config/env.js';
import { authenticateRequest } from '../middleware/auth.js';
import { claimInviteCode, getUserInviteStatus } from '../services/inviteCodeService.js';

export const inviteCodesRouter = Router();

/**
 * GET /api/invite-codes/status (also mounted at /v1/invite-codes/status)
 * Checks whether the user is required to claim an invite code and whether they have claimed one.
 */
inviteCodesRouter.get('/status', authenticateRequest, async (req, res) => {
  try {
    const actor = req.actor;
    const tenantSubdomain = actor?.tenantSubdomain || 'app';

    if (!isAppTenantSubdomain(tenantSubdomain)) {
      res.status(200).json({
        success: true,
        required: false,
        claimed: true,
        isAdmin: false,
        code: null,
      });
      return;
    }

    const targetUserId =
      actor?.mode === 'internal_key' || actor?.mode === 'admin_key'
        ? (typeof req.query.userId === 'string' && req.query.userId.trim()) || actor.userId
        : actor?.userId;
    const targetEmail =
      actor?.mode === 'internal_key' || actor?.mode === 'admin_key'
        ? (typeof req.query.email === 'string' && req.query.email.trim()) || actor.email
        : actor?.email;

    if (!targetUserId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    if (isInviteCodeAdmin(targetEmail)) {
      res.status(200).json({
        success: true,
        required: false,
        claimed: true,
        isAdmin: true,
        code: null,
      });
      return;
    }

    const prisma = getPrismaClient();
    const status = await getUserInviteStatus(prisma, targetUserId, targetEmail);

    res.status(200).json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('[invite-codes/status] GET failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check invite code status',
    });
  }
});

/**
 * POST /api/invite-codes/claim (also mounted at /v1/invite-codes/claim)
 * Atomically claims an invite code for the authenticated user.
 */
inviteCodesRouter.post('/claim', authenticateRequest, async (req, res) => {
  try {
    const actor = req.actor;
    const tenantSubdomain = actor?.tenantSubdomain || 'app';

    if (!isAppTenantSubdomain(tenantSubdomain)) {
      res.status(400).json({
        success: false,
        error: 'Invite codes are only enabled on the app tenant.',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      code?: unknown;
      userId?: unknown;
      email?: unknown;
    };

    const targetUserId =
      actor?.mode === 'internal_key' || actor?.mode === 'admin_key'
        ? (typeof body.userId === 'string' && body.userId.trim()) || actor.userId
        : actor?.userId;
    const targetEmail =
      actor?.mode === 'internal_key' || actor?.mode === 'admin_key'
        ? (typeof body.email === 'string' && body.email.trim()) || actor.email
        : actor?.email;

    if (!targetUserId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    if (isInviteCodeAdmin(targetEmail)) {
      res.status(200).json({
        success: true,
        claimed: true,
        isAdmin: true,
        code: null,
      });
      return;
    }

    const code = typeof body.code === 'string' ? body.code : '';
    const prisma = getPrismaClient();
    const result = await claimInviteCode(prisma, {
      code,
      userId: targetUserId,
      email: targetEmail,
    });

    if (!result.ok) {
      const status = result.reason === 'already_claimed' ? 409 : 400;
      res.status(status).json({
        success: false,
        reason: result.reason,
        error: result.message,
      });
      return;
    }

    res.status(200).json({
      success: true,
      claimed: true,
      code: result.record.code,
      record: result.record,
      ...(result.alreadyClaimedBySelf ? { alreadyClaimedBySelf: true } : {}),
    });
  } catch (error) {
    console.error('[invite-codes/claim] POST failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to claim invite code',
    });
  }
});
