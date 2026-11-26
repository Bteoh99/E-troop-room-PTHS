/**
 * Minimal .env loader (no dependency): KEY=VALUE lines, # comments, optional single/double quotes.
 * Variables already set in the real environment win over the file.
 */
import fs from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    }
    out[m[1]] = value;
  }
  return out;
}

/** Load a .env file into process.env if it exists. Returns the keys that were applied. */
export function loadEnvFile(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const applied = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
