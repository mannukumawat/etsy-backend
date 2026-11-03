import type { IncomingMessage, ServerResponse } from 'http';

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
    const msg = loadError instanceof Error ? loadError.message : String(loadError);
    const stack = loadError instanceof Error ? loadError.stack : '';
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App failed to load', message: msg, stack }));
    return;
  }
  handler(req, res);
}
