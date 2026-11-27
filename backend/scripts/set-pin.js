/**
 * Set or change the leader PIN (6-8 digits).
 *   npm run set-pin                 asks twice, input hidden
 *   npm run set-pin -- --pin 123456   non-interactive (for install scripts)
 *   npm run set-pin -- --check      exit code 0 if a PIN is set, 1 if not
 *   add --force to repair a damaged config.json (the damaged file is kept as config.json.broken-<time>)
 * Changing the PIN signs out every leader (all tokens stop working).
 * Note: with --pin, npm prints the command line (and the PIN) and your shell may keep it in its
 * history; the hidden prompt is safer.
 */
import '../src/loadEnv.js';
import { isValidPin, PIN_RULE, pinTooShort, readConfig, resolveConfigPath, setPin, SCRYPT_DEFAULTS, storedPinDigits } from '../src/auth/config.js';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(name.length + 1) : args[i + 1];
};

/** Read one line from the terminal without echoing it (shows * per digit). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      fn();
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled.'))); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          stdout.write('*');
        }
      }
    }
    stdin.on('data', onData);
  });
}

async function main() {
  const file = resolveConfigPath();
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run set-pin [-- --pin 123456 | --check] [--force]');
    console.log('  (no options)  ask for the PIN twice, digits hidden (recommended)');
    console.log('  --pin 123456  non-interactive; WARNING: npm prints this command line, so the PIN shows on screen and in shell history');
    console.log('  --check       exit code 0 if a PIN is set, 1 if not');
    console.log('  --force       repair a damaged settings file (it is kept as config.json.broken-<time>)');
    return 0;
  }
  if (args.includes('--check')) {
    let set = false;
    let cfg;
    try {
      cfg = readConfig(file);
      set = Boolean(cfg.pin && cfg.tokenSecret);
    } catch (err) {
      console.log(`Leader PIN: settings file is damaged (${err.message}). Repair: npm run set-pin -- --force`);
      return 2;
    }
    console.log(set ? 'Leader PIN: set' : 'Leader PIN: not set');
    if (set && pinTooShort(cfg)) {
      console.log(`Warning: the leader PIN has only ${storedPinDigits(cfg)} digits. New PINs need ${PIN_RULE}; change it with set-pin.`);
    }
    return set ? 0 : 1;
  }

  let pin = argValue('--pin');
  if (pin === undefined) {
    if (!process.stdin.isTTY) {
      console.error('No terminal to type into. Use: npm run set-pin -- --pin 123456');
      return 1;
    }
    console.log(`Choose the leader PIN: ${PIN_RULE} (numbers only).`);
    console.log('Leaders type it on their phones to add, edit or import items.');
    for (;;) {
      const first = (await askHidden('New leader PIN: ')).trim();
      if (!isValidPin(first)) {
        console.log(`The PIN must be ${PIN_RULE} (numbers only). Try again.`);
        continue;
      }
      const second = (await askHidden('Type it again:  ')).trim();
      if (first !== second) {
        console.log('The two PINs are different. Try again.');
        continue;
      }
      pin = first;
      break;
    }
  }
  pin = String(pin).trim();
  if (!isValidPin(pin)) {
    console.error(`The PIN must be ${PIN_RULE} (numbers only).`);
    return 1;
  }
  try {
    setPin(file, pin, SCRYPT_DEFAULTS, { force: args.includes('--force') });
  } catch (err) {
    if (err.code === 'CONFIG_DAMAGED') {
      console.error(`${err.message}\nRun it again with --force to replace it (the damaged file is kept): npm run set-pin -- --force`);
      return 1;
    }
    throw err;
  }
  console.log(`Leader PIN saved (${file}). Leaders must unlock leader mode again on their phones.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
