// Writes the DATABASE_URL line in backend/.env.
//
// Prompts for the password with the terminal echo turned off, percent-encodes it, and rewrites ONLY
// that line. The password is never echoed, never passed as an argument and never reaches your shell
// history. Works in cmd.exe, PowerShell and Git Bash — no execution-policy issues.
//
//   npm run db:password

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (!existsSync(envPath)) {
  console.error(`\nNo .env found at ${envPath}`);
  console.error('Create it first:  copy .env.example .env\n');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question, fallback) =>
  new Promise((resolve) => rl.question(`${question} [${fallback}]: `, (answer) => resolve(answer.trim() || fallback)));

/** Same as ask(), but nothing is echoed as you type. */
function askHidden(question) {
  return new Promise((resolve) => {
    const onData = (char) => {
      // Re-print the prompt without the typed characters.
      if (![`\n`, `\r`, `\u0004`].includes(char.toString())) {
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const engine = await ask('Database (mysql / postgres)', 'mysql');
const isMysql = engine.toLowerCase().startsWith('my');
const defaultUser = isMysql ? 'root' : 'yourstore';
const defaultPort = isMysql ? '3306' : '5432';

const user = await ask('Database user', defaultUser);
const host = await ask('Host', 'localhost');
const port = await ask('Port', defaultPort);
const database = await ask('Database', 'yourstore_dev');
const password = await askHidden(`Password for '${user}' (leave blank if there isn't one): `);
rl.close();

// encodeURIComponent escapes every character unsafe in a URL, so @ : / ? # [ ] % & and spaces
// are all handled without you having to think about it. A blank password (e.g. XAMPP's default
// root account) is valid and simply omits the ":password" segment.
const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
const url = isMysql ? `mysql://${auth}@${host}:${port}/${database}` : `postgresql://${auth}@${host}:${port}/${database}?schema=public`;

const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
let replaced = false;
const next = lines.map((line) => {
  if (/^\s*DATABASE_URL\s*=/.test(line)) {
    replaced = true;
    return `DATABASE_URL="${url}"`;
  }
  return line;
});
if (!replaced) next.push(`DATABASE_URL="${url}"`);

writeFileSync(envPath, next.join('\n'), 'utf8');

console.log(`\nUpdated DATABASE_URL in ${envPath}`);
console.log(`  user     ${user}`);
console.log(`  host     ${host}:${port}`);
console.log(`  database ${database}`);
console.log(`  password ${password ? '(hidden, percent-encoded automatically)' : '(none)'}`);
console.log('\nNext:  npm run setup\n');
