// One-shot local MySQL/MariaDB database setup (e.g. XAMPP).
//
//   npm run db:create
//
// Creates the database named in backend/.env's DATABASE_URL with the utf8mb4 charset (required for
// Hindi text to store correctly), using the credentials already in that file. There is a single
// source of truth for the connection: .env.
//
// XAMPP's default `root` account has no password, so this usually needs no input at all. If your
// MySQL root account does have a password, it must already be in DATABASE_URL.
//
// Re-running is safe and NON-DESTRUCTIVE: the database is created only if missing. An existing
// database, and any other databases on the same server, are left exactly as they are.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');

// --- read the target connection from .env ---------------------------------------------------------

if (!existsSync(envPath)) {
  console.error('\nbackend/.env is missing. Run:  copy .env.example .env\n');
  process.exit(1);
}

const urlLine = readFileSync(envPath, 'utf8')
  .split(/\r?\n/)
  .find((l) => /^\s*DATABASE_URL\s*=/.test(l));

let rawUrl = (urlLine ?? '').replace(/^\s*DATABASE_URL\s*=\s*/, '').trim();
if (/^(".*"|'.*')$/.test(rawUrl)) rawUrl = rawUrl.slice(1, -1);

if (!rawUrl.startsWith('mysql://')) {
  console.error('\nDATABASE_URL in backend/.env is not a MySQL URL.');
  console.error('Set it to mysql://user:password@host:3306/database first.\n');
  process.exit(1);
}

let target;
try {
  target = new URL(rawUrl);
} catch {
  console.error('\nDATABASE_URL in backend/.env is not a valid URL.\n');
  process.exit(1);
}

const USER = decodeURIComponent(target.username || 'root');
const PASSWORD = decodeURIComponent(target.password || '');
const DATABASE = target.pathname.replace(/^\//, '');
const HOST = target.hostname || 'localhost';
const PORT = target.port || '3306';

if (!DATABASE) {
  console.error('\nDATABASE_URL must include a database name.\n');
  process.exit(1);
}

// --- locate mysql client ---------------------------------------------------------------------------

function findMysql() {
  if (process.env.MYSQL_BIN && existsSync(process.env.MYSQL_BIN)) return process.env.MYSQL_BIN;
  const candidates = ['C:\\xampp\\mysql\\bin\\mysql.exe', 'C:\\wamp64\\bin\\mysql\\mysql8.0.31\\bin\\mysql.exe', 'mysql'];
  return candidates.find((c) => c === 'mysql' || existsSync(c));
}

const mysql = findMysql();
if (!mysql) {
  console.error('\nCould not find the mysql client. Set the full path and retry, e.g.:');
  console.error('  set MYSQL_BIN=C:\\xampp\\mysql\\bin\\mysql.exe && npm run db:create\n');
  process.exit(1);
}

// --- create the database (idempotent, never drops) ------------------------------------------------

// utf8mb4 is required: MySQL's older "utf8" is really a 3-byte subset and cannot store every
// Devanagari codepoint. unicode_ci gives sensible sorting for mixed English/Hindi text.
const sql = `CREATE DATABASE IF NOT EXISTS \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;

const dir = mkdtempSync(join(tmpdir(), 'ys-db-'));
const sqlPath = join(dir, 'setup.sql');

console.log(`\nCreating database "${DATABASE}" on ${HOST}:${PORT} (utf8mb4) if it does not already exist.`);
console.log('Existing data is preserved - nothing is dropped.\n');

let status;
try {
  writeFileSync(sqlPath, sql, 'utf8');
  const args = ['-u', USER, '-h', HOST, '-P', PORT, ...(PASSWORD ? [`-p${PASSWORD}`] : []), '-e', `source ${sqlPath}`];
  status = spawnSync(mysql, args, { stdio: 'inherit' }).status;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (status !== 0) {
  console.error('\nmysql did not complete successfully.');
  console.error('If it said "Access denied", the username/password in DATABASE_URL is wrong for this server.');
  console.error('For XAMPP, the default is root with NO password: mysql://root:@localhost:3306/<database>\n');
  process.exit(1);
}

console.log('-'.repeat(62));
console.log('Database ready.');
console.log(`  database  ${DATABASE}`);
console.log(`  host      ${HOST}:${PORT}`);
console.log('  charset   utf8mb4 (required for Hindi text)');
console.log('-'.repeat(62));
console.log('\nNext:  npm run setup\n');
