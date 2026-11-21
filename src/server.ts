import { createApp } from './app.js';
import { assertDatabaseReachable, prisma } from './shared/database/prisma.js';
import { env } from './shared/config/env.js';
import { startRateScheduler } from './modules/settings/exchange-rate.service.js';
import { registerNotificationEventHandler } from './shared/events/notification-events.js';
import { handleNotificationEvent } from './modules/notifications/notification.service.js';
import { startPushWorker } from './modules/notifications/push.worker.js';

async function main() {
  try {
    await assertDatabaseReachable();
  } catch (e) {
    console.error('\nCannot reach MySQL. Check DATABASE_URL in backend/.env and that the server is running.');
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`Your Store API on http://localhost:${env.PORT}`);
    console.log(`  health        GET  /health`);
    console.log(`  public        GET  /api/products, /api/products/:slug, /api/categories`);
    console.log(`  owner         POST /api/admin/auth/login`);
    console.log(`  images        GET  /media/:id`);
    console.log(`  CORS origins  ${env.corsOrigins.join(', ')}`);
  });

  startRateScheduler();

  // Register the notification event handler (must be after DB is confirmed reachable).
  registerNotificationEventHandler(handleNotificationEvent);
  startPushWorker();

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
