import { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';

const globalForPrisma = globalThis as unknown as {
  __inviteCodesPrisma?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.__inviteCodesPrisma) {
    const env = getEnv();
    globalForPrisma.__inviteCodesPrisma = new PrismaClient({
      datasources: {
        db: { url: env.resolvedDatabaseUrl },
      },
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return globalForPrisma.__inviteCodesPrisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (globalForPrisma.__inviteCodesPrisma) {
    await globalForPrisma.__inviteCodesPrisma.$disconnect();
    globalForPrisma.__inviteCodesPrisma = undefined;
  }
}
