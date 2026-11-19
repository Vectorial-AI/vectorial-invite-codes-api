import { Router } from 'express';
import { getPrismaClient } from '../db/prisma.js';
import { isAppTenantSubdomain } from '../config/env.js';
import { authenticateRequest, requireAdmin } from '../middleware/auth.js';
import {
  createInviteCodes,
  deleteInviteCode,
  listInviteCodes,
  parseMaxClaims,
  updateInviteCode,
} from '../services/inviteCodeService.js';

export const adminInviteCodesRouter = Router();

adminInviteCodesRouter.use(authenticateRequest, requireAdmin);

/**
 * GET /api/admin/invite-codes (also mounted at /v1/admin/invite-codes)
 * Lists all invite codes (with every account that claimed each one) and summary stats.
 * A multi-use code can count towards both `available` and `claimed`.
 */
adminInviteCodesRouter.get('/', async (req, res) => {
  try {
    const tenantSubdomain = req.actor?.tenantSubdomain || 'app';
    if (!isAppTenantSubdomain(tenantSubdomain)) {
      res.status(400).json({
        success: false,
        error: 'Invite code management is only available on the app tenant.',
      });
      return;
    }

    const prisma = getPrismaClient();
    const codes = await listInviteCodes(prisma);
    const total = codes.length;
    const claimed = codes.filter((item) => item.claimCount > 0).length;
    const available = codes.filter((item) => item.isAvailable).length;
    const totalClaims = codes.reduce((sum, item) => sum + item.claimCount, 0);

    res.status(200).json({
      success: true,
      codes,
      stats: {
        total,
        available,
        claimed,
        exhausted: total - available,
        totalClaims,
      },
    });
  } catch (error) {
    console.error('[admin/invite-codes] GET failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load invite codes',
    });
  }
});

/**
 * POST /api/admin/invite-codes (also mounted at /v1/admin/invite-codes)
 * Creates 1..50 random invite codes or a custom code.
 * `maxClaims`: number of accounts that may use each code (default 1), or null for unlimited.
 */
adminInviteCodesRouter.post('/', async (req, res) => {
  try {
    const tenantSubdomain = req.actor?.tenantSubdomain || 'app';
    if (!isAppTenantSubdomain(tenantSubdomain)) {
      res.status(400).json({
        success: false,
        error: 'Invite code management is only available on the app tenant.',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      count?: number;
      customCode?: string;
      note?: string;
      maxClaims?: unknown;
    };

    const maxClaims = parseMaxClaims(body.maxClaims);
    if (!maxClaims.ok) {
      res.status(400).json({
        success: false,
        error: maxClaims.message,
      });
      return;
    }

    const prisma = getPrismaClient();
    const result = await createInviteCodes(prisma, {
      count: body.count,
      customCode: body.customCode,
      note: body.note,
      maxClaims: maxClaims.value,
      createdByEmail: req.actor?.email,
    });

    if (result.error) {
      res.status(400).json({
        success: false,
        error: result.error,
      });
      return;
    }

    res.status(200).json({
      success: true,
      created: result.created,
    });
  } catch (error) {
    console.error('[admin/invite-codes] POST failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate invite codes',
    });
  }
});

/**
 * PATCH /api/admin/invite-codes/:id (also mounted at /v1/admin/invite-codes/:id)
 * Updates an invite code's note or maxClaims (null = unlimited). The code string can only be
 * changed while no account has claimed it.
 */
adminInviteCodesRouter.patch('/:id', async (req, res) => {
  try {
    const tenantSubdomain = req.actor?.tenantSubdomain || 'app';
    if (!isAppTenantSubdomain(tenantSubdomain)) {
      res.status(400).json({
        success: false,
        error: 'Invite code management is only available on the app tenant.',
      });
      return;
    }

    const id = req.params.id?.trim();
    if (!id) {
      res.status(400).json({
        success: false,
        error: 'Invite code ID is required',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      code?: string;
      note?: string | null;
      maxClaims?: unknown;
    };

    const maxClaims = parseMaxClaims(body.maxClaims);
    if (!maxClaims.ok) {
      res.status(400).json({
        success: false,
        reason: 'invalid_max_claims',
        error: maxClaims.message,
      });
      return;
    }

    const prisma = getPrismaClient();
    const result = await updateInviteCode(prisma, id, {
      code: body.code,
      note: body.note,
      maxClaims: maxClaims.value,
    });

    if (!result.ok) {
      const status =
        result.reason === 'not_found'
          ? 404
          : result.reason === 'claimed_locked' || result.reason === 'duplicate_code'
            ? 409
            : 400;
      res.status(status).json({
        success: false,
        reason: result.reason,
        error: result.message,
      });
      return;
    }

    res.status(200).json({
      success: true,
      code: result.record,
    });
  } catch (error) {
    console.error('[admin/invite-codes/:id] PATCH failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update invite code',
    });
  }
});

/**
 * DELETE /api/admin/invite-codes/:id (also mounted at /v1/admin/invite-codes/:id)
 * Deletes an invite code by ID.
 */
adminInviteCodesRouter.delete('/:id', async (req, res) => {
  try {
    const tenantSubdomain = req.actor?.tenantSubdomain || 'app';
    if (!isAppTenantSubdomain(tenantSubdomain)) {
      res.status(400).json({
        success: false,
        error: 'Invite code management is only available on the app tenant.',
      });
      return;
    }

    const id = req.params.id?.trim();
    if (!id) {
      res.status(400).json({
        success: false,
        error: 'Invite code ID is required',
      });
      return;
    }

    const prisma = getPrismaClient();
    const deleted = await deleteInviteCode(prisma, id);
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Invite code not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      deletedId: id,
    });
  } catch (error) {
    console.error('[admin/invite-codes/:id] DELETE failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete invite code',
    });
  }
});
