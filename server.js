'use strict';
// 작업현황 대시보드 서버 (v2) — 외부 패키지 없이 Node.js만으로 동작
if (process.env.WD_SITE_CHILD !== '1') {
  require('./gateway.js');
  return;
}
if (process.env.WD_GATEWAY_PIPE === '1' && process.stdin && typeof process.stdin.on === 'function') {
  process.stdin.resume();
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  console.error('[경고] node:sqlite 모듈을 불러올 수 없습니다:', e.message);
}

const PUB = path.join(__dirname, 'public');
const BASE_DATA_DIR = process.env.WD_DATA_DIR ? path.resolve(process.env.WD_DATA_DIR) : __dirname;
if (!fs.existsSync(BASE_DATA_DIR)) {
  try { fs.mkdirSync(BASE_DATA_DIR, { recursive: true }); } catch { }
}
const DATA_FILE = path.join(BASE_DATA_DIR, 'data.json');
const DB_FILE = path.join(BASE_DATA_DIR, 'work.db');
const CONF_FILE = path.join(BASE_DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(BASE_DATA_DIR, 'backup');
const FILES_DIR = path.join(BASE_DATA_DIR, 'files');
const FILES_INDEX_FILE = path.join(FILES_DIR, 'index.json');
const FILE_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5GB 경고 기준
const FILE_MAX_BYTES = 100 * 1024 * 1024; // 100MB 단일 파일 제한 (104,857,600B)
const CATS = ['work', 'equip', 'crew', 'material', 'notes'];
const DEFAULT_PASSWORD = '0000';
const DEFAULT_OFFICE_PASSWORD = '0000';

const WEATHER_API_BASE = process.env.WEATHER_API_BASE || 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_API_BASE = process.env.GEOCODE_API_BASE || 'https://geocoding-api.open-meteo.com/v1/search';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ---------- 개발 모드 (WD-16) ----------
const IS_DEV = process.env.WD_DEV === '1';
const SERVER_STARTED_AT = Date.now();

// 서버 시작 이후 코드/화면 파일이 수정되었는지 (재시작 필요 여부)
function isServerStale() {
  try {
    const newest = Math.max(
      fs.statSync(__filename).mtimeMs,
      fs.statSync(path.join(__dirname, 'public', 'index.html')).mtimeMs
    );
    return newest > SERVER_STARTED_AT + 1000;
  } catch {
    return false;
  }
}

function getBackupStatus() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^work-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    const latest = files.length ? files[files.length - 1].slice(5, 15) : null;
    return { count: files.length, latest, today: latest === ymd(new Date()) };
  } catch {
    return { count: 0, latest: null, today: false };
  }
}

// ---------- 설정 및 인증 상태 (WD-29, WD-34) ----------
let conf = { port: 3000 };
try {
  conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) };
} catch {
  fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2));
}
if (process.env.PORT || process.env.WD_PORT) {
  conf.port = Number(process.env.PORT || process.env.WD_PORT) || conf.port;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function generateMasterPassword(len = 16) {
  // 혼동하기 쉬운 문자(0, O, o, 1, l, I) 제외한 영숫자 56자
  const chars = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(len * 2);
  let res = '';
  for (let i = 0; i < bytes.length && res.length < len; i++) {
    res += chars[bytes[i] % chars.length];
  }
  return res;
}

function saveAuthToConfig(updates, memoryUpdateFn) {
  let curConf = {};
  try {
    curConf = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
  } catch {
    curConf = { port: conf.port || 3000 };
  }

  const newConf = { ...curConf };
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) {
      delete newConf[k];
    } else {
      newConf[k] = v;
    }
  }

  const tmpFile = `${CONF_FILE}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpFile, JSON.stringify(newConf, null, 2), 'utf8');
  fs.renameSync(tmpFile, CONF_FILE);

  conf = { ...conf, ...newConf };
  if (typeof memoryUpdateFn === 'function') memoryUpdateFn();
}

let authState = {
  admin: { plain: null, hash: null },
  office: { plain: null, hash: null },
  hints: { admin: '', office: '' },
  master: '',
};

function initAuthState() {
  // WD-34: masterPassword가 없거나 빈 문자열이면 임의 난수로 생성하여 config.json에 저장
  if (conf.masterPassword && typeof conf.masterPassword === 'string' && conf.masterPassword.trim()) {
    authState.master = String(conf.masterPassword).trim();
  } else {
    const generatedMaster = generateMasterPassword(16);
    authState.master = generatedMaster;
    try {
      saveAuthToConfig({ masterPassword: generatedMaster });
      console.log('[보안] 마스터 복구 키가 생성되어 config.json의 masterPassword에 저장되었습니다 (분실 시 이 파일에서 확인).');
    } catch (err) {
      console.warn('[경고] 마스터 복구 키를 저장하지 못했습니다 — 이번 실행에서만 유효');
    }
  }

  if (conf.passwordHash && typeof conf.passwordHash === 'object' && conf.passwordHash.salt && conf.passwordHash.hash) {
    authState.admin.hash = { salt: String(conf.passwordHash.salt), hash: String(conf.passwordHash.hash) };
    authState.admin.plain = null;
  } else {
    authState.admin.plain = String(conf.password || DEFAULT_PASSWORD);
    authState.admin.hash = null;
  }

  if (conf.officePasswordHash && typeof conf.officePasswordHash === 'object' && conf.officePasswordHash.salt && conf.officePasswordHash.hash) {
    authState.office.hash = { salt: String(conf.officePasswordHash.salt), hash: String(conf.officePasswordHash.hash) };
    authState.office.plain = null;
  } else {
    authState.office.plain = String(conf.officePassword || DEFAULT_OFFICE_PASSWORD);
    authState.office.hash = null;
  }

  authState.hints.admin = typeof conf.passwordHint === 'string' ? conf.passwordHint.trim().slice(0, 60) : '';
  authState.hints.office = typeof conf.officePasswordHint === 'string' ? conf.officePasswordHint.trim().slice(0, 60) : '';
}
initAuthState();

function verifyPassword(target, input) {
  if (typeof input !== 'string' || !input) return false;
  const targetObj = authState[target];
  if (!targetObj) return false;

  try {
    if (targetObj.hash) {
      const inputHash = crypto.scryptSync(input, targetObj.hash.salt, 32);
      const storedBuf = Buffer.from(targetObj.hash.hash, 'hex');
      if (inputHash.length !== storedBuf.length) return false;
      return crypto.timingSafeEqual(inputHash, storedBuf);
    }
    if (targetObj.plain != null) {
      return crypto.timingSafeEqual(sha(input), sha(targetObj.plain));
    }
  } catch {
    return false;
  }
  return false;
}

function verifyMaster(input) {
  if (typeof input !== 'string' || !input) return false;
  try {
    return crypto.timingSafeEqual(sha(input), sha(authState.master));
  } catch {
    return false;
  }
}

// 비밀번호 변경/초기화 전용 속도 제한 맵 (로그인 실패 제한과 독립)
const authActionFails = new Map(); // ip -> { n: number, until: number, history: number[] }

function clientIp(req) {
  if (process.env.WD_SITE_CHILD === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',');
      const last = parts[parts.length - 1].trim();
      if (last) return last;
    }
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const f = authActionFails.get(ip);
  if (f && f.until > now) {
    const remainSec = Math.ceil((f.until - now) / 1000);
    return { limited: true, error: `잠시 후 다시 시도하세요 (${remainSec}초)` };
  }
  return { limited: false };
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const f = authActionFails.get(ip) || { n: 0, until: 0, history: [] };
  f.n += 1;
  f.history.push(now);
  f.history = f.history.filter((t) => now - t <= 600000); // 최근 10분

  if (f.history.length >= 10) {
    f.until = now + 600000; // 10분 잠금
  } else if (f.n >= 5) {
    f.until = now + 60000; // 60초 잠금
  }
  authActionFails.set(ip, f);
}

function clearAuthFailure(ip) {
  authActionFails.delete(ip);
}

// ---------- 데이터 모델 v2 검증 및 정리 ----------
const str = (v, max) => String(v == null ? '' : v).slice(0, max);

function cleanWork(arr, depth = 0) {
  if (!Array.isArray(arr) || depth > 5) return [];
  return arr.slice(0, 200).filter((n) => n && typeof n === 'object').map((n) => ({
    id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
    t: str(n.t, 200),
    c: cleanWork(n.c, depth + 1),
  })).filter((n) => n.t || n.c.length > 0);
}

function cleanEquip(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 200).filter((n) => n && typeof n === 'object').map((n) => {
    const rawKind = str(n.kind, 100);
    const rawSpec = str(n.spec, 100);
    const spec = (rawKind ? (rawSpec + rawKind) : rawSpec).slice(0, 100);
    return {
      id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
      name: str(n.name, 100),
      qty: str(n.qty, 100),
      spec,
      loc: str(n.loc, 100),
      direct: n.direct === true,
    };
  }).filter((n) => n.name || n.qty || n.spec || n.loc);
}

function cleanCrew(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 200).filter((n) => n && typeof n === 'object').map((n) => ({
    id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
    job: str(n.job, 100),
    count: str(n.count, 100),
    loc: str(n.loc, 100),
    direct: n.direct === true,
  })).filter((n) => n.job || n.count || n.loc);
}

function cleanMaterial(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 200).filter((n) => n && typeof n === 'object').map((n) => ({
    id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
    kind: str(n.kind, 100),
    spec: str(n.spec, 100),
    qty: str(n.qty, 100),
    unit: str(n.unit, 100),
    use: str(n.use, 100),
    direct: n.direct === true,
  })).filter((n) => n.kind || n.spec || n.qty || n.unit || n.use);
}

function cleanNotes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 200).filter((n) => n && typeof n === 'object').map((n) => ({
    id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
    t: str(n.t, 200),
  })).filter((n) => n.t);
}

function cleanDay(d) {
  return {
    work: cleanWork(d && d.work),
    equip: cleanEquip(d && d.equip),
    crew: cleanCrew(d && d.crew),
    material: cleanMaterial(d && d.material),
    notes: cleanNotes(d && d.notes),
  };
}

const isEmpty = (day) => !day || (
  (!day.work || !day.work.length) &&
  (!day.equip || !day.equip.length) &&
  (!day.crew || !day.crew.length) &&
  (!day.material || !day.material.length) &&
  (!day.notes || !day.notes.length)
);

function cloneDayWithNewIds(day) {
  if (!day) return cleanDay();
  const cloneWork = (arr) => (arr || []).map((n) => ({
    id: crypto.randomBytes(4).toString('hex'),
    t: n.t,
    c: cloneWork(n.c),
  }));
  return {
    work: cloneWork(day.work),
    equip: cleanEquip(day.equip).map((n) => ({ id: crypto.randomBytes(4).toString('hex'), name: n.name, qty: n.qty, spec: n.spec, loc: n.loc, direct: n.direct === true })),
    crew: (day.crew || []).map((n) => ({ id: crypto.randomBytes(4).toString('hex'), job: n.job, count: n.count, loc: n.loc, direct: n.direct === true })),
    material: (day.material || []).map((n) => ({
      id: crypto.randomBytes(4).toString('hex'),
      kind: n.kind,
      spec: n.spec,
      qty: n.qty,
      unit: n.unit,
      use: n.use,
      direct: n.direct === true,
    })),
    notes: (day.notes || []).map((n) => ({ id: crypto.randomBytes(4).toString('hex'), t: n.t })),
  };
}

// ---------- 데이터 및 백업 관리 ----------
let data = {
  days: {},
  presets: {},
  settings: { siteName: '', place: null, windLimit: 10, rainLimit: 1, manualWeather: {}, equipCols: 1 },
  plans: {},
  announce: null,
};
let dataLoadedSuccessfully = false;

function cleanPlans(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const cleaned = {};
  const dateKeys = Object.keys(obj).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const keptKeys = dateKeys.length > 400 ? dateKeys.slice(-400) : dateKeys;
  for (const dateKey of keptKeys) {
    const list = obj[dateKey];
    if (!Array.isArray(list)) continue;
    const cleanedList = [];
    for (const item of list.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const text = typeof item.text === 'string' ? item.text.trim().slice(0, 200) : '';
      if (!text) continue;
      const announce = item.announce === true;
      const timeMatch = typeof item.time === 'string' ? /^([01]\d|2[0-3]):[0-5]\d$/.exec(item.time) : null;
      const time = timeMatch ? item.time : '09:00';
      const rawDur = Number(item.durMin);
      const durMin = (Number.isInteger(rawDur) && rawDur >= 1 && rawDur <= 720) ? rawDur : 10;
      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
      cleanedList.push({ id, text, announce, time, durMin });
    }
    if (cleanedList.length > 0) {
      cleaned[dateKey] = cleanedList;
    }
  }
  return cleaned;
}

function cleanAnnounce(ann) {
  if (!ann || typeof ann !== 'object') return null;
  const text = typeof ann.text === 'string' ? ann.text.trim().slice(0, 200) : '';
  if (!text) return null;
  const until = Number(ann.until);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  const id = typeof ann.id === 'string' && ann.id.trim() ? ann.id.trim() : (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
  return { id, text, until: Math.floor(until) };
}

function getActiveAnnouncements(now) {
  const currentNow = typeof now === 'number' ? now : Date.now();
  const items = [];

  // 1. 즉시 공고 (announce)
  if (data.announce && data.announce.until > currentNow) {
    items.push({
      id: data.announce.id,
      text: data.announce.text,
      until: data.announce.until,
    });
  }

  // 2. 예약 공고 (plans 오늘 날짜 항목 중 start <= now < end)
  const todayStr = ymd(new Date(currentNow));
  const todayPlans = (data.plans && data.plans[todayStr]) || [];
  for (const p of todayPlans) {
    if (p.announce === true && p.time) {
      const [h, m] = p.time.split(':').map(Number);
      const start = new Date(currentNow);
      start.setHours(h, m, 0, 0);
      const startMs = start.getTime();
      const durMs = (p.durMin || 10) * 60 * 1000;
      const endMs = startMs + durMs;
      if (currentNow >= startMs && currentNow < endMs) {
        items.push({
          id: p.id,
          text: p.text,
          until: endMs,
        });
      }
    }
  }

  items.sort((a, b) => a.until - b.until);
  return { now: currentNow, items };
}

let lastActiveAnnounceSig = '';
const announceTicker = setInterval(() => {
  try {
    const active = getActiveAnnouncements();
    const sig = active.items.map((it) => `${it.id}:${it.until}`).join(',');
    if (sig !== lastActiveAnnounceSig) {
      lastActiveAnnounceSig = sig;
      broadcast();
    }
  } catch (err) {
    console.error(`[경고] 공고 주기 갱신 오류: ${err.message}`);
  }
}, 15000);
announceTicker.unref();

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) throw new Error('empty data file');
    const parsed = JSON.parse(raw);
    data = {
      days: {},
      presets: {},
      settings: { siteName: '', place: null, windLimit: 10, rainLimit: 1, manualWeather: {}, equipCols: 1 },
      plans: {},
      announce: null,
      ...parsed,
    };
    if (!data.days) data.days = {};
    if (!data.presets) data.presets = {};
    if (!data.settings) data.settings = { siteName: '', place: null, windLimit: 10, rainLimit: 1, manualWeather: {}, equipCols: 1 };
    data.plans = cleanPlans(data.plans || {});
    data.announce = cleanAnnounce(data.announce);
    dataLoadedSuccessfully = true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      dataLoadedSuccessfully = true;
    } else {
      const corruptFile = `${DATA_FILE}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(DATA_FILE, corruptFile);
        console.error(`[경고] data.json 손상 감지. 원본을 ${corruptFile} 로 보존하고 빈 데이터로 시작합니다. (${err.message})`);
      } catch (copyErr) {
        console.error(`[오류] data.json 손상 보존 복사 실패: ${copyErr.message}`);
      }
      data = {
        days: {},
        presets: {},
        settings: { siteName: '', place: null, windLimit: 10, rainLimit: 1, manualWeather: {}, equipCols: 1 },
        plans: {},
        announce: null,
      };
      dataLoadedSuccessfully = false;
    }
  }
}

// ---------- WD-28: SQLite work.db 일별 이력 누적 저장소 ----------
let db = null;
const daysSerializedCache = new Map();

function initDatabase() {
  if (!DatabaseSync) {
    console.error('[경고] DatabaseSync를 사용할 수 없어 SQLite 이력 보관이 비활성화됩니다.');
    return;
  }
  try {
    db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA user_version = 1;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS days (
        date TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 1회성 멱등 가져오기 (data.days -> DB)
    if (data && data.days) {
      const now = Date.now();
      const insertStmt = db.prepare('INSERT OR IGNORE INTO days (date, json, updated_at) VALUES (?, ?, ?)');
      db.exec('BEGIN');
      let count = 0;
      for (const [dateKey, dayObj] of Object.entries(data.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
        const jsonStr = JSON.stringify(dayObj);
        const result = insertStmt.run(dateKey, jsonStr, now);
        if (result && result.changes > 0) count++;
        daysSerializedCache.set(dateKey, jsonStr);
      }
      db.exec('COMMIT');
      console.log(`[DB] 일별 이력 DB 초기화 완료: data.days에서 ${count}건 신규 저장 (총 data.days ${Object.keys(data.days).length}건)`);
    }
  } catch (err) {
    console.error(`[경고] SQLite work.db 초기화 실패 (이력 기능 비활성, data.json 정상 동작): ${err.message}`);
    db = null;
  }
}

function syncDbDays() {
  if (!db || !data || !data.days) return;
  try {
    const upsertStmt = db.prepare(`
      INSERT INTO days (date, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `);
    const now = Date.now();
    let synced = 0;
    db.exec('BEGIN');
    for (const [dateKey, dayObj] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const jsonStr = JSON.stringify(dayObj);
      if (daysSerializedCache.get(dateKey) !== jsonStr) {
        upsertStmt.run(dateKey, jsonStr, now);
        daysSerializedCache.set(dateKey, jsonStr);
        synced++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { }
    console.error(`[경고] work.db 동기화 실패 (data.json은 정상 저장됨): ${err.message}`);
  }
}

function ensureDbBackup(todayStr) {
  if (!db) return;
  try {
    const target = path.join(BACKUP_DIR, `work-${todayStr}.db`);
    if (!fs.existsSync(target)) {
      const safePath = target.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${safePath}'`);
    }
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^work-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    if (files.length > 30) {
      for (const oldFile of files.slice(0, files.length - 30)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, oldFile)); } catch { }
      }
    }
  } catch (err) {
    console.error(`[경고] work.db 백업 생성/정리 실패: ${err.message}`);
  }
}

function getHistoryDates() {
  if (!db) {
    return Object.keys(data.days).sort().map((d) => {
      const day = data.days[d] || {};
      return {
        date: d,
        work: Array.isArray(day.work) ? day.work.length : 0,
        equip: Array.isArray(day.equip) ? day.equip.length : 0,
        crew: Array.isArray(day.crew) ? day.crew.length : 0,
        material: Array.isArray(day.material) ? day.material.length : 0,
        notes: Array.isArray(day.notes) ? day.notes.length : 0,
      };
    });
  }
  try {
    const stmt = db.prepare('SELECT date, json FROM days ORDER BY date ASC LIMIT 3660');
    const rows = stmt.all();
    const dates = [];
    for (const r of rows) {
      let parsed = {};
      try { parsed = JSON.parse(r.json); } catch { }
      dates.push({
        date: r.date,
        work: Array.isArray(parsed.work) ? parsed.work.length : 0,
        equip: Array.isArray(parsed.equip) ? parsed.equip.length : 0,
        crew: Array.isArray(parsed.crew) ? parsed.crew.length : 0,
        material: Array.isArray(parsed.material) ? parsed.material.length : 0,
        notes: Array.isArray(parsed.notes) ? parsed.notes.length : 0,
      });
    }
    return dates;
  } catch (err) {
    console.error(`[경고] getHistoryDates 조회 실패: ${err.message}`);
    return [];
  }
}

function getHistoryDay(dateStr) {
  if (!db) {
    const day = data.days[dateStr];
    if (!day) return null;
    return { date: dateStr, day: cleanDay(day) };
  }
  try {
    const stmt = db.prepare('SELECT json FROM days WHERE date = ?');
    const row = stmt.get(dateStr);
    if (!row) {
      const day = data.days[dateStr];
      if (!day) return null;
      return { date: dateStr, day: cleanDay(day) };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(row.json);
    } catch {
      return { error: 'corrupt data' };
    }
    return { date: dateStr, day: cleanDay(parsed) };
  } catch (err) {
    console.error(`[경고] getHistoryDay(${dateStr}) 조회 실패: ${err.message}`);
    return { error: 'db error' };
  }
}

function ensureDailyBackup(todayStr) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const target = path.join(BACKUP_DIR, `data-${todayStr}.json`);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, JSON.stringify(data));
    }
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    if (files.length > 30) {
      for (const oldFile of files.slice(0, files.length - 30)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, oldFile)); } catch { }
      }
    }
  } catch (err) {
    console.error(`[경고] 백업 생성/정리 실패: ${err.message}`);
  }

  // WD-28: SQLite work.db 백업
  ensureDbBackup(todayStr);
}

function saveData() {
  const keep = Object.keys(data.days).sort().slice(-180);
  for (const k of Object.keys(data.days)) if (!keep.includes(k)) delete data.days[k];
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);

  try {
    ensureDailyBackup(ymd(new Date()));
  } catch (err) {
    console.error(`[경고] 백업 실패: ${err.message}`);
  }

  // WD-28: SQLite work.db write-through 동기화
  syncDbDays();
}

// ---------- 마이그레이션 (v0/v1 -> v2) ----------
function needsMigration() {
  if (!data.days) return false;
  for (const day of Object.values(data.days)) {
    if (!day || typeof day !== 'object') continue;
    const checkWork = (arr) => Array.isArray(arr) && arr.some((n) => n && (n.q !== undefined || n.n !== undefined || checkWork(n.c)));
    if (checkWork(day.work)) return true;
    for (const k of ['equip', 'crew', 'material']) {
      if (Array.isArray(day[k]) && day[k].some((n) => n && n.t !== undefined)) return true;
    }
    if (Array.isArray(day.notes) && day.notes.some((n) => n && (n.q !== undefined || n.n !== undefined || (Array.isArray(n.c) && n.c.length > 0)))) return true;
  }
  return false;
}

function migrateData() {
  if (!needsMigration()) return;
  const premigrateFile = `${DATA_FILE}.premigrate-${Date.now()}`;
  try {
    fs.copyFileSync(DATA_FILE, premigrateFile);
    console.log(`[마이그레이션] 구형 데이터 감지. 원본을 ${premigrateFile} 로 백업 후 v2로 변환합니다.`);
  } catch (e) {
    console.error(`[마이그레이션] premigrate 백업 실패:`, e.message);
  }

  for (const [dk, day] of Object.entries(data.days)) {
    if (!day || typeof day !== 'object') continue;
    const convertWork = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr.map((n) => ({
        id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
        t: str(n.t, 200),
        c: convertWork(n.c),
      }));
    };
    const convertEquip = (arr) => {
      const out = [];
      const walk = (list) => {
        if (!Array.isArray(list)) return;
        for (const n of list) {
          const rawKind = str(n.kind, 100);
          const rawSpec = str(n.spec, 100);
          const spec = (rawKind ? (rawSpec + rawKind) : rawSpec).slice(0, 100);
          out.push({
            id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
            name: str(n.name || n.t, 100),
            qty: str(n.qty, 100),
            spec,
            loc: str(n.loc, 100),
            direct: n.direct === true,
          });
          if (n.c && n.c.length) walk(n.c);
        }
      };
      walk(arr);
      return out;
    };
    const convertCrew = (arr) => {
      const out = [];
      const walk = (list) => {
        if (!Array.isArray(list)) return;
        for (const n of list) {
          out.push({
            id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
            job: str(n.job || n.t, 100),
            count: str(n.count || n.q, 100),
            loc: str(n.loc, 100),
            direct: n.direct === true,
          });
          if (n.c && n.c.length) walk(n.c);
        }
      };
      walk(arr);
      return out;
    };
    const convertMaterial = (arr) => {
      const out = [];
      const walk = (list) => {
        if (!Array.isArray(list)) return;
        for (const n of list) {
          out.push({
            id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
            kind: str(n.kind || n.t, 100),
            spec: str(n.spec, 100),
            qty: str(n.qty || n.q, 100),
            unit: str(n.unit, 100),
            use: str(n.use, 100),
            direct: n.direct === true,
          });
          if (n.c && n.c.length) walk(n.c);
        }
      };
      walk(arr);
      return out;
    };
    const convertNotes = (arr) => {
      const out = [];
      const walk = (list) => {
        if (!Array.isArray(list)) return;
        for (const n of list) {
          out.push({
            id: str(n.id, 16) || crypto.randomBytes(4).toString('hex'),
            t: str(n.t, 200),
          });
          if (n.c && n.c.length) walk(n.c);
        }
      };
      walk(arr);
      return out;
    };

    data.days[dk] = cleanDay({
      work: convertWork(day.work),
      equip: convertEquip(day.equip),
      crew: convertCrew(day.crew),
      material: convertMaterial(day.material),
      notes: convertNotes(day.notes),
    });
  }

  if (!data.settings) {
    data.settings = { siteName: '', place: null, windLimit: 10, rainLimit: 1, manualWeather: {} };
  }

  saveData();
}

// ---------- 자동완성 후보 캐시 ----------
let cachedSuggest = {};

function updateSuggestCache() {
  const counts = {
    'work.loc': new Map(),
    'work.desc': new Map(),
    'equip.name': new Map(),
    'equip.spec': new Map(),
    'crew.job': new Map(),
    'material.kind': new Map(),
    'material.spec': new Map(),
    'material.unit': new Map(),
    'loc': new Map(),
    'use': new Map(),
  };

  const add = (field, val) => {
    const s = String(val || '').trim();
    if (!s) return;
    counts[field].set(s, (counts[field].get(s) || 0) + 1);
  };

  const sortedDays = Object.keys(data.days || {}).sort();
  for (const dk of sortedDays) {
    const day = data.days[dk];
    if (!day) continue;

    const walkWork = (arr, depth = 0) => {
      if (!Array.isArray(arr)) return;
      for (const n of arr) {
        if (depth === 0) {
          add('work.loc', n.t);
          add('loc', n.t);
          add('use', n.t);
        } else {
          add('work.desc', n.t);
        }
        if (n.c) walkWork(n.c, depth + 1);
      }
    };
    walkWork(day.work, 0);

    if (Array.isArray(day.equip)) {
      for (const n of day.equip) {
        add('equip.name', n.name);
        add('equip.spec', n.spec);
      }
    }
    if (Array.isArray(day.crew)) {
      for (const n of day.crew) {
        add('crew.job', n.job);
      }
    }
    if (Array.isArray(day.material)) {
      for (const n of day.material) {
        add('material.kind', n.kind);
        add('material.spec', n.spec);
        add('material.unit', n.unit);
        add('use', n.use);
      }
    }
  }

  const toSortedArray = (field) => {
    return Array.from(counts[field].entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .slice(0, 200);
  };

  cachedSuggest = Object.fromEntries(
    Object.keys(counts).map((k) => [k, toSortedArray(k)])
  );
}

const LAYOUT_CATS = ['work', 'equip', 'crew', 'material', 'notes'];

function normalizeLayout(rawLayout, fallbackCols = 1) {
  const fCols = [1, 2, 3].includes(Number(fallbackCols)) ? Number(fallbackCols) : 1;
  const cols = (rawLayout && [1, 2, 3].includes(Number(rawLayout.cols)))
    ? Number(rawLayout.cols)
    : fCols;

  const defOrder = [...LAYOUT_CATS];
  const defFull = {
    work: true,
    equip: cols === 1,
    crew: cols === 1,
    material: cols === 1 || cols === 2,
    notes: true,
  };
  const defInner = { work: 1, equip: 1, crew: 1, material: 1, notes: 1 };
  const defHeights = { work: null, equip: null, crew: null, material: null, notes: null };

  if (!rawLayout || typeof rawLayout !== 'object') {
    return {
      cols,
      order: defOrder,
      full: defFull,
      inner: defInner,
      heights: defHeights,
    };
  }

  let order = defOrder;
  if (Array.isArray(rawLayout.order) && rawLayout.order.length === LAYOUT_CATS.length) {
    const isPermutation = LAYOUT_CATS.every((k) => rawLayout.order.includes(k)) && (new Set(rawLayout.order).size === LAYOUT_CATS.length);
    if (isPermutation) {
      order = rawLayout.order.map(String);
    }
  }

  const full = {};
  const hasRawFull = rawLayout.full && typeof rawLayout.full === 'object';
  for (const k of LAYOUT_CATS) {
    if (hasRawFull && typeof rawLayout.full[k] === 'boolean') {
      full[k] = rawLayout.full[k];
    } else {
      full[k] = defFull[k];
    }
  }

  const inner = {};
  const rawInner = (rawLayout.inner && typeof rawLayout.inner === 'object') ? rawLayout.inner : defInner;
  for (const k of LAYOUT_CATS) {
    const v = Number(rawInner[k]);
    inner[k] = [0, 1, 2, 3].includes(v) ? v : 1;
  }

  const heights = { ...defHeights };
  if (rawLayout.heights && typeof rawLayout.heights === 'object') {
    let sum = 0;
    for (const k of LAYOUT_CATS) {
      const v = rawLayout.heights[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 5 && v <= 90) {
        heights[k] = Math.round(v);
        sum += heights[k];
      } else {
        heights[k] = null;
      }
    }
    if (sum > 100) {
      for (const k of LAYOUT_CATS) {
        if (heights[k] != null) {
          heights[k] = Math.max(5, Math.floor(heights[k] * 100 / sum));
        }
      }
    }
  }

  return { cols, order, full, inner, heights };
}

function getPublicSettings() {
  const s = data.settings || {};
  const windLimit = (typeof s.windLimit === 'number' && Number.isFinite(s.windLimit) && s.windLimit >= 0) ? s.windLimit : 10;
  const rainLimit = (typeof s.rainLimit === 'number' && Number.isFinite(s.rainLimit) && s.rainLimit >= 0) ? s.rainLimit : 1;
  const equipCols = [1, 2, 3].includes(Number(s.equipCols)) ? Number(s.equipCols) : 1;
  const layout = normalizeLayout(s.layout, equipCols);
  return {
    siteName: s.siteName || '',
    place: s.place ? { name: s.place.name || '' } : null,
    windLimit,
    rainLimit,
    equipCols: layout.cols,
    layout,
  };
}

// ---------- 날씨 (Open-Meteo & 수동) ----------
const WMO_MAP = {
  0: { text: '맑음', icon: '☀️' },
  1: { text: '구름조금', icon: '🌤' },
  2: { text: '구름조금', icon: '🌤' },
  3: { text: '흐림', icon: '☁️' },
  45: { text: '안개', icon: '🌫' },
  48: { text: '안개', icon: '🌫' },
  51: { text: '이슬비', icon: '🌦' },
  53: { text: '이슬비', icon: '🌦' },
  55: { text: '이슬비', icon: '🌦' },
  56: { text: '이슬비', icon: '🌦' },
  57: { text: '이슬비', icon: '🌦' },
  61: { text: '비', icon: '🌧' },
  63: { text: '비', icon: '🌧' },
  65: { text: '비', icon: '🌧' },
  66: { text: '비', icon: '🌧' },
  67: { text: '비', icon: '🌧' },
  71: { text: '눈', icon: '❄️' },
  73: { text: '눈', icon: '❄️' },
  75: { text: '눈', icon: '❄️' },
  77: { text: '눈', icon: '❄️' },
  80: { text: '소나기', icon: '🌦' },
  81: { text: '소나기', icon: '🌦' },
  82: { text: '소나기', icon: '🌦' },
  85: { text: '눈소나기', icon: '❄️' },
  86: { text: '눈소나기', icon: '❄️' },
  95: { text: '뇌우', icon: '⛈' },
  96: { text: '뇌우', icon: '⛈' },
  99: { text: '뇌우', icon: '⛈' },
};

const TEXT_WMO = {
  '맑음': { code: 0, icon: '☀️' },
  '구름조금': { code: 1, icon: '🌤' },
  '흐림': { code: 3, icon: '☁️' },
  '안개': { code: 45, icon: '🌫' },
  '비': { code: 61, icon: '🌧' },
  '눈': { code: 71, icon: '❄️' },
};

let weatherCache = {
  date: null,
  updated: 0,
  place: null,
  slots: [],
  warnSummary: '',
  source: 'none',
};

async function fetchWeatherAuto() {
  const p = data.settings && data.settings.place;
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return;
  const url = `${WEATHER_API_BASE}?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=Asia%2FSeoul&forecast_days=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const hTimes = j.hourly && j.hourly.time;
    if (!Array.isArray(hTimes)) throw new Error('invalid weather response');

    const targetHours = [6, 8, 10, 12, 14, 16, 18, 20];
    const slots = [];
    const rawWind = data.settings && data.settings.windLimit;
    const windLimit = (typeof rawWind === 'number' && Number.isFinite(rawWind) && rawWind >= 0) ? rawWind : 10;
    const rawRain = data.settings && data.settings.rainLimit;
    const rainLimit = (typeof rawRain === 'number' && Number.isFinite(rawRain) && rawRain >= 0) ? rawRain : 1;

    for (const th of targetHours) {
      const padH = String(th).padStart(2, '0');
      const idx = hTimes.findIndex((t) => t.endsWith(`T${padH}:00`));
      if (idx !== -1) {
        const code = j.hourly.weather_code[idx] || 0;
        const wmo = WMO_MAP[code] || { text: '맑음', icon: '☀️' };
        const temp = Math.round(j.hourly.temperature_2m[idx]);
        const pop = Math.round(j.hourly.precipitation_probability ? j.hourly.precipitation_probability[idx] || 0 : 0);
        const rain = Math.round((j.hourly.precipitation ? j.hourly.precipitation[idx] || 0 : 0) * 10) / 10;
        const wind = Math.round((j.hourly.wind_speed_10m ? j.hourly.wind_speed_10m[idx] || 0 : 0) * 10) / 10;
        const gust = Math.round((j.hourly.wind_gusts_10m ? j.hourly.wind_gusts_10m[idx] || wind : wind) * 10) / 10;
        const maxWind = Math.max(wind, gust);
        const warn = [];
        if (windLimit > 0 && maxWind >= windLimit) warn.push('wind');
        if (rainLimit > 0 && rain >= rainLimit) warn.push('rain');

        slots.push({ h: th, code, text: wmo.text, icon: wmo.icon, temp, pop, rain, wind, gust, warn });
      }
    }

    const warnTexts = [];
    const windWarns = slots.filter((s) => s.warn.includes('wind'));
    if (windWarns.length) {
      const maxG = Math.max(...windWarns.map((s) => s.gust));
      warnTexts.push(`강풍 주의 (순간 ${maxG}m/s)`);
    }
    const rainWarns = slots.filter((s) => s.warn.includes('rain'));
    if (rainWarns.length) {
      const maxR = Math.max(...rainWarns.map((s) => s.rain));
      warnTexts.push(`강우 주의 (${maxR}mm/h)`);
    }
    const warnSummary = warnTexts.length ? `⚠ ${warnTexts.join(' · ')}` : '';

    weatherCache = {
      date: ymd(new Date()),
      updated: Date.now(),
      place: p,
      slots,
      warnSummary,
      source: 'auto',
    };
  } catch (err) {
    console.error(`[날씨] 자동 수신 실패: ${err.message}`);
  }
}

function getWeatherResponse() {
  const today = ymd(new Date());
  if (
    weatherCache.date === today &&
    weatherCache.updated &&
    (Date.now() - weatherCache.updated) < 3 * 3600 * 1000
  ) {
    return { ...weatherCache, source: 'auto' };
  }
  const manual = data.settings && data.settings.manualWeather && data.settings.manualWeather[today];
  if (Array.isArray(manual) && manual.length > 0) {
    const rawWind = data.settings && data.settings.windLimit;
    const windLimit = (typeof rawWind === 'number' && Number.isFinite(rawWind) && rawWind >= 0) ? rawWind : 10;
    const rawRain = data.settings && data.settings.rainLimit;
    const rainLimit = (typeof rawRain === 'number' && Number.isFinite(rawRain) && rawRain >= 0) ? rawRain : 1;
    const slots = manual.map((m) => {
      const info = TEXT_WMO[m.w] || { code: 0, icon: '☀️' };
      const temp = Number(m.temp) || 0;
      const wind = Number(m.wind) || 0;
      const gust = wind;
      const warn = [];
      if (windLimit > 0 && wind >= windLimit) warn.push('wind');
      return {
        h: m.h,
        code: info.code,
        text: m.w,
        icon: info.icon,
        temp,
        pop: 0,
        rain: 0,
        wind,
        gust,
        warn,
      };
    });
    const windWarns = slots.filter((s) => s.warn.includes('wind'));
    const warnSummary = windWarns.length ? `⚠ 강풍 주의 (최대 ${Math.max(...windWarns.map((s) => s.wind))}m/s)` : '';
    return {
      source: 'manual',
      updated: null,
      place: (data.settings && data.settings.place) || null,
      slots,
      warnSummary,
    };
  }
  return {
    source: 'none',
    updated: null,
    place: (data.settings && data.settings.place) || null,
    slots: [],
    warnSummary: '',
  };
}

// ---------- 파일박스 (WD-5) 인덱스 및 저장소 ----------
let fileIndex = [];
let fileIndexSaveQueue = Promise.resolve();

function saveFileIndex() {
  fileIndexSaveQueue = fileIndexSaveQueue.then(async () => {
    const tmp = path.join(FILES_DIR, `index.json.tmp-${crypto.randomBytes(4).toString('hex')}`);
    await fs.promises.writeFile(tmp, JSON.stringify(fileIndex, null, 2), 'utf8');
    await fs.promises.rename(tmp, FILES_INDEX_FILE);
  }).catch((err) => {
    console.error('saveFileIndex error:', err);
  });
  return fileIndexSaveQueue;
}

function saveFileIndexSync() {
  try {
    const tmp = path.join(FILES_DIR, `index.json.tmp-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(fileIndex, null, 2), 'utf8');
    fs.renameSync(tmp, FILES_INDEX_FILE);
  } catch (err) {
    console.error('saveFileIndexSync error:', err);
  }
}

function initFilesDir() {
  try {
    if (!fs.existsSync(FILES_DIR)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    }
    // 잔여 .tmp-* 파일 정리
    for (const f of fs.readdirSync(FILES_DIR)) {
      if (f.startsWith('.tmp-') || f.startsWith('index.json.tmp-')) {
        try { fs.unlinkSync(path.join(FILES_DIR, f)); } catch { }
      }
    }
    // index.json 로드
    fileIndex = [];
    if (fs.existsSync(FILES_INDEX_FILE)) {
      try {
        const raw = fs.readFileSync(FILES_INDEX_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          fileIndex = parsed;
        } else {
          throw new Error('Not an array');
        }
      } catch (e) {
        const corruptName = `index.json.corrupt-${Date.now()}`;
        try { fs.copyFileSync(FILES_INDEX_FILE, path.join(FILES_DIR, corruptName)); } catch { }
      }
    }
    // 실제 파일 목록과 대조하여 복구 및 정리
    const existingHex = new Set();
    for (const f of fs.readdirSync(FILES_DIR)) {
      if (/^[0-9a-f]{12}$/.test(f)) {
        existingHex.add(f);
      }
    }
    // index.json에 있는데 실제 디스크에 없는 항목 제거
    fileIndex = fileIndex.filter((item) => item && item.id && existingHex.has(item.id));
    const indexed = new Set(fileIndex.map((item) => item.id));
    // 디스크에 있는데 index.json에 없는 항목 복구
    for (const id of existingHex) {
      if (!indexed.has(id)) {
        try {
          const stat = fs.statSync(path.join(FILES_DIR, id));
          fileIndex.push({
            id,
            name: `복구-${id}`,
            size: stat.size,
            mime: 'application/octet-stream',
            uploader: '복구',
            at: stat.mtime.toISOString(),
          });
        } catch { }
      }
    }
    saveFileIndexSync();
  } catch (err) {
    console.error('initFilesDir error:', err);
  }
}

const FILE_MIMES = {
  // image
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  // pdf
  '.pdf': 'application/pdf',
  // text
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  // video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

function getPreviewType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.txt', '.log', '.csv', '.md', '.json'].includes(ext)) return 'text';
  if (['.mp4', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) return 'audio';
  return null;
}

// ---------- 기동 시퀀스 ----------
// 1. loadData
loadData();
// WD-28: SQLite work.db 초기화 및 1회성 멱등 가져오기
initDatabase();
// 2. ensureDailyBackup (정상 로드된 경우만)
if (dataLoadedSuccessfully) {
  ensureDailyBackup(ymd(new Date()));
}
// 3. 마이그레이션 (필요 시 원본 복사 후 변환)
migrateData();
// 4. suggest 캐시 계산
updateSuggestCache();
// 5. 날씨 초기 수신 및 30분 주기 타이머
fetchWeatherAuto();
setInterval(fetchWeatherAuto, 30 * 60 * 1000);
// 6. 파일박스 저장소 초기화 및 손상 복구
initFilesDir();

// ---------- 인증 ----------
const tokens = new Map();
const fails = new Map();
const TOKEN_TTL = 12 * 3600 * 1000;

function authed(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  const exp = m && tokens.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { tokens.delete(m[1]); return false; }
  return true;
}

// ---------- 사무실 로그인 / 쿠키 세션 (WD-7) ----------
const officeSessions = new Map(); // token -> expiresAt
const officeFails = new Map(); // ip -> { n, until }
const OFFICE_SESSION_TTL = 12 * 3600 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [tok, exp] of officeSessions.entries()) {
    if (exp < now) officeSessions.delete(tok);
  }
  for (const [ip, f] of officeFails.entries()) {
    if (f.until && f.until < now && f.n < 5) officeFails.delete(ip);
  }
}, 3600 * 1000);

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const rawVal = parts.slice(1).join('=').trim();
      try {
        list[key] = decodeURIComponent(rawVal);
      } catch {
        list[key] = rawVal;
      }
    }
  });
  return list;
}

const OFFICE_COOKIE = (process.env.WD_SITE_ID && process.env.WD_SITE_ID !== 'main')
  ? `wd_office_${process.env.WD_SITE_ID}`
  : 'wd_office';

function isOfficeAuthed(req) {
  if (authed(req)) return true; // 관리자 Bearer 토큰이면 통과
  const cookies = parseCookies(req);
  const tok = cookies[OFFICE_COOKIE];
  if (!tok || !/^[0-9a-f]{48}$/.test(tok)) return false;
  const exp = officeSessions.get(tok);
  if (!exp) return false;
  if (exp < Date.now()) {
    officeSessions.delete(tok);
    return false;
  }
  return true;
}

function checkCsrf(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Origin 헤더 없으면 통과
  try {
    const u = new URL(origin);
    const host = req.headers.host;
    return u.host === host;
  } catch {
    return false;
  }
}

// ---------- SSE ----------
const clients = new Set();
const broadcast = () => { for (const r of clients) r.write('event: update\ndata: 1\n\n'); };
const broadcastReload = () => {
  for (const r of clients) {
    try { r.write('event: reload\ndata: 1\n\n'); } catch { }
  }
};
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000);

// ---------- HTTP ----------
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // --- 공개 API ---
  if (p === '/api/state' && req.method === 'GET') {
    const today = ymd(new Date());
    if (!(today in data.days)) {
      const prevCandidate = Object.keys(data.days).filter((d) => d < today && !isEmpty(data.days[d])).sort().pop() || null;
      if (prevCandidate) {
        data.days[today] = cloneDayWithNewIds(data.days[prevCandidate]);
        saveData(); // 이월 복사 시에는 broadcast() 호출하지 않음
        updateSuggestCache();
      }
    }
    const prev = Object.keys(data.days).filter((d) => d < today && !isEmpty(data.days[d])).sort().pop() || null;
    return json(res, 200, {
      today,
      prev,
      todayData: data.days[today] ? cleanDay(data.days[today]) : cleanDay(),
      prevData: prev ? cleanDay(data.days[prev]) : null,
      presets: data.presets ? { ...data.presets, equip: cleanEquip(data.presets.equip) } : {},
      settings: getPublicSettings(),
      suggest: cachedSuggest,
    });
  }

  if (p === '/api/info' && req.method === 'GET') {
    const ips = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (/vEthernet|VMware|VirtualBox|WSL|Docker|Hyper-V|Loopback/i.test(name)) continue;
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) {
          ips.push({ name, address: i.address });
        }
      }
    }
    return json(res, 200, {
      port: Number(process.env.WD_PUBLIC_PORT) || conf.port,
      host: os.hostname(),
      ips,
      dev: IS_DEV,
      startedAt: SERVER_STARTED_AT,
      stale: isServerStale(),
      backup: getBackupStatus(),
    });
  }

  if (p === '/api/weather' && req.method === 'GET') {
    return json(res, 200, getWeatherResponse());
  }

  if (p === '/api/announce/active' && req.method === 'GET') {
    return json(res, 200, getActiveAnnouncements());
  }

  // --- 일별 이력 조회 API (WD-28) ---
  if (p === '/api/history/dates' && req.method === 'GET') {
    const dates = getHistoryDates();
    return json(res, 200, { dates });
  }

  if (p.startsWith('/api/history/day/') && req.method === 'GET') {
    const targetDate = p.slice('/api/history/day/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return json(res, 400, { error: '유효하지 않은 날짜 형식입니다 (YYYY-MM-DD)' });
    }
    const [y, m, d] = targetDate.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m || dt.getDate() !== d) {
      return json(res, 400, { error: '유효하지 않은 날짜입니다' });
    }
    const result = getHistoryDay(targetDate);
    if (!result) {
      return json(res, 404, { error: '해당 날짜의 기록이 없습니다' });
    }
    if (result.error) {
      return json(res, 500, { error: '이력 조회 실패' });
    }
    return json(res, 200, result);
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return json(res, 429, { error: '잠시 후 다시 시도하세요' });
    const body = await readBody(req);
    if (verifyPassword('admin', body.password)) {
      fails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, Date.now() + TOKEN_TTL);
      return json(res, 200, { token });
    }
    const n = (f ? f.n : 0) + 1;
    fails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
    return json(res, 401, { error: '비밀번호가 올바르지 않습니다' });
  }

  // --- 사무실 로그인 (WD-7) ---
  if (p === '/api/office/login' && req.method === 'POST') {
    if (!checkCsrf(req)) return json(res, 403, { error: 'CSRF 검증 실패' });
    const ip = clientIp(req);
    const f = officeFails.get(ip);
    if (f && f.until > Date.now()) return json(res, 429, { error: '잠시 후 다시 시도하세요' });

    const body = await readBody(req);
    let passMatch = false;

    // 1. 관리자 토큰(adminToken)으로 사무실 쿠키 발급 시도
    if (body.adminToken && typeof body.adminToken === 'string') {
      const exp = tokens.get(body.adminToken);
      if (exp && exp >= Date.now()) {
        passMatch = true;
      }
    }
    // 2. 비밀번호(password)로 사무실 쿠키 발급 시도 (사무실 비밀번호 또는 관리자 비밀번호)
    if (!passMatch && body.password != null) {
      if (verifyPassword('office', body.password) || verifyPassword('admin', body.password)) {
        passMatch = true;
      }
    }

    if (passMatch) {
      officeFails.delete(ip);
      const sessionTok = crypto.randomBytes(24).toString('hex');
      officeSessions.set(sessionTok, Date.now() + OFFICE_SESSION_TTL);
      res.setHeader('Set-Cookie', `${OFFICE_COOKIE}=${sessionTok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      return json(res, 200, { ok: true });
    }

    const n = (f ? f.n : 0) + 1;
    officeFails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
    return json(res, 401, { error: '비밀번호가 올바르지 않습니다' });
  }

  // --- WD-29: 비밀번호 힌트 및 관리 API ---
  if (p === '/api/auth/hint' && req.method === 'GET') {
    const target = url.searchParams.get('target');
    if (target !== 'admin' && target !== 'office') {
      return json(res, 400, { error: 'target은 admin 또는 office여야 합니다' });
    }
    return json(res, 200, { hint: authState.hints[target] || '' });
  }

  if (p === '/api/auth/status' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    const adminDefault = verifyPassword('admin', '0000') || verifyPassword('admin', DEFAULT_PASSWORD);
    const officeDefault = verifyPassword('office', DEFAULT_OFFICE_PASSWORD);
    const masterDefault = false;
    return json(res, 200, { adminDefault, officeDefault, masterDefault });
  }

  if (p === '/api/auth/change' && req.method === 'POST') {
    if (!checkCsrf(req)) return json(res, 403, { error: 'CSRF 검증 실패' });
    const ip = clientIp(req);
    const rateCheck = checkAuthRateLimit(ip);
    if (rateCheck.limited) return json(res, 429, { error: rateCheck.error });

    const body = await readBody(req);
    const target = body.target;
    if (target !== 'admin' && target !== 'office') {
      return json(res, 400, { error: 'target은 admin 또는 office여야 합니다' });
    }

    const current = body.current;
    const master = body.master;
    const newPassword = body.newPassword;
    const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 60) : '';

    // 권한 검증
    let isAuthorized = false;
    if (target === 'admin') {
      if ((current && verifyPassword('admin', current)) || (master && verifyMaster(master))) {
        isAuthorized = true;
      }
    } else if (target === 'office') {
      if (authed(req) || (current && verifyPassword('office', current)) || (master && verifyMaster(master))) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      recordAuthFailure(ip);
      return json(res, 401, { error: '현재 비밀번호 또는 마스터 비밀번호가 일치하지 않습니다' });
    }

    // 새 비밀번호 유효성 검증
    if (typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 32) {
      return json(res, 400, { error: '새 비밀번호는 4자 이상 32자 이하여야 합니다' });
    }
    if (/\s/.test(newPassword)) {
      return json(res, 400, { error: '새 비밀번호에 공백을 포함할 수 없습니다' });
    }
    if (verifyPassword(target, newPassword)) {
      return json(res, 400, { error: '현재 비밀번호와 동일한 비밀번호로 변경할 수 없습니다' });
    }
    if (verifyMaster(newPassword)) {
      return json(res, 400, { error: '마스터 비밀번호와 동일한 비밀번호를 사용할 수 없습니다' });
    }
    if (hint && newPassword && hint.toLowerCase().includes(newPassword.toLowerCase())) {
      return json(res, 400, { error: '힌트에 비밀번호 문자열을 그대로 포함할 수 없습니다' });
    }

    // scrypt 해시 생성
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 32).toString('hex');

    const updates = {};
    if (target === 'admin') {
      updates.passwordHash = { salt, hash };
      updates.password = null;
      updates.passwordHint = hint;
    } else {
      updates.officePasswordHash = { salt, hash };
      updates.officePassword = null;
      updates.officePasswordHint = hint;
    }

    try {
      saveAuthToConfig(updates, () => {
        if (target === 'admin') {
          authState.admin.hash = { salt, hash };
          authState.admin.plain = null;
          authState.hints.admin = hint;
          // 현재 요청 토큰 제외 다른 관리자 토큰 세션 무효화
          const authHeader = req.headers.authorization || '';
          const curTokenMatch = /^Bearer (\w+)$/.exec(authHeader);
          const curToken = curTokenMatch ? curTokenMatch[1] : null;
          for (const tok of tokens.keys()) {
            if (tok !== curToken) tokens.delete(tok);
          }
        } else {
          authState.office.hash = { salt, hash };
          authState.office.plain = null;
          authState.hints.office = hint;
          officeSessions.clear();
        }
      });
    } catch (err) {
      return json(res, 500, { error: '설정 파일 저장 실패' });
    }

    clearAuthFailure(ip);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/auth/reset' && req.method === 'POST') {
    if (!checkCsrf(req)) return json(res, 403, { error: 'CSRF 검증 실패' });
    const ip = clientIp(req);
    const rateCheck = checkAuthRateLimit(ip);
    if (rateCheck.limited) return json(res, 429, { error: rateCheck.error });

    const body = await readBody(req);
    const target = body.target;
    if (target !== 'admin' && target !== 'office' && target !== 'both') {
      return json(res, 400, { error: 'target은 admin, office, both 중 하나여야 합니다' });
    }

    const master = body.master;
    if (!verifyMaster(master)) {
      recordAuthFailure(ip);
      return json(res, 401, { error: '마스터 비밀번호가 올바르지 않습니다' });
    }

    // 0000 으로 scrypt 해시 생성
    const saltAdmin = crypto.randomBytes(16).toString('hex');
    const hashAdmin = crypto.scryptSync('0000', saltAdmin, 32).toString('hex');
    const saltOffice = crypto.randomBytes(16).toString('hex');
    const hashOffice = crypto.scryptSync('0000', saltOffice, 32).toString('hex');

    const updates = {};
    if (target === 'admin' || target === 'both') {
      updates.passwordHash = { salt: saltAdmin, hash: hashAdmin };
      updates.password = null;
      updates.passwordHint = '';
    }
    if (target === 'office' || target === 'both') {
      updates.officePasswordHash = { salt: saltOffice, hash: hashOffice };
      updates.officePassword = null;
      updates.officePasswordHint = '';
    }

    try {
      saveAuthToConfig(updates, () => {
        if (target === 'admin' || target === 'both') {
          authState.admin.hash = { salt: saltAdmin, hash: hashAdmin };
          authState.admin.plain = null;
          authState.hints.admin = '';
          tokens.clear();
        }
        if (target === 'office' || target === 'both') {
          authState.office.hash = { salt: saltOffice, hash: hashOffice };
          authState.office.plain = null;
          authState.hints.office = '';
          officeSessions.clear();
        }
      });
    } catch (err) {
      return json(res, 500, { error: '설정 파일 저장 실패' });
    }

    clearAuthFailure(ip);
    return json(res, 200, { ok: true, resetTo: '0000' });
  }

  if (p === '/api/office/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    const tok = cookies[OFFICE_COOKIE];
    if (tok) officeSessions.delete(tok);
    res.setHeader('Set-Cookie', `${OFFICE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/office/me' && req.method === 'GET') {
    if (isOfficeAuthed(req)) return json(res, 200, { ok: true });
    return json(res, 401, { error: 'unauthorized' });
  }

  // --- 파일박스 (WD-5, WD-7: 사무실/관리자 인증 필수) API ---
  if (p === '/api/files' && req.method === 'GET') {
    if (!isOfficeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const totalBytes = fileIndex.reduce((acc, f) => acc + (f.size || 0), 0);
    return json(res, 200, {
      files: fileIndex.map((f) => ({
        ...f,
        preview: getPreviewType(f.name),
      })),
      totalBytes,
      warnBytes: FILE_WARN_BYTES,
      maxBytes: FILE_MAX_BYTES,
      isWarn: totalBytes >= FILE_WARN_BYTES,
    });
  }

  if (p === '/api/files' && req.method === 'POST') {
    if (!checkCsrf(req)) return json(res, 403, { error: 'CSRF 검증 실패' });
    if (!isOfficeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const rawName = url.searchParams.get('name') || '';
    const rawUploader = url.searchParams.get('uploader') || '';
    let safeName = '';
    try {
      safeName = decodeURIComponent(rawName);
    } catch {
      safeName = rawName;
    }
    safeName = safeName.replace(/[\\/\x00-\x1f\x7f]/g, '').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 200);
    if (!safeName) safeName = '파일';
    const safeUploader = String(rawUploader || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100);

    // Content-Length 사전 검사
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > FILE_MAX_BYTES) {
      let clDiscarded = 0;
      let ended = false;
      const send413 = () => {
        if (ended || res.writableEnded) return;
        ended = true;
        try {
          res.writeHead(413, {
            'Content-Type': 'application/json; charset=utf-8',
            'Connection': 'close',
          });
          res.end(JSON.stringify({ error: '파일 크기는 100MB를 초과할 수 없습니다.' }));
        } catch { }
      };
      // 클라이언트가 스트림을 완전히 닫지 않거나 헤더만 보낸 경우(curl/불완전 전송) 지연 방지용 세이프티 타이머 (800ms)
      const safetyTimer = setTimeout(send413, 800);
      req.on('data', (c) => {
        clDiscarded += c.length;
        if (clDiscarded > 2 * 1024 * 1024 * 1024) {
          clearTimeout(safetyTimer);
          try { req.socket.destroy(); } catch { }
        }
      });
      req.on('end', () => {
        clearTimeout(safetyTimer);
        send413();
      });
      req.on('close', () => {
        clearTimeout(safetyTimer);
        send413();
      });
      req.resume();
      return;
    }

    const id = crypto.randomBytes(6).toString('hex');
    const tmpPath = path.join(FILES_DIR, `.tmp-${id}`);
    const ws = fs.createWriteStream(tmpPath);
    let uploaded = 0;
    let aborted = false;
    let finished = false;
    let reqEnded = false;

    const cleanupTmp = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
    };

    const reject413 = () => {
      if (aborted || finished) return;
      aborted = true;
      ws.destroy();
      cleanupTmp();
      let discarded = 0;
      let ended = false;
      const send413 = () => {
        if (ended || res.writableEnded) return;
        ended = true;
        try {
          res.writeHead(413, {
            'Content-Type': 'application/json; charset=utf-8',
            'Connection': 'close',
          });
          res.end(JSON.stringify({ error: '파일 크기는 100MB를 초과할 수 없습니다.' }));
        } catch { }
      };
      const safetyTimer = setTimeout(send413, 1000);
      req.on('data', (c) => {
        discarded += c.length;
        if (discarded > 2 * 1024 * 1024 * 1024) {
          clearTimeout(safetyTimer);
          try { req.socket.destroy(); } catch { }
        }
      });
      req.on('end', () => {
        clearTimeout(safetyTimer);
        send413();
      });
      req.on('close', () => {
        clearTimeout(safetyTimer);
        send413();
      });
      req.resume();
    };

    ws.on('error', () => {
      if (aborted || finished) return;
      aborted = true;
      cleanupTmp();
      res.writeHead(507, {
        'Content-Type': 'application/json; charset=utf-8',
        'Connection': 'close',
      });
      res.end(JSON.stringify({ error: '파일 저장 중 디스크 오류가 발생했습니다.' }));
      req.resume();
    });

    req.on('close', () => {
      if (!reqEnded && !finished) {
        aborted = true;
        ws.destroy();
        cleanupTmp();
      }
    });

    req.on('data', (chunk) => {
      if (aborted) return;
      uploaded += chunk.length;
      if (uploaded > FILE_MAX_BYTES) {
        reject413();
        return;
      }
      ws.write(chunk);
    });

    req.on('end', () => {
      reqEnded = true;
      if (aborted) return;
      ws.end();
    });

    ws.on('finish', async () => {
      if (aborted) return;
      finished = true;
      if (uploaded === 0) {
        cleanupTmp();
        return json(res, 400, { error: '빈 파일(0바이트)은 올릴 수 없습니다.' });
      }
      const targetPath = path.join(FILES_DIR, id);
      try {
        await fs.promises.rename(tmpPath, targetPath);
      } catch {
        cleanupTmp();
        return json(res, 500, { error: '파일 저장 처리에 실패했습니다.' });
      }
      const ext = path.extname(safeName).toLowerCase();
      const meta = {
        id,
        name: safeName,
        size: uploaded,
        mime: FILE_MIMES[ext] || 'application/octet-stream',
        uploader: safeUploader,
        at: new Date().toISOString(),
      };
      fileIndex.unshift(meta);
      await saveFileIndex();
      return json(res, 201, {
        ...meta,
        preview: getPreviewType(safeName),
      });
    });
    return;
  }

  let dm;
  if ((dm = /^\/api\/files\/([0-9a-f]{12})\/download$/.exec(p)) && req.method === 'GET') {
    if (!isOfficeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const fileId = dm[1];
    const item = fileIndex.find((f) => f.id === fileId);
    if (!item) return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
    const targetPath = path.join(FILES_DIR, fileId);
    if (!fs.existsSync(targetPath)) return json(res, 404, { error: '파일 데이터가 존재하지 않습니다.' });

    const asciiName = item.name.replace(/[^\x20-\x7E]/g, '_') || 'file';
    const encodedName = encodeURIComponent(item.name);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Length', item.size);
    res.writeHead(200);
    fs.createReadStream(targetPath).pipe(res);
    return;
  }

  let rm;
  if ((rm = /^\/api\/files\/([0-9a-f]{12})\/raw$/.exec(p)) && req.method === 'GET') {
    if (!isOfficeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const fileId = rm[1];
    const item = fileIndex.find((f) => f.id === fileId);
    if (!item) return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
    const ext = path.extname(item.name || '').toLowerCase();
    const mime = FILE_MIMES[ext];
    if (!mime) {
      return json(res, 404, { error: '미리보기를 지원하지 않는 형식입니다.' });
    }
    const targetPath = path.join(FILES_DIR, fileId);
    if (!fs.existsSync(targetPath)) return json(res, 404, { error: '파일 데이터가 존재하지 않습니다.' });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    if (ext !== '.pdf') {
      res.setHeader('Content-Security-Policy', 'sandbox');
    }
    res.setHeader('Accept-Ranges', 'bytes');

    const fileSize = item.size;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      if (fileSize === 0) {
        res.writeHead(416, { 'Content-Range': 'bytes */0' });
        return res.end();
      }
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!m || (!m[1] && !m[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }

      let start;
      let end;

      if (!m[1]) {
        // suffix-byte-range-spec: bytes=-N (마지막 N바이트)
        const suffix = parseInt(m[2], 10);
        if (isNaN(suffix) || suffix <= 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
          return res.end();
        }
        start = Math.max(0, fileSize - suffix);
        end = fileSize - 1;
      } else {
        start = parseInt(m[1], 10);
        if (isNaN(start) || start < 0 || start >= fileSize) {
          res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
          return res.end();
        }
        if (!m[2]) {
          // bytes=start- (open-ended)
          end = fileSize - 1;
        } else {
          // bytes=start-end
          end = parseInt(m[2], 10);
          if (isNaN(end) || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            return res.end();
          }
          if (end >= fileSize) {
            end = fileSize - 1; // clamp to last byte
          }
        }
      }

      const chunkLength = end - start + 1;
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunkLength,
      });
      fs.createReadStream(targetPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fileSize,
      });
      fs.createReadStream(targetPath).pipe(res);
    }
    return;
  }

  if (p.startsWith('/api/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
  }

  // --- 인증 필수 API ---
  if (p.startsWith('/api/')) {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    if (p === '/api/me') return json(res, 200, { ok: true });

    if (p === '/api/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      const siteName = body.siteName !== undefined ? str(body.siteName, 100) : ((data.settings && data.settings.siteName) || '');
      let place = (data.settings && data.settings.place) || null;
      if (body.place !== undefined) {
        if (body.place && typeof body.place === 'object') {
          const lat = Number(body.place.lat);
          const lon = Number(body.place.lon);
          if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            place = {
              name: str(body.place.name, 100),
              lat,
              lon,
            };
          }
          // 무효 좌표 객체(예: 좌표 없는 {name}만 있는 경우)는 기존 place 유지 (null 처리 금지)
        } else {
          place = null;
        }
      }
      const parseLimit = (v, def) => {
        const n = Number(v);
        return (Number.isFinite(n) && n >= 0) ? Math.min(100, n) : def;
      };
      const curWind = (data.settings && typeof data.settings.windLimit === 'number') ? data.settings.windLimit : 10;
      const curRain = (data.settings && typeof data.settings.rainLimit === 'number') ? data.settings.rainLimit : 1;
      const windLimit = body.windLimit !== undefined ? parseLimit(body.windLimit, 10) : curWind;
      const rainLimit = body.rainLimit !== undefined ? parseLimit(body.rainLimit, 1) : curRain;
      const rawCols = Number(body.equipCols);
      const curCols = (data.settings && data.settings.equipCols) || 1;
      const curLayout = normalizeLayout(data.settings && data.settings.layout, curCols);

      let layoutToSave;
      if (body.layout !== undefined && typeof body.layout === 'object' && body.layout !== null) {
        layoutToSave = normalizeLayout(body.layout, curLayout.cols);
      } else if (body.equipCols !== undefined) {
        const nextCols = [1, 2, 3].includes(rawCols) ? rawCols : curCols;
        layoutToSave = normalizeLayout(null, nextCols);
      } else {
        layoutToSave = curLayout;
      }
      const equipCols = layoutToSave.cols;

      data.settings = {
        ...(data.settings || {}),
        siteName,
        place,
        windLimit,
        rainLimit,
        equipCols,
        layout: layoutToSave,
      };
      saveData();
      broadcast();
      if (place) {
        fetchWeatherAuto().then(() => broadcast()).catch(() => { });
      } else {
        weatherCache = {
          date: null,
          updated: 0,
          place: null,
          slots: [],
          warnSummary: '',
          source: 'none',
        };
      }
      return json(res, 200, { ok: true, settings: getPublicSettings() });
    }

    if (p === '/api/geocode' && req.method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q || !q.trim()) return json(res, 400, { error: 'query parameter q required' });
      try {
        const geoUrl = `${GEOCODE_API_BASE}?name=${encodeURIComponent(q.trim())}&count=5&language=ko`;
        const gRes = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
        if (!gRes.ok) throw new Error(`HTTP ${gRes.status}`);
        const gJson = await gRes.json();
        const results = (gJson.results || []).map((r) => ({
          name: r.name,
          admin: r.admin1 || '',
          lat: r.latitude,
          lon: r.longitude,
        }));
        return json(res, 200, results);
      } catch (e) {
        return json(res, 502, { error: `지오코딩 조회 실패 (${e.message})` });
      }
    }

    let wm;
    if ((wm = /^\/api\/weather\/manual\/(\d{4}-\d{2}-\d{2})$/.exec(p)) && req.method === 'PUT') {
      const today = ymd(new Date());
      if (wm[1] !== today) return json(res, 400, { error: '오늘 날짜의 수동 날씨만 입력 가능합니다.' });
      const body = await readBody(req);
      if (!Array.isArray(body)) return json(res, 400, { error: '배열 형식이어야 합니다.' });
      const allowedW = ['맑음', '구름조금', '흐림', '비', '눈', '안개'];
      const slots = body.slice(0, 8).map((s) => ({
        h: Math.max(0, Math.min(24, Number(s.h) || 0)),
        w: allowedW.includes(s.w) ? s.w : '맑음',
        temp: Math.round(Number(s.temp) || 0),
        wind: Math.max(0, Math.round((Number(s.wind) || 0) * 10) / 10),
      }));

      if (!data.settings) data.settings = {};
      if (!data.settings.manualWeather) data.settings.manualWeather = {};
      data.settings.manualWeather[today] = slots;

      const keepDays = Object.keys(data.settings.manualWeather).sort().slice(-7);
      for (const k of Object.keys(data.settings.manualWeather)) {
        if (!keepDays.includes(k)) delete data.settings.manualWeather[k];
      }
      saveData();
      broadcast();
      return json(res, 200, { ok: true, weather: getWeatherResponse() });
    }

    let m;
    if ((m = /^\/api\/day\/(\d{4}-\d{2}-\d{2})$/.exec(p)) && req.method === 'PUT') {
      if (m[1] > ymd(new Date())) return json(res, 400, { error: 'future date' });
      const day = cleanDay(await readBody(req));
      data.days[m[1]] = day;
      saveData();
      updateSuggestCache();
      broadcast();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/presets' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { error: 'invalid presets body' });
      }
      const cleanPresets = {};
      for (const cat of CATS) {
        if (Array.isArray(body[cat])) {
          cleanPresets[cat] = body[cat].slice(0, 100).filter((item) => item && typeof item === 'object');
        }
      }
      data.presets = cleanPresets;
      saveData();
      broadcast();
      return json(res, 200, { ok: true });
    }

    let delM;
    if ((delM = /^\/api\/files\/([0-9a-f]{12})$/.exec(p)) && req.method === 'DELETE') {
      const fileId = delM[1];
      const idx = fileIndex.findIndex((f) => f.id === fileId);
      if (idx === -1) return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
      fileIndex.splice(idx, 1);
      await saveFileIndex();
      try {
        const targetPath = path.join(FILES_DIR, fileId);
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } catch { }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/plans' && req.method === 'GET') {
      return json(res, 200, { plans: data.plans || {} });
    }

    if (p === '/api/plans' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid payload' });
      data.plans = cleanPlans(body.plans || {});
      saveData();
      broadcast();
      return json(res, 200, { ok: true, plans: data.plans });
    }

    if (p === '/api/announce' && req.method === 'POST') {
      const body = await readBody(req);
      const rawText = typeof (body && body.text) === 'string' ? body.text.trim() : '';
      if (!rawText) return json(res, 400, { error: '공고 내용을 입력하세요.' });
      if (rawText.length > 200) return json(res, 400, { error: '공고 내용은 최대 200자입니다.' });
      const rawDur = Number(body && body.durMin);
      const durMin = (Number.isInteger(rawDur) && rawDur >= 1 && rawDur <= 720) ? rawDur : 10;
      const until = Date.now() + durMin * 60 * 1000;
      const id = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
      data.announce = { id, text: rawText, until };
      saveData();
      broadcast();
      return json(res, 200, { ok: true, announce: data.announce });
    }

    if (p === '/api/announce' && req.method === 'DELETE') {
      data.announce = null;
      saveData();
      broadcast();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  }

  // --- 정적 파일 ---
  let rel;
  if (p === '/' || p === '/index.html' || p === '/tv' || p === '/tv/') {
    rel = 'index.html';
  } else if (p === '/files' || p === '/files/' || p === '/files.html') {
    rel = 'files.html';
  } else {
    rel = decodeURIComponent(p.slice(1));
  }
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// --- 개발 모드 (WD-16) public/ 폴더 감시 ---
if (IS_DEV) {
  let reloadTimer = null;
  try {
    fs.watch(PUB, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (filename.startsWith('.') || filename.endsWith('~')) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log(`[개발 모드] public 변경 감지 (${filename}) → 브라우저 새로고침 요청`);
        broadcastReload();
      }, 200);
    });
  } catch (err) {
    console.error('[개발 모드] public 폴더 감시 실패:', err);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => { if (!res.headersSent) json(res, 400, { error: 'bad request' }); else res.end(); });
});
server.requestTimeout = 30 * 60 * 1000;
const bindHost = process.env.WD_BIND || '0.0.0.0';
const listenPort = Number(process.env.PORT || process.env.WD_PORT) || conf.port;
const siteLogPrefix = process.env.WD_SITE_ID ? `[현장:${process.env.WD_SITE_ID}] ` : '';
server.listen(listenPort, bindHost, () => {
  console.log(`${siteLogPrefix}작업현황 대시보드 v2 실행 중 (포트 ${listenPort})`);
  if (IS_DEV) console.log(`  ${siteLogPrefix}[개발 모드] 개발 모드(자동 새로고침) 활성화 (public/ 감시 중)`);
  if (!process.env.WD_SITE_ID) {
    console.log(`  이 PC     : http://localhost:${listenPort}`);
    console.log(`  TV 전용   : http://localhost:${listenPort}/tv`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  다른 PC   : http://${i.address}:${listenPort}`);
  }
  if (verifyPassword('admin', DEFAULT_PASSWORD) || verifyPassword('admin', '0000')) console.log(`※ ${siteLogPrefix}관리자 비밀번호가 초기/기본값입니다. 화면 설정 또는 config.json에서 변경하세요.`);
  if (verifyPassword('office', DEFAULT_OFFICE_PASSWORD)) console.log(`※ ${siteLogPrefix}사무실 비밀번호가 기본값(0000)입니다. 화면 설정 또는 config.json에서 변경하세요.`);
});
