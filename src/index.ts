import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { disconnectPrismaClient } from './db/prisma.js';

async function startServer() {
  const env = getEnv();
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(
      `[vectorial-invite-codes-api] Listening on port ${env.PORT} (${env.NODE_ENV})`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[vectorial-invite-codes-api] Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      await disconnectPrismaClient();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[vectorial-invite-codes-api] Fatal startup error:', err);
  process.exit(1);
});
