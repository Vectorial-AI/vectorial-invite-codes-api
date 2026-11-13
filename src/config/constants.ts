import crypto from 'node:crypto';

export const INVITE_CODE_DEFAULT_ADMIN_EMAIL = 'harvinder@runvectorial.com';
export const INVITE_CODE_DEFAULT_TENANT = 'app';

export const INITIAL_SEED_INVITE_CODES: ReadonlyArray<{ code: string; note: string }> = [
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

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function generateRandomInviteCode(): string {
  const randomSegment = (length: number): string => {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  };
  return `VEC-${randomSegment(4)}-${randomSegment(4)}`;
}
