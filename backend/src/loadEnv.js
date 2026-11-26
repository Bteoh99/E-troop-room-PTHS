// Side-effect module: import FIRST in entry points (server, scripts) so backend/.env applies
// before anything reads process.env.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/env.js';

export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
loadEnvFile(ENV_FILE);
