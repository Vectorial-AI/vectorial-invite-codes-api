# Multi-Use Invite Codes — Frontend Integration Guide

## TL;DR

- A single invite code can now be claimed by **multiple accounts** (up to `maxClaims`, or unlimited).
- Every account that claims a code is tracked and visible to admins.
- **Fully backward compatible.** Every existing request/response field is unchanged; only new fields were added.
  The Chrome extension (live-companion) and the Figma plugin need **no changes**.
- **All existing codes remain single-use** (`maxClaims = 1`) until an admin raises the limit.
- The only work required is on the **admin page** (`app/admin/invite-codes/page.tsx`) if you want to expose the new features.

---

## 1. What did NOT change (extension, plugin, invite gate)

The user-facing endpoints behave exactly as before. Same paths, auth, status codes, `reason` values, and field
meanings:

| Endpoint | Response |
| :--- | :--- |
| `GET /api/invite-codes/status` (or `/v1/...`) | `{ success, required, claimed, isAdmin, code }` (identical) |
| `POST /api/invite-codes/claim` (or `/v1/...`) | `{ success, claimed, code, record, alreadyClaimedBySelf? }` (identical, `record` has extra fields) |

Claim error responses are unchanged:

| Status | `reason` | When |
| :--- | :--- | :--- |
| `400` | `invalid_code` | Empty/unknown code |
| `409` | `already_claimed` | Code has no uses left (for single-use codes the message is the same as before) |

Guarantees for existing clients:

- `record.claimedByUserId`, `record.claimedByEmail`, `record.claimedAt` on the claim response always describe
  **the calling user's own claim**, even on a multi-use code. Code like `record.claimedByUserId === me` keeps working.
- An account can still hold **only one** invite code. Re-claiming returns `200` with `alreadyClaimedBySelf: true`.
- User-facing responses **never** include the other accounts that used a code (`record.claims` is always `[]`).
- Users who claimed codes before this change remain claimed.

---

## 2. New fields on `InviteCodeRecord`

```typescript
export interface InviteCodeClaimRecord {
  userId: string;
  email: string | null;
  claimedAt: string; // ISO timestamp
}

export interface InviteCodeRecord {
  id: string;
  code: string;
  note: string | null;

  // --- New ---
  /** Max accounts that may claim this code. `null` = unlimited. */
  maxClaims: number | null;
  /** Number of accounts that have claimed this code. */
  claimCount: number;
  /** Uses left. `null` when unlimited. */
  remainingClaims: number | null;
  /** Whether the code can still be claimed. */
  isAvailable: boolean;
  /** Every account that claimed this code, oldest first. Only populated on admin endpoints. */
  claims: InviteCodeClaimRecord[];

  // --- Unchanged (legacy) ---
  /** Claim endpoints: the calling user. Admin endpoints: the FIRST account that claimed it. */
  claimedByUserId: string | null;
  claimedByEmail: string | null;
  claimedAt: string | null;

  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}
```

---

## 3. Admin endpoint changes

### `GET /api/admin/invite-codes`

- Each code now includes `claims` (full list of accounts) plus `maxClaims`, `claimCount`, `remainingClaims`, `isAvailable`.
- `stats` gains two fields:

```typescript
stats: {
  total: number;       // all codes
  available: number;   // codes that can still be claimed (isAvailable)
  claimed: number;     // codes claimed by at least one account
  exhausted: number;   // NEW: codes with no uses left
  totalClaims: number; // NEW: total accounts that have claimed any code
}
```

> Note: a multi-use code with uses left counts toward **both** `available` and `claimed`, so
> `available + claimed` can exceed `total`. Don't compute one from the other.

- Ordering: codes that can still be claimed come first, newest first within each group (same as before for single-use codes).

### `POST /api/admin/invite-codes`

New optional `maxClaims` in the body, applied to every code created in that request:

```jsonc
{ "count": 5, "note": "Batch A" }                        // single-use (default, same as before)
{ "customCode": "LAUNCH-WEEK", "maxClaims": 100 }        // up to 100 accounts
{ "customCode": "PARTNER-ACME", "maxClaims": null }      // unlimited
```

`maxClaims` must be a whole number from `1` to `1000000`, or `null` for unlimited. Anything else returns `400`.

### `PATCH /api/admin/invite-codes/:id`

- New optional `maxClaims` (same rules as above). Use it to turn an existing single-use code into a multi-use one:
  `{ "maxClaims": 25 }`.
- **Behavior change:** `note` and `maxClaims` can now be edited on **claimed** codes too (previously claimed codes were fully locked).
- Renaming (`code`) is still blocked once any account has claimed it: `409`, `reason: "claimed_locked"`.
- Setting `maxClaims` below the current `claimCount` is allowed. It simply closes the code to new claims; existing claimers keep access.
- Invalid `maxClaims` returns `400`, `reason: "invalid_max_claims"`.

### `DELETE /api/admin/invite-codes/:id`

Unchanged. **Deleting a code also removes every claim on it**, so all accounts that used it will be asked for a
code again. For multi-use codes, consider setting `maxClaims` to the current `claimCount` to close it instead.

---

## 4. Suggested admin page updates

1. **Create form:** add a "Max uses" input (number, default `1`) with an "Unlimited" toggle (sends `maxClaims: null`).
2. **Codes table:** replace the "Claimed by" column with a usage column, e.g. `3 / 10` or `3 / ∞`
   (`claimCount` / `maxClaims ?? '∞'`), and a status badge from `isAvailable`.
3. **Claim details:** expand a row (or open a drawer) to list `claims[]`: email, user ID, claimed at.
4. **Edit:** allow editing `note` and `maxClaims` on claimed codes; disable editing the code string when `claimCount > 0`.
5. **Delete confirmation:** when `claimCount > 0`, warn that the N accounts will lose access.
6. **Stats header:** add `exhausted` and `totalClaims`.

No changes are needed in `InviteCodeGate.tsx` or `store/inviteCodeStore.ts`.
