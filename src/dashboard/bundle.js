/**
 * CLIENT-SIDE MODULE BUNDLE
 * -------------------------
 * Reads the four pure-logic modules off disk at build time and wraps them in a
 * minimal CommonJS shim so the browser runs THE EXACT SAME SOURCE as the agent.
 *
 * This is the whole point of doing it this way. Hand-copying the taxonomy into
 * the HTML would work today and quietly rot: someone adds a decline code, the
 * batch report updates, and the interactive panel keeps answering from a stale
 * copy. A reviewer would have no way to tell. Reading from src/ means the panel
 * cannot drift, and test/bundle-parity.test.js proves it hasn't.
 *
 * Only these four qualify: they have no Node built-ins and no dynamic requires,
 * just relative imports of each other. The LLM fallback stays server-side
 * because it needs a key.
 *
 * Exported separately from build.js so the parity test can evaluate the bundle
 * directly instead of scraping it back out of the generated HTML.
 */

const fs = require('fs');
const path = require('path');

/** Module ids, repo-root-relative. Order is irrelevant; the shim resolves lazily. */
const MODULE_IDS = [
  'src/config/taxonomy.js',
  'src/lib/classifier.js',
  'src/lib/executor.js',
  'src/lib/actions.js',
];

const SHIM = `
// --- minimal CommonJS shim: resolves the relative requires between the four ---
var __cache = {};
function __resolve(from, spec) {
  var parts = from.split('/').slice(0, -1);
  spec.split('/').forEach(function (seg) {
    if (!seg || seg === '.') return;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  });
  var p = parts.join('/');
  return __modules[p] ? p : p + '.js';
}
function __require(id) {
  if (__cache[id]) return __cache[id].exports;
  if (!__modules[id]) throw new Error('module not found: ' + id);
  var m = (__cache[id] = { exports: {} });
  __modules[id](m, m.exports, function (spec) { return __require(__resolve(id, spec)); });
  return m.exports;
}
var RecoverAI = {
  classify: __require('src/lib/classifier.js').classify,
  decide: __require('src/lib/executor.js').decide,
  dispatch: __require('src/lib/actions.js').dispatch,
  taxonomy: __require('src/config/taxonomy.js'),
};
globalThis.RecoverAI = RecoverAI;
`;

/**
 * @param {string} [root] repo root; defaults to two levels up from this file
 * @returns {string} self-contained JS defining globalThis.RecoverAI
 */
function buildModuleBundle(root = path.join(__dirname, '../..')) {
  const entries = MODULE_IDS.map((id) => {
    const src = fs
      .readFileSync(path.join(root, id), 'utf8')
      // A literal </script> anywhere in the source would terminate the host
      // <script> element early. None today, but escaping costs nothing.
      .replace(/<\/script>/gi, '<\\/script>');
    return `${JSON.stringify(id)}: function (module, exports, require) {\n${src}\n}`;
  });

  return `var __modules = {\n${entries.join(',\n')}\n};\n${SHIM}`;
}

module.exports = { buildModuleBundle, MODULE_IDS };
