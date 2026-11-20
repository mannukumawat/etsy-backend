import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

function buildDatasourceUrl() {
  const url = new URL(env.DATABASE_URL);
  // A Vercel deployment can create many function instances. Each instance having a pool of two or
  // more connections quickly exhausts small hosted-MySQL plans (Prisma P2037). One connection is
  // sufficient because Prisma serialises work inside each interactive transaction.
  url.searchParams.set('connection_limit', String(env.DATABASE_CONNECTION_LIMIT));
  url.searchParams.set('pool_timeout', String(env.DATABASE_POOL_TIMEOUT_SECONDS));
  return url.toString();
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  datasources: { db: { url: buildDatasourceUrl() } },
});

// Reuse the client when a warm serverless instance evaluates the application again or during local
// hot reload. This prevents multiple pools being created inside the same process.
globalForPrisma.prisma = prisma;

export async function assertDatabaseReachable(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

// Ensure connections are released when tsx hot-reloads
if (!env.isProd) process.on('beforeExit', () => void prisma.$disconnect());
