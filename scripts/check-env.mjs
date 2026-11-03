// Fails fast with an actionable message when DATABASE_URL is not configured yet, instead of letting
// Prisma report a confusing "authentication failed" for a placeholder password.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

const fail = (title, lines) => {
  console.error(`\n${title}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
};

if (!existsSync(envPath)) {
  fail('backend/.env is missing.', ['copy .env.example .env', 'npm run db:password']);
}

const line = readFileSync(envPath, 'utf8')
  .split(/\r?\n/)
  .find((l) => /^\s*DATABASE_URL\s*=/.test(l));

if (!line) fail('DATABASE_URL is missing from backend/.env.', ['npm run db:password']);

let raw = line.replace(/^\s*DATABASE_URL\s*=\s*/, '').trim();
if (/^(".*"|'.*')$/.test(raw)) raw = raw.slice(1, -1);

// SQLite is a plain file URL: no host, user or password to validate.
if (raw.startsWith('file:')) {
  console.log(`Environment OK — SQLite at ${raw.replace(/^file:/, '')}`);
  process.exit(0);
}

if (/YOUR_PASSWORD/i.test(raw) || /%3CYOUR_PASSWORD%3E/i.test(raw)) {
  fail('DATABASE_URL still contains the placeholder password.', ['Fix it with:', '    npm run db:password', '', 'or edit backend/.env directly.']);
}

let parsed;
try {
  parsed = new URL(raw);
} catch {
  fail('DATABASE_URL is not a valid URL.', [
    'Expected one of:',
    '  mysql://user:password@host:3306/database',
    '  postgresql://user:password@host:5432/database?schema=public',
    '  file:./dev.db',
    'npm run db:password',
  ]);
}

const defaultPort = { 'mysql:': 3306, 'postgresql:': 5432 }[parsed.protocol] ?? '';
// A blank password is a real, supported configuration (e.g. XAMPP's default root@localhost), so it is
// only flagged when it still looks like the unfilled example — never rejected outright.
console.log(`Environment OK — ${parsed.username}${parsed.password ? '' : ' (no password)'}@${parsed.hostname}:${parsed.port || defaultPort}/${parsed.pathname.slice(1)}`);
