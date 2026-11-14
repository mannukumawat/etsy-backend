import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

function buildDatasourceUrl() {
  const url = new URL(env.DATABASE_URL);
  url.searchParams.set('connection_limit', '2');
  url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  datasources: { db: { url: buildDatasourceUrl() } },
});

export async function assertDatabaseReachable(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

// Ensure connections are released when tsx hot-reloads
process.on('beforeExit', () => void prisma.$disconnect());
