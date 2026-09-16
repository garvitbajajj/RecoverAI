/**
 * LOCAL DEV SERVER
 * ----------------
 * Serves dashboard.html and routes /api/diagnose to the same handler Vercel
 * runs, so the interactive panel can be exercised end to end without deploying.
 *
 * Exists because the panel's LLM path needs an HTTP origin: opened from the
 * filesystem there is no /api to call, and the panel correctly says so. This
 * gives you the served case locally.
 *
 * node:http only -- no dependency, consistent with the rest of the project.
 *
 *   npm run dev:web      then open http://localhost:3000
 *   PORT=3001 npm run dev:web    to use a different port
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

require('../src/lib/env').loadEnv();

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const DASHBOARD = path.join(ROOT, 'dashboard.html');

/**
 * Vercel's Node functions get res.status().json(). Node's http.ServerResponse
 * does not, so add just enough of that surface for the handler to run
 * unmodified -- the point is to exercise the real file, not a copy.
 */
function adapt(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    res.setHeader('content-type', 'application/json');
    res.end(body);
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/diagnose') {
    const handler = require('../api/diagnose');
    try {
      await handler(req, adapt(res));
    } catch (err) {
      adapt(res).status(500).json({ root_cause: null, reason: 'handler threw: ' + err.message });
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!fs.existsSync(DASHBOARD)) {
      res.statusCode = 404;
      return res.end('dashboard.html not found -- run `npm run report` first.');
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    return res.end(fs.readFileSync(DASHBOARD));
  }

  res.statusCode = 404;
  res.end('not found');
});

/**
 * A busy port is the most likely way to meet this script -- usually an earlier
 * run still holding it. Node's default is an unhandled 'error' event, which
 * dumps a stack trace that buries the one useful fact. Say it plainly instead.
 */
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error('');
  console.error(`  Port ${PORT} is already in use — most likely a dev server still running.`);
  console.error('');
  console.error('  Use another port:');
  console.error(`    $env:PORT=3001; npm run dev:web     (PowerShell)`);
  console.error(`    PORT=3001 npm run dev:web           (bash)`);
  console.error('');
  console.error('  Or find and stop what holds it (PowerShell):');
  console.error(`    Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select OwningProcess`);
  console.error(`    Stop-Process -Id <pid> -Force`);
  console.error('');
  process.exit(1);
});

server.listen(PORT, () => {
  const keyed = process.env.GEMINI_API_KEY ? 'with' : 'WITHOUT';
  console.log(`\n  dev server  http://localhost:${PORT}   (${keyed} GEMINI_API_KEY)\n`);
  if (!fs.existsSync(DASHBOARD)) {
    console.log('  note: dashboard.html does not exist yet — run `npm run report` first.\n');
  }
});
