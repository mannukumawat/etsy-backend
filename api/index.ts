import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';

let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
let loadError: unknown = null;

try {
  const { createApp } = await import('../src/app.js');
  handler = createApp();
} catch (e) {
  loadError = e;
}

export default function (req: IncomingMessage, res: ServerResponse) {
  if (loadError || !handler) {
    // Never leak the load failure's message or stack to the client (H9): the full error
    // goes to the server log with the same 8-char reference the error handler uses, so
    // an operator can find it without the client ever seeing internals.
    const reference = randomUUID().slice(0, 8);
    console.error(`[${reference}] App failed to load:`, loadError);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App failed to load', reference }));
    return;
  }
  handler(req, res);
}
