import './loadEnv.js'; // must stay first: applies backend/.env before anything reads process.env
import os from 'node:os';
import { createApp } from './app.js';
import { openDb, resolveDbPath } from './db/index.js';
import { backupSettings, scheduleBackups } from './services/backup.js';
import { readConfig, resolveConfigPath } from './auth/config.js';

const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '0.0.0.0'; // reachable from phones on the same Wi-Fi

/** IPv4 addresses phones can use (skips loopback and 169.254.x.x "no network" addresses). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

const db = openDb();
const app = createApp(db);

const server = app.listen(port, host, () => {
  const lines = ['', 'e-Troop Store Room is running.', `  On this laptop:  http://localhost:${port}`];
  for (const ip of lanAddresses()) lines.push(`  Open on phones:  http://${ip}:${port}`);
  if (lanAddresses().length === 0) lines.push('  (No Wi-Fi/network address found - phones cannot connect yet.)');
  lines.push(app.locals.staticDir ? `  Web app:         ${app.locals.staticDir}` : '  Web app:         not served (API only; build the frontend and set NODE_ENV=production)');
  lines.push(`  Database:        ${resolveDbPath()}`);
  let pinSet = false;
  try {
    pinSet = Boolean(readConfig(resolveConfigPath()).pin);
  } catch {
    /* reported by the auth module on first use */
  }
  lines.push(pinSet ? '  Leader PIN:      set' : '  Leader PIN:      NOT SET - run "npm run set-pin" (adding/editing is disabled until then)');
  console.log(lines.join('\n') + '\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is the store room server already running? (Change PORT in backend/.env if needed.)`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

const backups = scheduleBackups(db, backupSettings());

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  backups.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
