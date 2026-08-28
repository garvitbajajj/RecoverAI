/**
 * MINIMAL .env LOADER
 * -------------------
 * Twelve lines instead of a dependency. `dotenv` would be the reflex here, but
 * the repo's zero-install promise is worth more than the convenience: a
 * reviewer clones and runs, with no npm install step that can fail.
 *
 * Reads KEY=value pairs. Ignores blank lines and #-comments. Never overwrites
 * a variable already set in the real environment, so CI and shell exports win.
 */

const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '../../.env')) {
  if (!fs.existsSync(file)) return {};

  const loaded = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!key) continue;
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}

module.exports = { loadEnv };
