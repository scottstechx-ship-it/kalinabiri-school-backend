// Smoke test for the Kalinabiri backend on SQLite (local dev).
// Spawns server.js as a child process, waits for it to come up, then
// drives every key route group via fetch. Prints PASS/FAIL per check.
//
// Usage: node smoke_test.js

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'kalinabiri.db');
for (const ext of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(dbPath + ext); } catch (_) {}
}

const PORT = '3921';
const env = {
  ...process.env,
  DATABASE_URL: '',
  JWT_SECRET: 'smoke-test-secret-not-for-prod',
  PORT,
  NODE_ENV: 'test',
  SQLITE_DEBUG: '1',
};

console.log(`→ starting server on port ${PORT}…`);
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
let bootTimeout = setTimeout(() => {
  console.error('Server failed to boot within 15s. Aborting.');
  child.kill('SIGKILL');
  process.exit(2);
}, 15000);

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ' — ' + String(info).slice(0, 400) : ''}`);
}

async function call(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

// Convenience: do `record(name, await call(...).status === X)` AND show body on mismatch
async function expect(name, method, p, body, wantStatus, token) {
  const r = await call(method, p, body, token);
  const ok = r.status === wantStatus;
  record(name, ok, ok ? '' : `got=${r.status} want=${wantStatus} body=${JSON.stringify(r.json).slice(0, 300)}`);
  return r;
}

function waitForBoot() {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const s = chunk.toString();
      process.stdout.write('  [boot] ' + s);
      if (s.includes('Kalinabiri API running')) {
        child.stdout.removeListener('data', onData);
        booted = true;
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => process.stderr.write('  [err] ' + c.toString()));
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`server exited code=${code} before booting`));
    });
  });
}

async function run() {
  try {
    await waitForBoot();
  } catch (e) {
    console.error('Boot failed:', e.message);
    child.kill('SIGKILL');
    process.exit(2);
  }
  clearTimeout(bootTimeout);

  // Grab the seeded admin pw from boot log (file is wiped each run, pw is fresh)
  // We seeded a fresh DB and Admin@2026 only works on Postgres init — on SQLite
  // we need to either find the seeded pw in the boot log OR reset it.
  // Easier: use the register flow to create our own admin.

  try {
    // ── Public endpoints ───────────────────────────────────────
    record('GET /api/health', (await call('GET', '/api/health')).status === 200);

    const ann0 = await call('GET', '/api/announcements');
    record('GET /api/announcements', ann0.status === 200 && Array.isArray(ann0.json),
      `len=${ann0.json && ann0.json.length}`);

    record('GET /api/news', (await call('GET', '/api/news')).status === 200);
    record('GET /api/gallery', (await call('GET', '/api/gallery')).status === 200);
    record('GET /api/classes', (await call('GET', '/api/classes')).status === 200);
    record('GET /api/subjects', (await call('GET', '/api/subjects')).status === 200);

    const setRes = await call('GET', '/api/settings');
    record('GET /api/settings', setRes.status === 200 && setRes.json && setRes.json.school_name,
      setRes.json && setRes.json.school_name);

    const contact = await call('POST', '/api/contact', {
      name: 'smoke', email: 's@x.com', message: 'hello world',
    });
    record('POST /api/contact', contact.status === 200, contact.json && contact.json.message);

    // ── Auth: register ─────────────────────────────────────────
    const regS = await call('POST', '/api/auth/register', {
      username: 'alice', email: 'alice@kal.com', password: 'Alice@2026',
      role: 'student', first_name: 'Alice', last_name: 'Test',
      class: 'S1', stream: 'A',
    });
    record('POST /api/auth/register (student)', regS.status === 200,
      regS.json && (regS.json.message || regS.json.error));

    const regT = await call('POST', '/api/auth/register', {
      username: 'kagaba2', email: 'kagaba2@kal.com', password: 'Kagaba@2026',
      role: 'teacher', first_name: 'John', last_name: 'K',
      subjects_taught: 'Math',
    });
    record('POST /api/auth/register (teacher)', regT.status === 200,
      regT.json && (regT.json.message || regT.json.error));

    const dup = await call('POST', '/api/auth/register', {
      username: 'alice', email: 'alice@kal.com', password: 'Alice@2026', role: 'student',
    });
    record('POST /api/auth/register (dup → 409)', dup.status === 409);

    // ── Login flows ────────────────────────────────────────────
    // Admin default creds: on Postgres init = Admin@2026, on SQLite = random 12-char.
    // To make this test stable on SQLite we register a known admin via the register
    // route (role='admin' is allowed server-side). If that's blocked, we'll fall
    // back to fishing the seeded pw from boot output.
    const adminReg = await call('POST', '/api/auth/register', {
      username: 'testadmin', email: 'testadmin@kal.com', password: 'Admin@2026',
      role: 'admin', first_name: 'Test', last_name: 'Admin',
    });
    let adminLogin;
    if (adminReg.status === 200) {
      adminLogin = await call('POST', '/api/auth/login', { username: 'testadmin', password: 'Admin@2026' });
    } else {
      // register may have rejected role='admin' for non-secure reasons; skip
      adminLogin = { status: 0, json: { error: 'cannot bootstrap admin' } };
    }
    if (adminLogin.status !== 200) {
      record('Bootstrap admin via register', false,
        'register role=admin returned ' + adminReg.status + ' — ' + JSON.stringify(adminReg.json));
    } else {
      record('Bootstrap admin via register + login', true);
    }
    const adminToken = adminLogin.json && adminLogin.json.token;

    const wrongLogin = await call('POST', '/api/auth/login', { username: 'testadmin', password: 'wrong' });
    record('POST /api/auth/login (wrong pw → 401)', wrongLogin.status === 401);

    const studentLogin = await call('POST', '/api/auth/login', { username: 'alice', password: 'Alice@2026' });
    record('POST /api/auth/login (student)', studentLogin.status === 200,
      studentLogin.json && studentLogin.json.token ? 'token issued' : JSON.stringify(studentLogin.json));
    const studentToken = studentLogin.json && studentLogin.json.token;

    // ── Auth-protected ─────────────────────────────────────────
    if (adminToken) {
      record('GET /api/auth/me (admin)', (await call('GET', '/api/auth/me', null, adminToken)).status === 200);
    }
    record('GET /api/auth/me (no token → 401)', (await call('GET', '/api/auth/me')).status === 401);

    // ── Admin endpoints ────────────────────────────────────────
    if (adminToken) {
      await expect('GET /api/admin/stats', 'GET', '/api/admin/stats', null, 200, adminToken);
      await expect('GET /api/admin/users', 'GET', '/api/admin/users', null, 200, adminToken);
      await expect('GET /api/admin/students', 'GET', '/api/admin/students', null, 200, adminToken);
      await expect('GET /api/admin/teachers', 'GET', '/api/admin/teachers', null, 200, adminToken);
      await expect('GET /api/admin/classes', 'GET', '/api/admin/classes', null, 200, adminToken);
      await expect('GET /api/admin/subjects', 'GET', '/api/admin/subjects', null, 200, adminToken);
      await expect('GET /api/admin/news', 'GET', '/api/admin/news', null, 200, adminToken);
      await expect('GET /api/admin/assignments', 'GET', '/api/admin/assignments', null, 200, adminToken);

      const annCreate = await call('POST', '/api/admin/announcements', {
        title: 'Welcome back', content: 'Term begins Monday', category: 'general', priority: 'normal',
      }, adminToken);
      record('POST /api/admin/announcements', annCreate.status === 200,
        annCreate.json && (annCreate.json.announcement ? 'created id=' + annCreate.json.announcement.id : JSON.stringify(annCreate.json)));

      const annAfter = await call('GET', '/api/announcements');
      record('GET /api/announcements reflects new post',
        annAfter.status === 200 && Array.isArray(annAfter.json) && annAfter.json.length >= 1,
        `len=${annAfter.json && annAfter.json.length}`);

      await expect('PUT /api/admin/settings', 'PUT', '/api/admin/settings', { key: 'phone', value: '+256 999 888 777' }, 200, adminToken);
      const setRead = await call('GET', '/api/settings');
      record('GET /api/settings reflects write',
        setRead.status === 200 && setRead.json && setRead.json.phone === '+256 999 888 777',
        setRead.json && setRead.json.phone);
    }

    // ── Role guard ─────────────────────────────────────────────
    if (studentToken) {
      const studentHitsAdmin = await call('GET', '/api/admin/stats', null, studentToken);
      record('GET /api/admin/stats (as student → 403)', studentHitsAdmin.status === 403);
    }

    // ── Student dashboard ──────────────────────────────────────
    if (studentToken) {
      const dash = await call('GET', '/api/student/dashboard', null, studentToken);
      record('GET /api/student/dashboard', dash.status === 200,
        dash.json && dash.json.student ? 'has student data' : JSON.stringify(dash.json).slice(0, 100));
    }

  } catch (e) {
    record('uncaught exception', false, e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n'));
  } finally {
    child.kill('SIGKILL');
    setTimeout(() => process.exit(0), 200);
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n────────────────────────────────────────');
  console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const r of failed) console.log(`  - ${r.name}: ${r.info || ''}`);
  }
}

run();
