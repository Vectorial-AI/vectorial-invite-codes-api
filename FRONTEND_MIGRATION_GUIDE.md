# Frontend Migration Guide: Switching Invite Codes to `vectorial-invite-codes-api`

## Overview

The Invite Codes service has been extracted into a dedicated standalone API (`vectorial-invite-codes-api`) hosted on Vercel and backed by the same `app` tenant PostgreSQL database (`InviteCode` table).

The request/response payloads and route paths are **100% identical** to the existing Next.js route handlers in `vectorial-agent-frontend`, so **no UI components** (`components/layouts/InviteCodeGate.tsx`, `app/admin/invite-codes/page.tsx`) or **Zustand store logic** (`store/inviteCodeStore.ts`) need to change.

---

## 1. Environment Variables (`vectorial-agent-frontend`)

Add the following environment variables to `.env` and your Vercel project settings for `vectorial-agent-frontend`:

```env
# Base URL of the deployed vectorial-invite-codes-api on Vercel (no trailing slash)
INVITE_CODES_API_URL="https://<your-invite-codes-api-domain>.vercel.app"

# Must match INVITE_INTERNAL_API_KEY configured on vectorial-invite-codes-api
INVITE_INTERNAL_API_KEY="<32-byte-hex-secret>"
```

*(Optional — only needed if calling the API directly from client-side code instead of via the Next.js route proxy)*:

```env
NEXT_PUBLIC_INVITE_CODES_API_URL="https://<your-invite-codes-api-domain>.vercel.app"
```

---

## 2. API Endpoints Reference

The standalone service mounts routes under both `/api/...` (drop-in Next.js compatibility) and `/v1/...`:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/invite-codes/status` (or `/v1/invite-codes/status`) | Returns `{ success: true, required: boolean, claimed: boolean, isAdmin: boolean, code: string \| null }` |
| `POST` | `/api/invite-codes/claim` (or `/v1/invite-codes/claim`) | Body: `{ "code": "VEC-XXXX-XXXX" }`. Atomically claims a code for the current user. |
| `GET` | `/api/admin/invite-codes` (or `/v1/admin/invite-codes`) | Admin only. Returns `{ success: true, codes: InviteCodeRecord[], stats: { total, available, claimed } }` |
| `POST` | `/api/admin/invite-codes` (or `/v1/admin/invite-codes`) | Admin only. Body: `{ "count"?: number, "customCode"?: string, "note"?: string }` |
| `PATCH` | `/api/admin/invite-codes/:id` (or `/v1/admin/invite-codes/:id`) | Admin only. Updates an unclaimed code (`{ "code"?: string, "note"?: string \| null }`) |
| `DELETE` | `/api/admin/invite-codes/:id` (or `/v1/admin/invite-codes/:id`) | Admin only. Deletes an invite code by ID (`{ success: true, deletedId: string }`) |

---

## 3. Step-by-Step Migration in `vectorial-agent-frontend`

We recommend **thin-proxying the 4 existing Next.js API route handlers** to `vectorial-invite-codes-api` and removing the direct Prisma calls in `lib/inviteCodePersistence.ts`. This avoids cross-origin cookie issues in the browser and requires zero changes to `store/inviteCodeStore.ts` or `app/admin/invite-codes/page.tsx`.

### Step A: Create `lib/inviteCodesApiProxy.ts`

Create `lib/inviteCodesApiProxy.ts` in `vectorial-agent-frontend`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@utils/authHelpers';
import { getTenantFromRequest } from '@utils/tenantContext';

const INVITE_CODES_API_URL = (process.env.INVITE_CODES_API_URL || '').replace(/\/+$/, '');
const INVITE_INTERNAL_API_KEY = process.env.INVITE_INTERNAL_API_KEY || '';

export async function proxyToInviteCodesApi(
  request: NextRequest,
  upstreamPath: string,
  options?: { method?: string; body?: unknown },
): Promise<NextResponse> {
  if (!INVITE_CODES_API_URL) {
    return NextResponse.json(
      { success: false, error: 'INVITE_CODES_API_URL is not configured' },
      { status: 500 },
    );
  }

  const tenantContext = getTenantFromRequest(request);
  const tenantSubdomain = tenantContext?.tenant.subdomain ?? 'app';
  const user = await getUserFromRequest(request);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Subdomain': tenantSubdomain,
  };

  // Forward internal service key + resolved user identity
  if (INVITE_INTERNAL_API_KEY) {
    headers['X-Invite-Internal-Key'] = INVITE_INTERNAL_API_KEY;
    if (user?.userId) headers['X-User-Id'] = user.userId;
    if (user?.email) headers['X-User-Email'] = user.email;
  }

  // Also forward Authorization header or cookies as fallback
  const authHeader = request.headers.get('authorization');
  if (authHeader) headers['Authorization'] = authHeader;
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const method = options?.method ?? request.method;
  const upstreamResponse = await fetch(`${INVITE_CODES_API_URL}${upstreamPath}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  const data = await upstreamResponse.json().catch(() => ({
    success: false,
    error: 'Invalid response from invite codes service',
  }));

  return NextResponse.json(data, { status: upstreamResponse.status });
}
```

---

### Step B: Update the 4 Next.js API Route Handlers

#### 1. `app/api/invite-codes/status/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { proxyToInviteCodesApi } from '@lib/inviteCodesApiProxy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return proxyToInviteCodesApi(request, '/api/invite-codes/status');
}
```

#### 2. `app/api/invite-codes/claim/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { proxyToInviteCodesApi } from '@lib/inviteCodesApiProxy';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return proxyToInviteCodesApi(request, '/api/invite-codes/claim', {
    method: 'POST',
    body,
  });
}
```

#### 3. `app/api/admin/invite-codes/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { proxyToInviteCodesApi } from '@lib/inviteCodesApiProxy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return proxyToInviteCodesApi(request, '/api/admin/invite-codes');
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return proxyToInviteCodesApi(request, '/api/admin/invite-codes', {
    method: 'POST',
    body,
  });
}
```

#### 4. `app/api/admin/invite-codes/[id]/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { proxyToInviteCodesApi } from '@lib/inviteCodesApiProxy';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  return proxyToInviteCodesApi(request, `/api/admin/invite-codes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return proxyToInviteCodesApi(request, `/api/admin/invite-codes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
```

---

### Step C: Clean Up Old Prisma Persistence Code in `vectorial-agent-frontend`

1. **`lib/inviteCodePersistence.ts`**: Remove all Prisma database functions (`listInviteCodes`, `getUserInviteStatus`, `claimInviteCode`, `createInviteCodes`, `updateUnclaimedInviteCode`, `deleteInviteCode`). Keep only the `InviteCodeRecord` TypeScript interface (used by `app/admin/invite-codes/page.tsx`):
   ```typescript
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
   ```
2. **`scripts/add-invite-code-table-app.ts`**: Can be deleted from `vectorial-agent-frontend` (table initialization and seeding now live in `vectorial-invite-codes-api` via `npm run db:init`).

---

## 4. Direct Client Integration (Chrome Extension & Figma Plugin)

For standalone clients (Chrome Extension, Figma Plugin) that do not route through Next.js, call `vectorial-invite-codes-api` directly using the user's Vectorial `Bearer` token:

```typescript
const INVITE_API_BASE = 'https://<your-invite-codes-api-domain>.vercel.app';

// 1. Check invite code status
const statusRes = await fetch(`${INVITE_API_BASE}/v1/invite-codes/status`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${authToken}`,
    'X-Tenant-Subdomain': 'app', // defaults to 'app' if omitted
  },
});
const status = await statusRes.json();
// -> { success: true, required: true, claimed: false, isAdmin: false, code: null }

// 2. Claim an invite code
const claimRes = await fetch(`${INVITE_API_BASE}/v1/invite-codes/claim`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    'X-Tenant-Subdomain': 'app',
  },
  body: JSON.stringify({ code: 'VEC-A7K9-M2P4' }),
});
const claim = await claimRes.json();
```

CORS is pre-configured on `vectorial-invite-codes-api` to accept requests from:
- `*.runvectorial.com` and `*.vercel.app`
- `localhost`, `*.localhost` (e.g. `http://app.localhost:3000`, `http://beta.localhost:3000`), and `127.0.0.1` on any port
- `chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*`
- Figma plugin iframes (`origin: "null"` and `https://www.figma.com`)
