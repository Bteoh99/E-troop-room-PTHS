/** One backup now (same as the automatic daily one): npm run backup */
import '../src/loadEnv.js';
import { openDb } from '../src/db/index.js';
import { backupSettings, runBackup } from '../src/services/backup.js';

const settings = backupSettings();
const db = openDb();
const r = await runBackup(db, { dir: settings.dir, keep: settings.keep });
db.close();
if (r.ok) {
  console.log(`Backup saved: ${r.file}`);
  if (r.deleted.length) console.log(`Removed old backups: ${r.deleted.join(', ')}`);
} else {
  console.error(`Backup FAILED: ${r.error}`);
}
process.exit(r.ok ? 0 : 1);
