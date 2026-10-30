'use strict';
// 작업현황 대시보드 멀티 현장 게이트웨이 (WD-55) — 외부 패키지 없이 Node.js만으로 동작
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const BASE_DATA_DIR = process.env.WD_DATA_DIR ? path.resolve(process.env.WD_DATA_DIR) : __dirname;
if (!fs.existsSync(BASE_DATA_DIR)) {
  try { fs.mkdirSync(BASE_DATA_DIR, { recursive: true }); } catch { }
}

const CONF_FILE = path.join(BASE_DATA_DIR, 'config.json');
const DATA_FILE = path.join(BASE_DATA_DIR, 'data.json');
const SITES_FILE = path.join(BASE_DATA_DIR, 'sites.json');
const SERVER_JS = path.join(__dirname, 'server.js');
const IS_DEV = process.env.WD_DEV === '1';

const SITE_ID_RE = /^[a-z0-9-]{1,20}$/;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function generateMasterPassword(len = 16) {
  const chars = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(len * 2);
  let res = '';
  for (let i = 0; i < bytes.length && res.length < len; i++) {
    res += chars[bytes[i] % chars.length];
  }
  return res;
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpFile, filePath);
}

// ---------- 루트 config.json 및 총괄 마스터 키 초기화 ----------
let conf = { port: 3000 };
try {
  conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) };
} catch {
  try { writeJsonAtomic(CONF_FILE, conf); } catch { }
}

const PUBLIC_PORT = Number(process.env.PORT || process.env.WD_PORT) || Number(conf.port) || 3000;
const PUBLIC_BIND = process.env.WD_BIND || '0.0.0.0';

let rootMasterPassword = '';
if (conf.masterPassword && typeof conf.masterPassword === 'string' && conf.masterPassword.trim()) {
  rootMasterPassword = conf.masterPassword.trim();
} else {
  rootMasterPassword = '0000';
  conf.masterPassword = rootMasterPassword;
  try {
    writeJsonAtomic(CONF_FILE, conf);
    console.log('[보안] 총괄 마스터 키가 초기값(0000)입니다. 현장 관리 화면 또는 config.json에서 변경하세요.');
  } catch (err) {
    console.warn('[경고] 총괄 마스터 키를 저장하지 못했습니다 — 이번 실행에서만 유효:', err.message);
  }
}

function getCurrentRootMaster() {
  try {
    const latest = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
    if (latest && typeof latest.masterPassword === 'string' && latest.masterPassword.trim()) {
      rootMasterPassword = latest.masterPassword.trim();
    }
  } catch { }
  return rootMasterPassword;
}

function verifyMaster(input) {
  if (typeof input !== 'string' || !input) return false;
  const master = getCurrentRootMaster();
  if (!master) return false;
  try {
    return crypto.timingSafeEqual(sha(input), sha(master));
  } catch {
    return false;
  }
}

// ---------- 속도 제한 (checkAuthRateLimit 방식) ----------
const gwAuthFails = new Map(); // ip -> { n: number, until: number, history: number[] }

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const f = gwAuthFails.get(ip);
  if (f && f.until > now) {
    const remainSec = Math.ceil((f.until - now) / 1000);
    return { limited: true, error: `잠시 후 다시 시도하세요 (${remainSec}초)` };
  }
  return { limited: false };
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const f = gwAuthFails.get(ip) || { n: 0, until: 0, history: [] };
  f.n += 1;
  f.history.push(now);
  f.history = f.history.filter((t) => now - t <= 600000);
  if (f.history.length >= 10) {
    f.until = now + 600000;
  } else if (f.n >= 5) {
    f.until = now + 60000;
  }
  gwAuthFails.set(ip, f);
}

function clearAuthFailure(ip) {
  gwAuthFails.delete(ip);
}

function checkCsrf(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === req.headers.host;
  } catch {
    return false;
  }
}

// ---------- sites.json 로드·검증·저장 ----------
function getInitialMainSiteName() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const name = parsed && parsed.settings && typeof parsed.settings.siteName === 'string'
      ? parsed.settings.siteName.trim().slice(0, 60)
      : '';
    if (name) return name;
  } catch { }
  return '현장 1';
}

function isValidSiteDir(dirStr, isMain) {
  if (typeof dirStr !== 'string') return false;
  if (dirStr.includes('\0')) return false;
  if (isMain) {
    return dirStr === '';
  }
  if (!dirStr || path.isAbsolute(dirStr) || /^[\\/]/.test(dirStr)) return false;
  const parts = dirStr.split(/[\\/]+/);
  if (parts.some((p) => !p || p === '.' || p === '..')) return false;
  if (parts[0] !== 'sites' || parts.length !== 2) return false;
  if (!SITE_ID_RE.test(parts[1]) || parts[1] === '_deleted') return false;

  const resolved = path.resolve(BASE_DATA_DIR, dirStr);
  const rootWithSep = BASE_DATA_DIR.endsWith(path.sep) ? BASE_DATA_DIR : BASE_DATA_DIR + path.sep;
  return resolved.startsWith(rootWithSep) && resolved !== BASE_DATA_DIR;
}

function validateSiteEntry(item, seenIds) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!SITE_ID_RE.test(id) || id === '_deleted') return null;
  if (seenIds && seenIds.has(id)) return null;
  const isMain = id === 'main';
  const dir = typeof item.dir === 'string' ? item.dir.trim().replace(/\\/g, '/') : '';
  if (!isValidSiteDir(dir, isMain)) return null;
  if (!isMain && dir !== `sites/${id}`) return null;
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '';
  if (!name) return null;
  return { id, name, dir };
}

let sitesData = {
  sites: [],
  default: 'main',
};
let sitesFileMtimeMs = 0;

function saveSitesData() {
  writeJsonAtomic(SITES_FILE, sitesData);
  try {
    sitesFileMtimeMs = fs.statSync(SITES_FILE).mtimeMs;
  } catch { }
}

function loadOrInitSites() {
  if (!fs.existsSync(SITES_FILE)) {
    sitesData = {
      sites: [{ id: 'main', name: getInitialMainSiteName(), dir: '' }],
      default: 'main',
    };
    saveSitesData();
    return;
  }

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  } catch (err) {
    console.warn('[게이트웨이 경고] sites.json 파싱 실패 — 기본 현장으로 복구합니다:', err.message);
  }

  const validSites = [];
  const seenIds = new Set();
  let rejected = false;

  if (raw && Array.isArray(raw.sites)) {
    for (const item of raw.sites) {
      const checked = validateSiteEntry(item, seenIds);
      if (checked) {
        seenIds.add(checked.id);
        validSites.push(checked);
      } else {
        rejected = true;
        console.warn('[게이트웨이 경고] sites.json 내 유효하지 않은 항목 거부:', JSON.stringify(item));
      }
    }
  } else {
    rejected = true;
  }

  if (!seenIds.has('main')) {
    validSites.unshift({ id: 'main', name: getInitialMainSiteName(), dir: '' });
    seenIds.add('main');
    rejected = true;
  }

  const defId = raw && typeof raw.default === 'string' && seenIds.has(raw.default) ? raw.default : 'main';
  sitesData = { sites: validSites, default: defId };

  if (rejected) {
    try { saveSitesData(); } catch { }
  } else {
    try { sitesFileMtimeMs = fs.statSync(SITES_FILE).mtimeMs; } catch { }
  }
}

function syncSitesFromDiskIfChanged() {
  try {
    if (!fs.existsSync(SITES_FILE)) return;
    const st = fs.statSync(SITES_FILE);
    if (st.mtimeMs <= sitesFileMtimeMs) return;
    sitesFileMtimeMs = st.mtimeMs;
    const raw = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.sites)) return;

    const validSites = [];
    const seenIds = new Set();
    for (const item of raw.sites) {
      const checked = validateSiteEntry(item, seenIds);
      if (checked) {
        seenIds.add(checked.id);
        validSites.push(checked);
      } else {
        console.warn('[게이트웨이 경고] 외부 수정된 sites.json의 변조 항목 거부:', JSON.stringify(item));
      }
    }
    if (!seenIds.has('main')) {
      const prevMain = sitesData.sites.find((s) => s.id === 'main') || { id: 'main', name: getInitialMainSiteName(), dir: '' };
      validSites.unshift(prevMain);
      seenIds.add('main');
    }
    const defId = typeof raw.default === 'string' && seenIds.has(raw.default) ? raw.default : 'main';
    sitesData = { sites: validSites, default: defId };

    // 새로 추가된 유효 현장이 있으면 기동
    for (const s of validSites) {
      if (!children.has(s.id)) {
        startSiteChild(s);
      }
    }
  } catch (err) {
    console.warn('[게이트웨이 경고] sites.json 동기화 중 오류 무시:', err.message);
  }
}

function getSiteById(id) {
  if (!SITE_ID_RE.test(id)) return null;
  return sitesData.sites.find((s) => s.id === id) || null;
}

function getPublicSitesList() {
  return sitesData.sites.map((s) => ({
    id: s.id,
    name: s.name,
    default: s.id === sitesData.default,
    isDefault: s.id === sitesData.default,
  }));
}

function generateNextSiteId() {
  const existingIds = new Set(sitesData.sites.map((s) => s.id));
  let n = 2;
  while (n < 10000) {
    const candidate = `s${n}`;
    const candidateDir = path.join(BASE_DATA_DIR, 'sites', candidate);
    if (!existingIds.has(candidate) && !fs.existsSync(candidateDir)) {
      return candidate;
    }
    n++;
  }
  return `s${Date.now().toString(36).slice(-6)}`;
}

// ---------- 자식 프로세스 관리 ----------
const children = new Map(); // id -> childState
let gatewayStopping = false;

function getFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const usedPorts = new Set();
    for (const c of children.values()) {
      if (c.port) usedPorts.add(c.port);
    }
    const tryListen = (attempt = 0) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', (err) => {
        if (attempt < 5) return tryListen(attempt + 1);
        reject(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        srv.close(() => {
          if (!port || port === PUBLIC_PORT || usedPorts.has(port)) {
            if (attempt < 10) return tryListen(attempt + 1);
          }
          resolve(port);
        });
      });
    };
    tryListen();
  });
}

function ensureSiteDataSeeded(site) {
  if (!site.dir) return BASE_DATA_DIR; // main site uses BASE_DATA_DIR as-is
  if (!isValidSiteDir(site.dir, false)) {
    throw new Error(`유효하지 않은 현장 경로: ${site.dir}`);
  }
  const siteAbsDir = path.resolve(BASE_DATA_DIR, site.dir);
  if (!fs.existsSync(siteAbsDir)) {
    fs.mkdirSync(siteAbsDir, { recursive: true });
  }
  const siteDataFile = path.join(siteAbsDir, 'data.json');
  if (!fs.existsSync(siteDataFile)) {
    const initialData = {
      days: {},
      presets: {},
      settings: {
        siteName: site.name,
        place: null,
        windLimit: 10,
        rainLimit: 1,
        manualWeather: {},
        equipCols: 1,
      },
      plans: {},
      announce: null,
    };
    writeJsonAtomic(siteDataFile, initialData);
  }
  return siteAbsDir;
}

function checkChildHealthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/info',
        timeout: 800,
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function pollChildUntilReady(childState, proc, port, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (gatewayStopping || childState.stopping || childState.proc !== proc) return false;
    const ok = await checkChildHealthOnce(port);
    if (ok) {
      if (childState.proc === proc && !childState.stopping) {
        childState.status = 'ready';
        childState.failCount = 0;
        const cbs = childState.readyCallbacks.splice(0);
        for (const cb of cbs) {
          try { cb(true); } catch { }
        }
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 70));
  }
  return false;
}

async function spawnSiteChild(childState) {
  if (gatewayStopping || childState.stopping) return;
  const { site } = childState;
  let siteAbsDir;
  try {
    siteAbsDir = ensureSiteDataSeeded(site);
  } catch (err) {
    console.error(`[게이트웨이 오류] 현장(${site.id}) 폴더 준비 실패:`, err.message);
    childState.status = 'error';
    return;
  }

  let port;
  try {
    port = await getFreeLocalPort();
  } catch (err) {
    console.error(`[게이트웨이 오류] 현장(${site.id}) 내부 포트 할당 실패:`, err.message);
    scheduleChildRestart(childState);
    return;
  }

  if (gatewayStopping || childState.stopping) return;

  childState.port = port;
  childState.status = 'starting';

  const childEnv = {
    ...process.env,
    WD_SITE_CHILD: '1',
    WD_GATEWAY_PIPE: '1',
    WD_SITE_ID: site.id,
    WD_DATA_DIR: siteAbsDir,
    PORT: String(port),
    WD_PORT: String(port),
    WD_BIND: '127.0.0.1',
    WD_PUBLIC_PORT: String(PUBLIC_PORT),
  };

  let proc;
  try {
    proc = spawn(process.execPath, [SERVER_JS], {
      cwd: __dirname,
      env: childEnv,
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
  } catch (err) {
    console.error(`[게이트웨이 오류] 현장(${site.id}) 프로세스 기동 실패:`, err.message);
    scheduleChildRestart(childState);
    return;
  }

  childState.proc = proc;
  if (proc.stdin) {
    proc.stdin.on('error', () => { });
  }

  proc.on('exit', (code, signal) => {
    const wasCurrent = childState.proc === proc;
    if (wasCurrent) {
      childState.proc = null;
      childState.status = 'starting';
    }
    const stopCbs = childState.stopCallbacks.splice(0);
    for (const cb of stopCbs) {
      try { cb(); } catch { }
    }

    if (gatewayStopping || childState.stopping || !wasCurrent) return;

    childState.failCount = (childState.failCount || 0) + 1;
    console.warn(`[게이트웨이] 현장 서버(${site.id}) 종료 감지 (code=${code}, signal=${signal}, 연속실패=${childState.failCount})`);
    scheduleChildRestart(childState);
  });

  proc.on('error', (err) => {
    console.error(`[게이트웨이] 현장 서버(${site.id}) 프로세스 오류:`, err.message);
  });

  await pollChildUntilReady(childState, proc, port, 8000);
}

function scheduleChildRestart(childState) {
  if (gatewayStopping || childState.stopping) return;
  if (childState.restartTimer) clearTimeout(childState.restartTimer);
  const exp = Math.min(Math.max((childState.failCount || 1) - 1, 0), 6);
  const delayMs = Math.min(30000, 400 * Math.pow(2, exp));
  childState.restartTimer = setTimeout(() => {
    childState.restartTimer = null;
    spawnSiteChild(childState);
  }, delayMs);
  childState.restartTimer.unref();
}

function startSiteChild(site) {
  let childState = children.get(site.id);
  if (childState) {
    childState.site = site;
    return childState;
  }
  childState = {
    id: site.id,
    site,
    proc: null,
    port: 0,
    status: 'starting',
    failCount: 0,
    restartTimer: null,
    stopping: false,
    readyCallbacks: [],
    stopCallbacks: [],
  };
  children.set(site.id, childState);
  spawnSiteChild(childState);
  return childState;
}

function waitForChildReady(childState, timeoutMs = 4000) {
  if (!childState || childState.stopping) return Promise.resolve(false);
  if (childState.status === 'ready' && childState.proc && childState.port) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = childState.readyCallbacks.indexOf(onReady);
      if (idx !== -1) childState.readyCallbacks.splice(idx, 1);
      resolve(childState.status === 'ready');
    }, timeoutMs);
    function onReady(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Boolean(ok));
    }
    childState.readyCallbacks.push(onReady);
  });
}

async function stopSiteChild(id) {
  const childState = children.get(id);
  if (!childState) return;
  childState.stopping = true;
  if (childState.restartTimer) {
    clearTimeout(childState.restartTimer);
    childState.restartTimer = null;
  }
  const cbs = childState.readyCallbacks.splice(0);
  for (const cb of cbs) {
    try { cb(false); } catch { }
  }

  const proc = childState.proc;
  if (proc && proc.exitCode === null && !proc.killed) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { }
        resolve();
      }, 2500);
      childState.stopCallbacks.push(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        if (proc.stdin) proc.stdin.end();
      } catch { }
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  children.delete(id);
}

function stopAllChildrenSync() {
  gatewayStopping = true;
  for (const childState of children.values()) {
    childState.stopping = true;
    if (childState.restartTimer) {
      clearTimeout(childState.restartTimer);
      childState.restartTimer = null;
    }
    if (childState.proc) {
      try {
        if (childState.proc.stdin) childState.proc.stdin.end();
      } catch { }
      try {
        childState.proc.kill();
      } catch { }
    }
  }
}

process.on('exit', stopAllChildrenSync);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      stopAllChildrenSync();
      process.exit(0);
    });
  } catch { }
}

// ---------- HTTP 유틸리티 ----------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (len === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function extractMasterKey(req, bodyObj, searchParams) {
  if (bodyObj && typeof bodyObj === 'object') {
    if (typeof bodyObj.master === 'string' && bodyObj.master) return bodyObj.master;
    if (typeof bodyObj.masterPassword === 'string' && bodyObj.masterPassword) return bodyObj.masterPassword;
    if (typeof bodyObj.password === 'string' && bodyObj.password) return bodyObj.password;
  }
  const hdrMaster = req.headers['x-master-key'] || req.headers['x-master-password'];
  if (typeof hdrMaster === 'string' && hdrMaster) return hdrMaster;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (searchParams && searchParams.get('master')) {
    return searchParams.get('master');
  }
  return '';
}

async function moveDirWithRetry(srcDir, destDir, maxRetries = 15) {
  const parent = path.dirname(destDir);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.renameSync(srcDir, destDir);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // renameSync가 끝내 실패할 경우 cpSync + rmSync 폴백
  fs.cpSync(srcDir, destDir, { recursive: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
  if (lastErr && fs.existsSync(srcDir)) throw lastErr;
}

// ---------- /gw/sites 관리 API ----------
async function handleGatewayApi(req, res, rawPathname, searchParams) {
  syncSitesFromDiskIfChanged();

  if (rawPathname === '/gw/sites' && req.method === 'GET') {
    return json(res, 200, getPublicSitesList());
  }

  // 변경 요청(POST, PUT, DELETE)은 CSRF + 속도 제한 + 총괄 마스터 키 검증 필수
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return json(res, 405, { error: 'method not allowed' });
  }
  if (!checkCsrf(req)) {
    return json(res, 403, { error: 'CSRF 검증 실패' });
  }

  const ip = req.socket.remoteAddress || '127.0.0.1';
  const rateCheck = checkAuthRateLimit(ip);
  if (rateCheck.limited) {
    return json(res, 429, { error: rateCheck.error });
  }

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message === 'payload too large' ? '요청 본문이 너무 큽니다.' : '올바른 JSON 형식이 아닙니다.' });
  }

  const inputMaster = extractMasterKey(req, body, searchParams);
  if (!verifyMaster(inputMaster)) {
    recordAuthFailure(ip);
    return json(res, 401, { error: '마스터 비밀번호가 올바르지 않습니다.' });
  }
  clearAuthFailure(ip);

  // 1) POST /gw/sites — 현장 추가
  if (rawPathname === '/gw/sites' && req.method === 'POST') {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) {
      return json(res, 400, { error: '현장 이름을 입력하세요.' });
    }

    let id = '';
    if (body.id !== undefined && body.id !== null && body.id !== '') {
      if (typeof body.id !== 'string' || !SITE_ID_RE.test(body.id) || body.id === '_deleted') {
        return json(res, 400, { error: '현장 ID는 영소문자·숫자·하이픈 1~20자여야 합니다.' });
      }
      if (sitesData.sites.some((s) => s.id === body.id)) {
        return json(res, 400, { error: '이미 존재하는 현장 ID입니다.' });
      }
      id = body.id;
    } else {
      id = generateNextSiteId();
    }

    const expectedDir = `sites/${id}`;
    if (body.dir !== undefined && body.dir !== null && body.dir !== '') {
      if (typeof body.dir !== 'string' || body.dir !== expectedDir || !isValidSiteDir(body.dir, false)) {
        return json(res, 400, { error: '유효하지 않은 현장 폴더 경로입니다.' });
      }
    }
    if (!isValidSiteDir(expectedDir, false)) {
      return json(res, 400, { error: '유효하지 않은 현장 폴더 경로입니다.' });
    }

    const newSite = { id, name, dir: expectedDir };
    try {
      ensureSiteDataSeeded(newSite);
    } catch (err) {
      return json(res, 500, { error: `현장 폴더 생성 실패: ${err.message}` });
    }

    sitesData.sites.push(newSite);
    saveSitesData();

    const childState = startSiteChild(newSite);
    await waitForChildReady(childState, 8000);

    const pubSite = { id, name, default: false, isDefault: false };
    return json(res, 201, {
      ok: true,
      id,
      name,
      default: false,
      isDefault: false,
      site: pubSite,
      sites: getPublicSitesList(),
    });
  }

  // /gw/sites/<id> 파싱
  const parts = rawPathname.split('/');
  if (parts.length !== 4 || parts[1] !== 'gw' || parts[2] !== 'sites') {
    return json(res, 404, { error: 'not found' });
  }
  let targetId = '';
  try {
    targetId = decodeURIComponent(parts[3]);
  } catch {
    return json(res, 400, { error: '유효하지 않은 현장 ID입니다.' });
  }
  if (!SITE_ID_RE.test(targetId) || targetId === '_deleted') {
    return json(res, 400, { error: '현장 ID는 영소문자·숫자·하이픈 1~20자여야 합니다.' });
  }

  // 2) PUT /gw/sites/<id> — 현장 이름 변경
  if (req.method === 'PUT') {
    const site = getSiteById(targetId);
    if (!site) {
      return json(res, 404, { error: '존재하지 않는 현장입니다.' });
    }
    if (body.dir !== undefined && body.dir !== site.dir) {
      return json(res, 400, { error: '현장 폴더 경로는 변경할 수 없습니다.' });
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) {
      return json(res, 400, { error: '현장 이름을 입력하세요.' });
    }
    site.name = name;
    saveSitesData();

    const isDef = site.id === sitesData.default;
    return json(res, 200, {
      ok: true,
      id: site.id,
      name: site.name,
      default: isDef,
      isDefault: isDef,
      site: { id: site.id, name: site.name, default: isDef, isDefault: isDef },
      sites: getPublicSitesList(),
    });
  }

  // 3) DELETE /gw/sites/<id> — 현장 삭제(폴더 이동 + 프로세스 종료)
  if (req.method === 'DELETE') {
    if (targetId === 'main' || targetId === sitesData.default) {
      return json(res, 400, { error: '기본 현장은 삭제할 수 없습니다.' });
    }
    const idx = sitesData.sites.findIndex((s) => s.id === targetId);
    if (idx === -1) {
      return json(res, 404, { error: '존재하지 않는 현장입니다.' });
    }
    const site = sitesData.sites[idx];
    if (!isValidSiteDir(site.dir, false)) {
      return json(res, 400, { error: '유효하지 않은 현장 경로입니다.' });
    }

    await stopSiteChild(targetId);

    const srcAbsDir = path.resolve(BASE_DATA_DIR, site.dir);
    const deletedFolderName = `${targetId}-${Date.now()}`;
    const destRelDir = `sites/_deleted/${deletedFolderName}`;
    const destAbsDir = path.join(BASE_DATA_DIR, 'sites', '_deleted', deletedFolderName);

    if (fs.existsSync(srcAbsDir)) {
      try {
        await moveDirWithRetry(srcAbsDir, destAbsDir);
      } catch (err) {
        console.error(`[게이트웨이 오류] 현장(${targetId}) 폴더 이동 실패:`, err.message);
        return json(res, 500, { error: '현장 데이터 폴더 이동 중 오류가 발생했습니다.' });
      }
    }

    sitesData.sites.splice(idx, 1);
    saveSitesData();

    return json(res, 200, {
      ok: true,
      deleted: targetId,
      movedTo: destRelDir,
      sites: getPublicSitesList(),
    });
  }

  return json(res, 405, { error: 'method not allowed' });
}

// ---------- 스트리밍 프록시 ----------
function buildProxyHeaders(req, siteId) {
  const out = {};
  const connTokens = new Set();
  if (typeof req.headers.connection === 'string') {
    for (const token of req.headers.connection.split(',')) {
      const t = token.trim().toLowerCase();
      if (t) connTokens.add(t);
    }
  }
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk) || connTokens.has(lk)) continue;
    if (v !== undefined) out[k] = v;
  }
  out.host = req.headers.host || `localhost:${PUBLIC_PORT}`;
  const clientIp = req.socket.remoteAddress || '127.0.0.1';
  out['x-forwarded-for'] = clientIp;
  out['x-forwarded-site'] = siteId;
  return out;
}

async function proxyToSite(req, res, siteId, targetUrl) {
  const site = getSiteById(siteId);
  if (!site) {
    return json(res, 404, { error: '존재하지 않는 현장입니다.' });
  }

  let childState = children.get(siteId);
  if (!childState) {
    childState = startSiteChild(site);
  }

  if (childState.status !== 'ready' || !childState.port) {
    const ready = await waitForChildReady(childState, 1500);
    if (!ready || !childState.port) {
      return json(res, 503, { error: '현장 서버를 준비 중입니다. 잠시 후 다시 시도하세요.' });
    }
  }

  const isSseRequest = targetUrl === '/events' || targetUrl.startsWith('/events?') ||
    (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/event-stream'));

  const outHeaders = buildProxyHeaders(req, siteId);

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: childState.port,
      method: req.method,
      path: targetUrl,
      headers: outHeaders,
      agent: false,
    },
    (proxyRes) => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lk)) continue;
        if (v !== undefined) resHeaders[k] = v;
      }

      const contentType = String(proxyRes.headers['content-type'] || '');
      const isSse = isSseRequest || contentType.includes('text/event-stream');

      if (isSse) {
        resHeaders['Connection'] = 'keep-alive';
        resHeaders['Cache-Control'] = 'no-cache, no-transform';
        resHeaders['X-Accel-Buffering'] = 'no';
        if (req.socket) {
          req.socket.setNoDelay(true);
          req.socket.setTimeout(0);
        }
        res.writeHead(proxyRes.statusCode || 200, resHeaders);
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        proxyRes.on('data', (chunk) => {
          if (!res.writableEnded) {
            try { res.write(chunk); } catch { }
          }
        });
        proxyRes.on('end', () => {
          if (!res.writableEnded) {
            try { res.end(); } catch { }
          }
        });
        proxyRes.on('error', () => {
          if (!res.writableEnded) {
            try { res.end(); } catch { }
          }
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, resHeaders);
        proxyRes.pipe(res);
        proxyRes.on('error', () => {
          if (!res.writableEnded) {
            try { res.end(); } catch { }
          }
        });
      }
    }
  );

  proxyReq.setNoDelay(true);

  const cleanupProxy = () => {
    if (!proxyReq.destroyed) {
      proxyReq.destroy();
    }
  };

  req.on('aborted', cleanupProxy);
  res.on('close', () => {
    if (!res.writableFinished) cleanupProxy();
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      json(res, 502, { error: '현장 서버 연결 오류', detail: err.code || err.message });
    } else if (!res.writableEnded) {
      try { res.end(); } catch { }
    }
  });

  req.on('error', () => {
    cleanupProxy();
  });

  req.pipe(proxyReq);
}

// ---------- 경로 검증 및 라우팅 ----------
function hasPathTraversal(rawPathname) {
  if (!rawPathname || typeof rawPathname !== 'string') return true;
  if (rawPathname.includes('\0') || rawPathname.includes('\\')) return true;
  let fullDecoded = '';
  try {
    fullDecoded = decodeURIComponent(rawPathname);
  } catch {
    return true;
  }
  if (fullDecoded.includes('\0') || fullDecoded.includes('\\')) return true;

  for (const seg of rawPathname.split('/')) {
    if (!seg) continue;
    if (seg === '.' || seg === '..') return true;
    let dec = '';
    try {
      dec = decodeURIComponent(seg);
    } catch {
      return true;
    }
    if (dec === '.' || dec === '..' || dec.includes('/') || dec.includes('\\') || dec.includes('\0')) {
      return true;
    }
  }
  return false;
}

async function handleGatewayRequest(req, res) {
  const rawUrl = req.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const rawPathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const rawSearch = qIdx === -1 ? '' : rawUrl.slice(qIdx);

  if (hasPathTraversal(rawPathname)) {
    return json(res, 404, { error: 'not found' });
  }

  let searchParams = null;
  if (rawSearch) {
    try {
      searchParams = new URLSearchParams(rawSearch.slice(1));
    } catch { }
  }

  // 1) 게이트웨이 자체 API (/gw/sites, /gw/sites/<id>)
  if (rawPathname === '/gw/sites' || rawPathname.startsWith('/gw/sites/')) {
    return handleGatewayApi(req, res, rawPathname, searchParams);
  }

  syncSitesFromDiskIfChanged();

  // 2) 현장 접두사 경로 (/s/<id> 또는 /s/<id>/<rest>)
  if (rawPathname === '/s' || rawPathname.startsWith('/s/')) {
    const parts = rawPathname.split('/');
    // parts: ['', 's', '<id>', ...rest]
    const rawId = parts[2] || '';
    if (!rawId) {
      return json(res, 404, { error: '존재하지 않는 현장입니다.' });
    }
    let siteId = '';
    try {
      siteId = decodeURIComponent(rawId);
    } catch {
      return json(res, 404, { error: '존재하지 않는 현장입니다.' });
    }
    if (!SITE_ID_RE.test(siteId) || !getSiteById(siteId)) {
      return json(res, 404, { error: '존재하지 않는 현장입니다.' });
    }

    const restPath = '/' + parts.slice(3).join('/');
    const targetUrl = restPath + rawSearch;
    return proxyToSite(req, res, siteId, targetUrl);
  }

  // 3) 접두사 없는 기존 경로 — 기본 현장(default)으로 프록시
  const defaultSiteId = sitesData.default || 'main';
  return proxyToSite(req, res, defaultSiteId, rawPathname + rawSearch);
}

// ---------- 게이트웨이 기동 ----------
async function startGateway() {
  loadOrInitSites();

  const waitPromises = [];
  for (const site of sitesData.sites) {
    const childState = startSiteChild(site);
    waitPromises.push(waitForChildReady(childState, 8000));
  }
  await Promise.all(waitPromises);

  const server = http.createServer((req, res) => {
    handleGatewayRequest(req, res).catch((err) => {
      console.error('[게이트웨이 요청 처리 오류]:', err);
      if (!res.headersSent) json(res, 500, { error: 'internal server error' });
      else try { res.end(); } catch { }
    });
  });

  server.requestTimeout = 30 * 60 * 1000;
  server.listen(PUBLIC_PORT, PUBLIC_BIND, () => {
    const siteSummary = sitesData.sites.map((s) => `${s.id}(${s.name})`).join(', ');
    console.log(`작업현황 대시보드 v2 게이트웨이 실행 중 (공개 포트 ${PUBLIC_PORT})`);
    console.log(`  등록 현장 : ${siteSummary} [기본: ${sitesData.default}]`);
    if (getCurrentRootMaster() === '0000') {
      console.log('  ※ 총괄 마스터 키가 초기값(0000)입니다. 현장 관리 화면 또는 config.json에서 변경하세요.');
    }
    if (IS_DEV) console.log('  [개발 모드] 개발 모드(자동 새로고침) 활성화');
    console.log(`  이 PC     : http://localhost:${PUBLIC_PORT}`);
    console.log(`  TV 전용   : http://localhost:${PUBLIC_PORT}/tv`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) {
          console.log(`  다른 PC   : http://${i.address}:${PUBLIC_PORT}`);
        }
      }
    }
  });
}

startGateway().catch((err) => {
  console.error('[게이트웨이 치명적 시작 오류]:', err);
  process.exit(1);
});

