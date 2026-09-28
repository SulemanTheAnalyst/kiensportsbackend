import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { ensureRoles } from './modules/auth/auth.service';

const app = createApp();

const server = app.listen(env.PORT, async () => {
  try {
    await prisma.$connect();
    await ensureRoles();
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'KIEN Sports API started');
  } catch (err) {
    logger.error({ err }, 'Failed to connect to database');
    process.exit(1);
  }
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Force exit if connections hang
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
