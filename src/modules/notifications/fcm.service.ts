/**
 * Firebase Admin SDK wrapper for push notifications.
 * Initialised lazily on first use — no crash if FIREBASE_* vars are unset.
 * Invalid / stale tokens are cleaned up from DB automatically.
 */
import { env, isFirebaseConfigured } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';

type FirebaseMessaging = import('firebase-admin/messaging').Messaging;

let _messaging: FirebaseMessaging | null = null;
let _initAttempted = false;

async function initMessaging(): Promise<FirebaseMessaging | null> {
  if (_initAttempted) return _messaging;
  _initAttempted = true;
  if (!isFirebaseConfigured) return null;
  try {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const app = initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID!,
        clientEmail: env.FIREBASE_CLIENT_EMAIL!,
        // Env files often store newlines as the two-char sequence \n.
        privateKey: env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }),
    });
    _messaging = getMessaging(app);
    return _messaging;
  } catch (err) {
    console.error('[fcm] init failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Returns the Firebase Messaging instance, or null if unconfigured / init failed. */
export async function getMessagingInstance(): Promise<FirebaseMessaging | null> {
  if (_messaging) return _messaging;
  return initMessaging();
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * Send to a single FCM token.
 * Returns true on success, false on failure. Removes invalid tokens from DB.
 */
export async function sendToToken(
  token: string,
  title: string,
  body: string,
  link?: string | null,
): Promise<boolean> {
  const messaging = await getMessagingInstance();
  if (!messaging) return false;
  try {
    await messaging.send({
      token,
      notification: { title, body },
      data: link ? { link } : {},
      webpush: link ? { fcmOptions: { link } } : undefined,
    });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? '';
    if (INVALID_TOKEN_CODES.has(code)) {
      await prisma.fcmToken.deleteMany({ where: { token } }).catch(() => { /* best-effort */ });
    }
    console.error('[fcm] send error:', code, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Send to multiple tokens for one recipient.
 * Returns { sent, failed } counts.
 */
export async function sendToTokens(
  tokens: string[],
  title: string,
  body: string,
  link?: string | null,
): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };
  const results = await Promise.allSettled(
    tokens.map((t) => sendToToken(t, title, body, link)),
  );
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) sent++;
    else failed++;
  }
  return { sent, failed };
}
