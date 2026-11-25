import { createApp } from './app.js';
import { openDb } from './db/index.js';

const db = openDb();
const app = createApp(db);

const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || undefined;

const server = app.listen(port, host, () => {
  console.log(`e-Troop Store Room API listening on http://localhost:${port}/api`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
