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
const IMPORT_TEMPLATES_FILE = path.join(BASE_DATA_DIR, 'import-templates.json');
const AI_CONFIG_FILE = path.join(BASE_DATA_DIR, 'ai-config.json');
const AI_PROVIDERS = new Set(['gemini', 'deepseek', 'lmstudio', 'opencode', 'custom']);

// 모델명·주소는 사용자가 바꿀 수 있는 제안값임 (WD-82)
const AI_PRESETS = {
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    vision: true,
    hint: '무료 티어 지원 (Google AI Studio에서 API 키 발급)',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    vision: false,
    hint: '가성비 우수 (텍스트 전용)',
  },
  lmstudio: {
    name: 'LM Studio (로컬)',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    vision: false,
    hint: '로컬 PC 실행 (API 키 불필요 가능, 주소/모델 직접 입력)',
  },
  opencode: {
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: '',
    vision: false,
    hint: 'OpenCode Go 엔드포인트 (주소·모델 변경 가능)',
  },
  custom: {
    name: '사용자 정의 (Custom)',
    baseUrl: '',
    model: '',
    vision: false,
    hint: '기타 OpenAI 호환 엔드포인트',
  },
};
const FILE_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5GB 경고 기준
const FILE_MAX_BYTES = 100 * 1024 * 1024; // 100MB 단일 파일 제한 (104,857,600B)
const CATS = ['work', 'equip', 'crew', 'material', 'notes'];
const DEFAULT_PASSWORD = '0000';
const DEFAULT_OFFICE_PASSWORD = '0000';

const WEATHER_API_BASE = process.env.WD_WEATHER_API_BASE || process.env.WEATHER_API_BASE || 'https://api.open-meteo.com/v1/forecast';
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

// WD-66: 상세 백업 상태 조회 (관리자 전용)
function getDetailedBackupStatus() {
  const result = {
    data: { count: 0, latest: null, files: [] },
    db: { count: 0, latest: null, files: [] },
    manual: { count: 0, latest: null, files: [] },
    dir: BACKUP_DIR,
  };

  if (!fs.existsSync(BACKUP_DIR)) return result;

  try {
    const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    const autoDataFiles = [];
    const autoDbFiles = [];
    const manualFiles = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      // 1) 자동 data: data-YYYY-MM-DD.json
      let m = /^data-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (m) {
        try {
          const st = fs.statSync(path.join(BACKUP_DIR, name));
          autoDataFiles.push({ name, date: m[1], bytes: st.size });
        } catch {}
        continue;
      }
      // 2) 자동 db: work-YYYY-MM-DD.db
      m = /^work-(\d{4}-\d{2}-\d{2})\.db$/.exec(name);
      if (m) {
        try {
          const st = fs.statSync(path.join(BACKUP_DIR, name));
          autoDbFiles.push({ name, date: m[1], bytes: st.size });
        } catch {}
        continue;
      }
      // 3) 수동 백업: (data|work)-manual-YYYYMMDD-HHmmss.(json|db)
      m = /^(?:data|work)-manual-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(?:json|db)$/.exec(name);
      if (m) {
        try {
          const st = fs.statSync(path.join(BACKUP_DIR, name));
          const dateStr = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
          manualFiles.push({ name, date: dateStr, bytes: st.size });
        } catch {}
        continue;
      }
    }

    // 최신순(이름 역순) 정렬
    autoDataFiles.sort((a, b) => b.name.localeCompare(a.name));
    autoDbFiles.sort((a, b) => b.name.localeCompare(a.name));
    manualFiles.sort((a, b) => b.name.localeCompare(a.name));

    result.data = {
      count: autoDataFiles.length,
      latest: autoDataFiles.length ? autoDataFiles[0].date : null,
      files: autoDataFiles.slice(0, 10),
    };
    result.db = {
      count: autoDbFiles.length,
      latest: autoDbFiles.length ? autoDbFiles[0].date : null,
      files: autoDbFiles.slice(0, 10),
    };
    result.manual = {
      count: manualFiles.length,
      latest: manualFiles.length ? manualFiles[0].date : null,
      files: manualFiles.slice(0, 10),
    };
  } catch (err) {
    console.error('[백업] 상세 상태 조회 오류:', err.message);
  }

  return result;
}

let lastManualBackupTime = 0;

// WD-66: 즉시 수동 백업 수행 (관리자 전용)
function performManualBackup(res) {
  const now = Date.now();
  // 연타 방지: 1초 내 중복 요청 시 429
  if (now - lastManualBackupTime < 1000) {
    return json(res, 429, { error: '잠시 후 다시 시도해 주세요.' });
  }
  lastManualBackupTime = now;

  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

    const createdFiles = [];

    // 1. data.json 메모리 데이터 수동 백업
    const dataFilename = `data-manual-${ts}.json`;
    const dataPath = path.join(BACKUP_DIR, dataFilename);
    const tmpDataPath = dataPath + '.tmp';
    fs.writeFileSync(tmpDataPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpDataPath, dataPath);
    createdFiles.push(dataFilename);

    // 2. work.db 수동 백업 (SQLite DB 존재 시 VACUUM INTO)
    if (db) {
      const dbFilename = `work-manual-${ts}.db`;
      const dbPath = path.join(BACKUP_DIR, dbFilename);
      const safePath = dbPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${safePath}'`);
      createdFiles.push(dbFilename);
    }

    // 3. 수동 백업 파일 정리: 종류별(data, db) 최근 10개만 보관
    const currentFiles = fs.readdirSync(BACKUP_DIR);
    const manualData = currentFiles.filter((f) => /^data-manual-\d{8}-\d{6}\.json$/.test(f)).sort();
    if (manualData.length > 10) {
      for (const old of manualData.slice(0, manualData.length - 10)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
      }
    }

    const manualDb = currentFiles.filter((f) => /^work-manual-\d{8}-\d{6}\.db$/.test(f)).sort();
    if (manualDb.length > 10) {
      for (const old of manualDb.slice(0, manualDb.length - 10)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
      }
    }

    console.log(`[백업] 수동 백업 완료: ${createdFiles.join(', ')}`);
    return json(res, 200, { ok: true, files: createdFiles });
  } catch (err) {
    console.error('[백업] 수동 백업 실패:', err);
    return json(res, 500, { error: '수동 백업 처리 중 오류가 발생했습니다: ' + err.message });
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

// --- 개발자 키 로드 (WD-63) ---
let devKey = null;
try {
  const devKeyPath = path.join(__dirname, 'devkey.json');
  if (fs.existsSync(devKeyPath)) {
    const parsed = JSON.parse(fs.readFileSync(devKeyPath, 'utf8'));
    if (
      parsed &&
      typeof parsed.salt === 'string' &&
      typeof parsed.hash === 'string' &&
      /^[0-9a-fA-F]+$/.test(parsed.salt) &&
      /^[0-9a-fA-F]+$/.test(parsed.hash) &&
      parsed.hash.length === 64
    ) {
      devKey = {
        salt: parsed.salt,
        hashBuf: Buffer.from(parsed.hash, 'hex')
      };
    }
  }
} catch {
  devKey = null;
}

function verifyDevKey(input) {
  if (!devKey || typeof input !== 'string' || !input) return false;
  try {
    const inputHash = crypto.scryptSync(input, devKey.salt, 32);
    if (inputHash.length !== devKey.hashBuf.length) return false;
    return crypto.timingSafeEqual(inputHash, devKey.hashBuf);
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
  const res = {
    work: cleanWork(d && d.work),
    equip: cleanEquip(d && d.equip),
    crew: cleanCrew(d && d.crew),
    material: cleanMaterial(d && d.material),
    notes: cleanNotes(d && d.notes),
  };
  let adj = Number(d && d.mealAdj);
  if (!isNaN(adj)) {
    adj = Math.trunc(adj);
    if (adj < -99) adj = -99;
    if (adj > 99) adj = 99;
    if (adj !== 0) {
      res.mealAdj = adj;
    }
  }
  return res;
}

// WD-69: 무상태 rev 계산 (cleanDay 결과 JSON의 SHA-1 앞 12자리)
function calcDayRev(d) {
  const cd = cleanDay(d);
  return crypto.createHash('sha1').update(JSON.stringify(cd)).digest('hex').slice(0, 12);
}

// ---------- WD-82: AI 작업일보 분석 설정 및 OpenAI 호환 중계 ----------
function loadAiConfig() {
  const def = {
    provider: 'gemini',
    baseUrl: AI_PRESETS.gemini.baseUrl,
    model: AI_PRESETS.gemini.model,
    apiKey: '',
    vision: AI_PRESETS.gemini.vision,
  };
  try {
    if (!fs.existsSync(AI_CONFIG_FILE)) return def;
    const raw = fs.readFileSync(AI_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return def;
    return {
      provider: AI_PROVIDERS.has(parsed.provider) ? parsed.provider : def.provider,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : def.baseUrl,
      model: typeof parsed.model === 'string' ? parsed.model : def.model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      vision: typeof parsed.vision === 'boolean' ? parsed.vision : def.vision,
    };
  } catch {
    return def;
  }
}

function saveAiConfig(cfg) {
  fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
  const tmpPath = `${AI_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpPath, AI_CONFIG_FILE);
}

function getSafeAiConfig(cfg) {
  const hasKey = !!(cfg.apiKey && cfg.apiKey.trim().length > 0);
  const trimmed = hasKey ? cfg.apiKey.trim() : '';
  const keyHint = hasKey
    ? (trimmed.length >= 4 ? `...${trimmed.slice(-4)}` : '...****')
    : '';
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    vision: !!cfg.vision,
    hasKey,
    keyHint,
    presets: AI_PRESETS,
  };
}

function isLocalAiHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase().trim();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isBlockedAiHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().trim();
  if (h.startsWith('169.254.') || h === 'metadata.google.internal' || h === 'metadata') {
    return true;
  }
  return false;
}

function maskApiKey(rawStr, apiKey) {
  if (!rawStr) return '';
  let s = String(rawStr);
  if (apiKey && apiKey.length >= 4) {
    s = s.split(apiKey).join('***');
  }
  return s.slice(0, 200);
}

let aiParseInProgress = false; // 동시 진행 1건 제한
const aiRateLimitMap = new Map(); // key -> timestamps[]

function checkAiRateLimit(key) {
  const now = Date.now();
  let list = aiRateLimitMap.get(key) || [];
  list = list.filter((ts) => now - ts < 60 * 1000);
  if (list.length >= 6) {
    aiRateLimitMap.set(key, list);
    return false; // 분당 6회 초과
  }
  list.push(now);
  aiRateLimitMap.set(key, list);
  return true;
}

async function callAiChatCompletions(cfg, messages, options = {}) {
  let endpoint = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!endpoint.endsWith('/chat/completions')) {
    endpoint += '/chat/completions';
  }

  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return { ok: false, status: 400, error: 'invalid_base_url', message: '올바른 API 주소 형식이 아닙니다.' };
  }

  if (isBlockedAiHost(u.hostname)) {
    return { ok: false, status: 400, error: 'invalid_base_url', message: '허용되지 않는 API 주소입니다.' };
  }

  const isLocal = isLocalAiHost(u.hostname);
  if (!cfg.model || !cfg.baseUrl) {
    return { ok: false, status: 400, error: 'ai_not_configured', message: 'AI 모델 또는 API 주소가 설정되지 않았습니다.' };
  }
  if (!isLocal && (!cfg.apiKey || !cfg.apiKey.trim())) {
    return { ok: false, status: 400, error: 'ai_not_configured', message: 'API 키가 설정되지 않았습니다.' };
  }

  const makePayload = (withResponseFormat) => {
    const p = {
      model: cfg.model,
      temperature: 0,
      messages,
    };
    if (withResponseFormat && options.jsonMode !== false) {
      p.response_format = { type: 'json_object' };
    }
    return p;
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey && cfg.apiKey.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }

  const execute = async (payload) => {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.WD_AI_TIMEOUT_MS) || 90000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
      clearTimeout(timer);

      let bodyText = '';
      if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        let received = 0;
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > 2 * 1024 * 1024) {
            try { await reader.cancel(); } catch {}
            return { ok: false, status: 502, error: 'ai_bad_output', message: 'AI 응답 크기가 너무 큽니다 (2MB 초과).' };
          }
          chunks.push(value);
        }
        bodyText = Buffer.concat(chunks).toString('utf8');
      } else {
        bodyText = await resp.text();
        if (Buffer.byteLength(bodyText, 'utf8') > 2 * 1024 * 1024) {
          return { ok: false, status: 502, error: 'ai_bad_output', message: 'AI 응답 크기가 너무 큽니다 (2MB 초과).' };
        }
      }

      if (!resp.ok) {
        let errJson = null;
        try { errJson = JSON.parse(bodyText); } catch {}
        const upstreamMsg = (errJson && errJson.error && errJson.error.message) || bodyText || resp.statusText;
        const safeMsg = maskApiKey(upstreamMsg, cfg.apiKey);

        if (resp.status === 401 || resp.status === 403) {
          return { ok: false, status: 502, error: 'ai_auth', message: 'AI 서비스 인증에 실패했습니다. API 키를 확인하세요.' };
        }
        if (resp.status === 429) {
          return { ok: false, status: 429, error: 'ai_rate_limited', message: 'AI 서비스 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.' };
        }
        if (resp.status >= 500) {
          return { ok: false, status: 502, error: 'ai_unreachable', message: 'AI 서비스에 연결할 수 없습니다 (원격 서버 오류).' };
        }
        return { ok: false, status: 502, error: 'ai_request_failed', message: safeMsg, is400: resp.status === 400 };
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(bodyText);
      } catch {
        return { ok: false, status: 502, error: 'ai_bad_output', message: 'AI 서비스 응답이 올바른 JSON이 아닙니다.' };
      }

      return { ok: true, data: parsedJson };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return { ok: false, status: 504, error: 'ai_timeout', message: 'AI 서비스 응답 시간이 초과되었습니다 (90초).' };
      }
      return { ok: false, status: 502, error: 'ai_unreachable', message: 'AI 서비스에 연결할 수 없습니다.' };
    }
  };

  let res = await execute(makePayload(true));
  if (!res.ok && res.is400 && options.jsonMode !== false) {
    // response_format 미지원 400일 경우 1회 제거 후 재시도
    res = await execute(makePayload(false));
  }
  return res;
}

// WD-72: 작업일보 PDF 양식(템플릿) 검증 및 저장 유틸
const VALID_TARGETS = new Set([
  'weather.text', 'weather.tempMin', 'weather.tempMax', 'weather.rain',
  'crew', 'equip', 'material', 'notes', 'work', 'site.name'
]);
const TARGET_ALLOWED_FIELDS = {
  crew: new Set(['job', 'count', 'loc', 'direct']),
  equip: new Set(['name', 'qty', 'spec', 'loc', 'direct']),
  material: new Set(['kind', 'spec', 'qty', 'unit', 'use', 'direct']),
};

function loadImportTemplates() {
  try {
    if (!fs.existsSync(IMPORT_TEMPLATES_FILE)) return { templates: [] };
    const raw = fs.readFileSync(IMPORT_TEMPLATES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.templates)) return parsed;
    return { templates: [] };
  } catch (err) {
    return { templates: [] };
  }
}

function saveImportTemplates(dataObj) {
  const tmp = IMPORT_TEMPLATES_FILE + `.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2), 'utf8');
  fs.renameSync(tmp, IMPORT_TEMPLATES_FILE);
}

function validateAndCleanTemplate(body, pathId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '템플릿 본문이 객체 형식이 아닙니다.' };
  }
  const id = String(pathId || body.id || '').trim();
  if (!/^[a-z0-9-]{1,30}$/.test(id)) {
    return { error: '템플릿 ID는 영문 소문자, 숫자, 하이픈(-) 조합 1~30자여야 합니다.' };
  }
  const name = String(body.name || '').trim();
  if (name.length < 1 || name.length > 60) {
    return { error: '템플릿 이름은 1~60자 이내여야 합니다.' };
  }
  const pageCount = parseInt(body.pageCount, 10);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20) {
    return { error: '페이지 수는 1~20 사이의 정수여야 합니다.' };
  }
  if (!Array.isArray(body.zones)) {
    return { error: '구역(zones)은 배열이어야 합니다.' };
  }
  if (body.zones.length > 50) {
    return { error: '구역은 최대 50개까지 설정할 수 있습니다.' };
  }

  const cleanZones = [];
  for (let i = 0; i < body.zones.length; i++) {
    const z = body.zones[i];
    if (!z || typeof z !== 'object' || Array.isArray(z)) {
      return { error: `구역 #${i + 1}의 형식이 올바르지 않습니다.` };
    }
    const page = parseInt(z.page, 10);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      return { error: `구역 #${i + 1}의 페이지 번호는 1~${pageCount} 사이여야 합니다.` };
    }
    const kind = String(z.kind || '').trim();
    if (kind !== 'text' && kind !== 'table') {
      return { error: `구역 #${i + 1}의 종류(kind)는 'text' 또는 'table'이어야 합니다.` };
    }
    const target = String(z.target || '').trim();
    if (!VALID_TARGETS.has(target)) {
      return { error: `구역 #${i + 1}의 대상(target: ${target})이 올바르지 않습니다.` };
    }

    const r = z.rect;
    if (!r || typeof r !== 'object') {
      return { error: `구역 #${i + 1}의 사각 영역(rect)이 누락되었습니다.` };
    }
    const rx = Number(r.x);
    const ry = Number(r.y);
    const rw = Number(r.w);
    const rh = Number(r.h);
    if (
      isNaN(rx) || isNaN(ry) || isNaN(rw) || isNaN(rh) ||
      rx < 0 || ry < 0 || rw <= 0 || rh <= 0 ||
      rx > 1 || ry > 1 || rx + rw > 1.01 || ry + rh > 1.01
    ) {
      return { error: `구역 #${i + 1}의 rect 좌표(0~1 비율)가 범위를 벗어났습니다.` };
    }

    const cleanZone = {
      page,
      kind,
      target,
      rect: {
        x: Math.round(rx * 10000) / 10000,
        y: Math.round(ry * 10000) / 10000,
        w: Math.round(rw * 10000) / 10000,
        h: Math.round(rh * 10000) / 10000,
      },
    };

    if (z.header !== undefined && z.header !== null) {
      if (typeof z.header !== 'string') {
        return { error: `구역 #${i + 1}의 상위제목(header)은 문자열이어야 합니다.` };
      }
      const hdr = z.header.trim();
      if (hdr.length > 100) {
        return { error: `구역 #${i + 1}의 상위제목(header)은 100자 이하이어야 합니다.` };
      }
      if (hdr.length > 0) {
        cleanZone.header = hdr;
      }
    }

    if (kind === 'table') {
      if (z.columns !== undefined) {
        if (!Array.isArray(z.columns)) {
          return { error: `구역 #${i + 1}의 열 경계(columns)는 배열이어야 합니다.` };
        }
        const cols = [];
        let prevCol = -1;
        for (const c of z.columns) {
          const num = Number(c);
          if (isNaN(num) || num < 0 || num > 1 || num <= prevCol) {
            return { error: `구역 #${i + 1}의 열 경계(columns)는 0~1 범위의 오름차순이어야 합니다.` };
          }
          cols.push(Math.round(num * 10000) / 10000);
          prevCol = num;
        }
        cleanZone.columns = cols;
      }
      if (z.columnMap !== undefined) {
        if (typeof z.columnMap !== 'object' || Array.isArray(z.columnMap)) {
          return { error: `구역 #${i + 1}의 columnMap은 객체여야 합니다.` };
        }
        const cleanColMap = {};
        const allowed = TARGET_ALLOWED_FIELDS[target];
        for (const [colIdxStr, fieldRaw] of Object.entries(z.columnMap)) {
          const colIdx = parseInt(colIdxStr, 10);
          if (isNaN(colIdx) || colIdx < 0) {
            return { error: `구역 #${i + 1} columnMap의 열 번호(${colIdxStr})가 올바르지 않습니다.` };
          }
          const field = String(fieldRaw || '').trim();
          if (allowed && !allowed.has(field)) {
            return { error: `구역 #${i + 1} target '${target}'에서 허용되지 않는 필드명 '${field}'입니다.` };
          }
          cleanColMap[colIdx] = field;
        }
        cleanZone.columnMap = cleanColMap;
      }
      if (z.skipRows !== undefined) {
        const sr = parseInt(z.skipRows, 10);
        if (isNaN(sr) || sr < 0) {
          return { error: `구역 #${i + 1}의 skipRows는 0 이상의 정수여야 합니다.` };
        }
        cleanZone.skipRows = sr;
      }
      if (z.stopAt !== undefined) {
        const sa = String(z.stopAt || '').trim();
        if (sa !== 'sum' && sa !== 'blank') {
          return { error: `구역 #${i + 1}의 stopAt은 'sum' 또는 'blank'여야 합니다.` };
        }
        cleanZone.stopAt = sa;
      }
    }

    cleanZones.push(cleanZone);
  }

  return {
    template: {
      id,
      name,
      pageCount,
      zones: cleanZones,
    },
  };
}

const isEmpty = (day) => !day || (
  (!day.work || !day.work.length) &&
  (!day.equip || !day.equip.length) &&
  (!day.crew || !day.crew.length) &&
  (!day.material || !day.material.length) &&
  (!day.notes || !day.notes.length) &&
  (!day.mealAdj || day.mealAdj === 0)
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
  const today = ymd(new Date());
  if (!db) {
    return Object.keys(data.days)
      .filter((d) => d <= today)
      .sort().map((d) => {
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
    const stmt = db.prepare('SELECT date, json FROM days WHERE date <= ? ORDER BY date ASC LIMIT 3660');
    const rows = stmt.all(today);
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
  const today = ymd(new Date());
  const pastAndToday = Object.keys(data.days).filter((k) => k <= today).sort().slice(-180);
  const future = Object.keys(data.days).filter((k) => k > today);
  const keep = new Set([...pastAndToday, ...future]);
  for (const k of Object.keys(data.days)) if (!keep.has(k)) delete data.days[k];
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

// WD-71: 장애 시 재시도 백오프 타이머 및 상태 관리
let weatherRetryCount = 0;
let weatherRetryTimer = null;
const WEATHER_RETRY_BASE_MS = Number(process.env.WD_WEATHER_RETRY_BASE_MS) || 60000;

function clearWeatherRetry() {
  weatherRetryCount = 0;
  if (weatherRetryTimer) {
    clearTimeout(weatherRetryTimer);
    weatherRetryTimer = null;
  }
}

function scheduleWeatherRetry() {
  if (weatherRetryTimer) {
    clearTimeout(weatherRetryTimer);
    weatherRetryTimer = null;
  }
  const delay = Math.min(WEATHER_RETRY_BASE_MS * Math.pow(2, weatherRetryCount), 30 * 60 * 1000);
  weatherRetryCount++;
  weatherRetryTimer = setTimeout(async () => {
    weatherRetryTimer = null;
    await fetchWeatherAuto();
  }, delay);
  if (weatherRetryTimer.unref) weatherRetryTimer.unref();
}

async function fetchWeatherAuto() {
  const p = data.settings && data.settings.place;
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') {
    clearWeatherRetry();
    return false;
  }
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
    clearWeatherRetry();
    return true;
  } catch (err) {
    console.error(`[날씨] 자동 수신 실패: ${err.message}`);
    scheduleWeatherRetry();
    return false;
  }
}

function getWeatherResponse() {
  const today = ymd(new Date());
  const now = Date.now();
  const isTodayAuto = weatherCache.date === today && weatherCache.updated;

  // ⓐ 3시간 이내 신선한 auto
  if (isTodayAuto && (now - weatherCache.updated) < 3 * 3600 * 1000) {
    return { ...weatherCache, source: 'auto', stale: false };
  }

  // ⓑ 오늘자 수동 (수동이 있으면 수동 우선)
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

  // ⓒ 같은 날짜의 오래된 auto (stale: true, ageMin 포함)
  if (isTodayAuto && (now - weatherCache.updated) >= 3 * 3600 * 1000) {
    const ageMin = Math.floor((now - weatherCache.updated) / 60000);
    return { ...weatherCache, source: 'auto', stale: true, ageMin };
  }

  // ⓓ none
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
// WD-70: 슬라이딩 만료 TTL 및 절대 상한 MAX_AGE (환경변수로 테스트 가변)
const TOKEN_TTL = Number(process.env.WD_TOKEN_TTL_MS) || (12 * 3600 * 1000);
const TOKEN_MAX_AGE = Number(process.env.WD_TOKEN_MAX_AGE_MS) || (24 * 3600 * 1000);

function authed(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const session = tokens.get(m[1]);
  if (!session) return false;
  const now = Date.now();
  const exp = typeof session === 'number' ? session : session.exp;
  const iat = (typeof session === 'object' && session && session.iat) ? session.iat : (exp - TOKEN_TTL);

  if (exp < now || (now - iat) >= TOKEN_MAX_AGE) {
    tokens.delete(m[1]);
    return false;
  }
  // 유효한 인증 요청마다 슬라이딩 연장 (단, 발급 시점 기준 TOKEN_MAX_AGE 절대 상한을 넘지 않음)
  const newExp = Math.min(now + TOKEN_TTL, iat + TOKEN_MAX_AGE);
  if (typeof session === 'object' && session) {
    session.exp = newExp;
  } else {
    tokens.set(m[1], { exp: newExp, iat });
  }
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
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
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
    const tomDate = new Date();
    tomDate.setDate(tomDate.getDate() + 1);
    const tomorrow = ymd(tomDate);
    const todayData = data.days[today] ? cleanDay(data.days[today]) : cleanDay();
    const todayRev = calcDayRev(todayData);
    const prevData = prev ? cleanDay(data.days[prev]) : null;
    const prevRev = prevData ? calcDayRev(prevData) : null;
    const tomorrowData = data.days[tomorrow] ? cleanDay(data.days[tomorrow]) : cleanDay();
    const tomorrowRev = calcDayRev(tomorrowData);
    return json(res, 200, {
      today,
      prev,
      tomorrow,
      todayData,
      todayRev,
      prevData,
      prevRev,
      tomorrowData,
      tomorrowRev,
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

  // WD-71: 오늘자 자동 날씨 슬롯 조회 (수동 입력 참고용)
  if (p === '/api/weather/auto' && req.method === 'GET') {
    const today = ymd(new Date());
    const now = Date.now();
    if (weatherCache.date === today && weatherCache.slots && weatherCache.slots.length > 0) {
      const ageMs = now - (weatherCache.updated || 0);
      const isStale = ageMs >= 3 * 3600 * 1000;
      const ageMin = Math.floor(ageMs / 60000);
      return json(res, 200, {
        slots: weatherCache.slots.map((s) => ({
          h: s.h,
          text: s.text,
          temp: s.temp,
          wind: s.wind,
        })),
        updated: weatherCache.updated,
        stale: isStale,
        ageMin: isStale ? ageMin : 0,
      });
    }
    return json(res, 200, { slots: [] });
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
    const rev = calcDayRev(result.day);
    return json(res, 200, { ...result, rev });
  }

  // --- 백업 점검 및 수동 백업 API (WD-66, 관리자 전용) ---
  if (p === '/api/backup/status' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { error: '관리자 로그인이 필요합니다' });
    return json(res, 200, getDetailedBackupStatus());
  }

  if (p === '/api/backup/now' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, { error: '관리자 로그인이 필요합니다' });
    return performManualBackup(res);
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return json(res, 429, { error: '잠시 후 다시 시도하세요' });
    const body = await readBody(req);
    const isAdmin = verifyPassword('admin', body.password);
    const isDev = !isAdmin && verifyDevKey(body.password);
    if (isAdmin || isDev) {
      fails.delete(ip);
      if (isDev) {
        console.log(`[보안] 개발자 키로 로그인됨 (IP ${ip}, 관리자)`);
      }
      const token = crypto.randomBytes(24).toString('hex');
      const now = Date.now();
      tokens.set(token, { exp: now + TOKEN_TTL, iat: now });
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
    let isDev = false;

    // 1. 관리자 토큰(adminToken)으로 사무실 쿠키 발급 시도
    if (body.adminToken && typeof body.adminToken === 'string') {
      const session = tokens.get(body.adminToken);
      const now = Date.now();
      const exp = typeof session === 'number' ? session : (session && session.exp);
      const iat = (typeof session === 'object' && session && session.iat) ? session.iat : ((exp || 0) - TOKEN_TTL);
      if (exp && exp >= now && (now - iat) < TOKEN_MAX_AGE) {
        passMatch = true;
      }
    }
    // 2. 비밀번호(password)로 사무실 쿠키 발급 시도 (사무실 비밀번호 또는 관리자 비밀번호 또는 개발자 키)
    if (!passMatch && body.password != null) {
      if (verifyPassword('office', body.password) || verifyPassword('admin', body.password)) {
        passMatch = true;
      } else if (verifyDevKey(body.password)) {
        passMatch = true;
        isDev = true;
      }
    }

    if (passMatch) {
      officeFails.delete(ip);
      if (isDev) {
        console.log(`[보안] 개발자 키로 로그인됨 (IP ${ip}, 사무실)`);
      }
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
    // WD-82: 관리자 전용 AI 엔드포인트는 비관리자(사무실 세션 등) 접근 시 403 차단
    if (p === '/api/ai-config' || p.startsWith('/api/ai/')) {
      if (!authed(req)) {
        return json(res, isOfficeAuthed(req) ? 403 : 401, { error: isOfficeAuthed(req) ? 'forbidden' : 'unauthorized' });
      }
    } else {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    }
    if (p === '/api/me') return json(res, 200, { ok: true });

    // WD-82: AI 설정 조회
    if (p === '/api/ai-config' && req.method === 'GET') {
      const cfg = loadAiConfig();
      return json(res, 200, getSafeAiConfig(cfg));
    }

    // WD-82: AI 설정 저장
    if (p === '/api/ai-config' && req.method === 'PUT') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '올바른 JSON 요청이 아닙니다.' });
      }
      const provider = body && body.provider;
      if (!AI_PROVIDERS.has(provider)) {
        return json(res, 400, { error: '올바르지 않은 provider입니다.' });
      }
      let baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      if (!baseUrl || (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://'))) {
        return json(res, 400, { error: 'baseUrl은 http:// 또는 https:// 로 시작해야 합니다.' });
      }
      if (baseUrl.length > 200) {
        return json(res, 400, { error: 'baseUrl은 200자 이하여야 합니다.' });
      }
      if (/[\s\x00-\x1f\x7f]/.test(baseUrl)) {
        return json(res, 400, { error: 'baseUrl에 공백이나 제어 문자가 포함될 수 없습니다.' });
      }
      baseUrl = baseUrl.replace(/\/+$/, '');

      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 100) : '';
      const vision = body.vision === true;

      const current = loadAiConfig();
      let apiKey = current.apiKey;
      if (body.apiKey === null) {
        apiKey = '';
      } else if (typeof body.apiKey === 'string') {
        const trimmed = body.apiKey.trim();
        if (trimmed !== '') {
          if (trimmed.length > 300) {
            return json(res, 400, { error: 'apiKey는 300자 이하여야 합니다.' });
          }
          apiKey = trimmed;
        }
      }

      const nextCfg = { provider, baseUrl, model, apiKey, vision };
      saveAiConfig(nextCfg);
      return json(res, 200, getSafeAiConfig(nextCfg));
    }

    // WD-82: AI 연결 테스트
    if (p === '/api/ai/test' && req.method === 'POST') {
      const cfg = loadAiConfig();
      const startMs = Date.now();
      const result = await callAiChatCompletions(cfg, [
        { role: 'user', content: 'Reply with OK only.' },
      ], { jsonMode: false });
      if (!result.ok) {
        return json(res, result.status, { error: result.error, message: result.message });
      }
      const latencyMs = Date.now() - startMs;
      return json(res, 200, { ok: true, latencyMs });
    }

    // WD-82: AI 작업일보 분석
    if (p === '/api/ai/parse' && req.method === 'POST') {
      if (aiParseInProgress) {
        return json(res, 429, { error: 'rate_limited', message: '이미 분석이 진행 중입니다. 잠시 후 다시 시도하세요.' });
      }

      let body;
      try {
        body = await readBody(req, 8 * 1024 * 1024);
      } catch (err) {
        if (err.message === 'too large') {
          return json(res, 400, { error: '본문 크기가 너무 큽니다 (최대 8MB).' });
        }
        return json(res, 400, { error: '올바른 JSON 요청이 아닙니다.' });
      }

      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const image = typeof body.image === 'string' ? body.image.trim() : '';
      const todayDate = (typeof body.todayDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.todayDate))
        ? body.todayDate
        : ymd(new Date());

      if (!text && !image) {
        return json(res, 400, { error: '분석할 텍스트 또는 이미지를 입력하세요.' });
      }
      if (text.length > 30000) {
        return json(res, 400, { error: '텍스트는 30,000자 이하여야 합니다.' });
      }

      if (image) {
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image);
        if (!match) {
          return json(res, 400, { error: '올바른 이미지 데이터(data:image/(png|jpeg|webp);base64,...)가 아닙니다.' });
        }
        const b64Data = match[2].replace(/[\r\n\s]/g, '');
        const approxBytes = Math.ceil(b64Data.length * 3 / 4);
        if (approxBytes > 5 * 1024 * 1024 + 1024) {
          return json(res, 400, { error: '이미지 크기는 5MB 이하여야 합니다.' });
        }
        let buf;
        try {
          buf = Buffer.from(b64Data, 'base64');
        } catch {
          return json(res, 400, { error: '이미지 디코드에 실패했습니다.' });
        }
        if (buf.length > 5 * 1024 * 1024) {
          return json(res, 400, { error: '이미지 크기는 5MB 이하여야 합니다.' });
        }
        if (buf.length === 0) {
          return json(res, 400, { error: '이미지 데이터가 비어있습니다.' });
        }
      }

      const cfg = loadAiConfig();
      if (image && !cfg.vision) {
        return json(res, 400, { error: 'vision_unsupported', message: '현재 설정된 AI 모델은 이미지 분석을 지원하지 않습니다.' });
      }

      // 유효성 검사 통과 후 분당 6회 제한 검사
      const clientKey = req.headers.authorization || req.socket.remoteAddress || 'unknown';
      if (!checkAiRateLimit(clientKey)) {
        return json(res, 429, { error: 'rate_limited', message: '분석 요청이 너무 빈번합니다 (분당 최대 6회). 잠시 후 다시 시도하세요.' });
      }

      const systemPrompt = `당신은 건설현장 작업일보 분석 전문가입니다. 주어진 작업일보 텍스트 및/또는 이미지에서 정보를 추출하여 대시보드 입력용 JSON 데이터를 생성하세요.

출력 규칙:
1. 반드시 유효한 JSON 객체 하나만 출력하세요. 마크다운 코드 블록(\`\`\` 등)이나 설명문은 절대 포함하지 마세요.
2. 출력 JSON 스키마:
{
  "today": {
    "work": [
      { "t": "작업 내용 (200자 이내)", "c": [ { "t": "세부/하위 내용", "c": [] } ] }
    ],
    "crew": [
      { "job": "직종명", "count": "인원수(숫자문자열)", "loc": "위치/구간", "direct": false }
    ],
    "equip": [
      { "name": "장비명", "qty": "대수(숫자문자열)", "spec": "규격", "loc": "위치/구간", "direct": false }
    ],
    "material": [
      { "kind": "품명", "spec": "규격", "qty": "수량(숫자문자열)", "unit": "단위", "use": "사용처/용도" }
    ],
    "notes": [
      { "t": "특이사항/안전사항 (200자 이내)" }
    ]
  } | null,
  "tomorrow": {
    "work": [ ... ],
    "crew": [ ... ],
    "equip": [ ... ],
    "material": [ ... ],
    "notes": [ ... ]
  } | null,
  "warnings": [
    "모호하거나 불확실한 항목에 대한 설명", ...
  ]
}
3. 금일/오늘/당일 내용은 today, 명일/내일/익일 내용은 tomorrow로 분류하세요. 구분이 없으면 전부 today로 분류하세요.
4. 원문에 없는 내용은 절대 지어내지 마세요. 모르는 정보는 비워두거나 warnings에 기록하세요.
5. 인원(count), 장비(qty), 자재(qty) 수량은 숫자로 된 문자열(예: "5", "1.5")이어야 합니다.
6. 작업 내용(work)의 계층 구조는 c 배열을 사용하여 표현하세요(최대 5단계). 항목당 200자 이내입니다.
7. 사람 이름, 전화번호, 서명 등 개인정보는 절대 추출하지 마세요(직종과 인원수만 추출).
8. 기준 일자(힌트): ${todayDate}`;

      const userContent = [];
      if (text) {
        userContent.push({ type: 'text', text });
      }
      if (image) {
        userContent.push({ type: 'image_url', image_url: { url: image } });
      }

      aiParseInProgress = true;
      try {
        const result = await callAiChatCompletions(cfg, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ], { jsonMode: true });

        if (!result.ok) {
          return json(res, result.status, { error: result.error, message: result.message });
        }

        const choice = result.data.choices && result.data.choices[0];
        const rawContent = choice && choice.message && choice.message.content;
        if (!rawContent || typeof rawContent !== 'string') {
          return json(res, 502, { error: 'ai_bad_output', message: 'AI 응답 본문이 비어있거나 올바르지 않습니다.' });
        }

        let cleanJsonStr = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let parsedObj = null;
        try {
          parsedObj = JSON.parse(cleanJsonStr);
        } catch {
          const firstBrace = cleanJsonStr.indexOf('{');
          const lastBrace = cleanJsonStr.lastIndexOf('}');
          if (firstBrace >= 0 && lastBrace > firstBrace) {
            try {
              parsedObj = JSON.parse(cleanJsonStr.slice(firstBrace, lastBrace + 1));
            } catch {}
          }
        }

        if (!parsedObj || typeof parsedObj !== 'object') {
          return json(res, 502, { error: 'ai_bad_output', message: 'AI 응답을 JSON으로 변환할 수 없습니다.' });
        }

        const today = (parsedObj.today && typeof parsedObj.today === 'object') ? cleanDay(parsedObj.today) : null;
        const tomorrow = (parsedObj.tomorrow && typeof parsedObj.tomorrow === 'object') ? cleanDay(parsedObj.tomorrow) : null;
        const warnings = Array.isArray(parsedObj.warnings)
          ? parsedObj.warnings.filter((w) => typeof w === 'string').map((w) => w.slice(0, 200)).slice(0, 20)
          : [];

        const responsePayload = {
          ok: true,
          today,
          tomorrow,
          warnings,
          model: cfg.model,
        };
        if (result.data.usage) {
          responsePayload.usage = {
            prompt_tokens: result.data.usage.prompt_tokens,
            completion_tokens: result.data.usage.completion_tokens,
            total_tokens: result.data.usage.total_tokens,
          };
        }
        return json(res, 200, responsePayload);
      } finally {
        aiParseInProgress = false;
      }
    }
    if (p === '/api/me') return json(res, 200, { ok: true });

    // WD-72: 작업일보 PDF 양식(템플릿) 목록 조회
    if (p === '/api/import-templates' && req.method === 'GET') {
      return json(res, 200, loadImportTemplates());
    }

    // WD-72: 작업일보 PDF 양식(템플릿) 저장/덮어쓰기
    let tm;
    if ((tm = /^\/api\/import-templates\/([a-z0-9-]{1,30})$/.exec(p)) && req.method === 'PUT') {
      const targetId = tm[1];
      const body = await readBody(req);
      const { error, template } = validateAndCleanTemplate(body, targetId);
      if (error) {
        return json(res, 400, { error });
      }
      const store = loadImportTemplates();
      const existingIdx = store.templates.findIndex((t) => t.id === targetId);
      if (existingIdx < 0 && store.templates.length >= 20) {
        return json(res, 400, { error: '템플릿은 최대 20개까지 등록 가능합니다.' });
      }
      if (existingIdx >= 0) {
        store.templates[existingIdx] = template;
      } else {
        store.templates.push(template);
      }
      saveImportTemplates(store);
      return json(res, 200, { ok: true, template });
    }

    // WD-72: 작업일보 PDF 양식(템플릿) 삭제
    if ((tm = /^\/api\/import-templates\/([a-z0-9-]{1,30})$/.exec(p)) && req.method === 'DELETE') {
      const targetId = tm[1];
      const store = loadImportTemplates();
      store.templates = store.templates.filter((t) => t.id !== targetId);
      saveImportTemplates(store);
      return json(res, 200, { ok: true });
    }

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
        clearWeatherRetry();
        fetchWeatherAuto().then(() => broadcast()).catch(() => { });
      } else {
        clearWeatherRetry();
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
      const targetDate = m[1];
      const today = ymd(new Date());
      const tomDate = new Date();
      tomDate.setDate(tomDate.getDate() + 1);
      const tomorrow = ymd(tomDate);

      if (targetDate > tomorrow) return json(res, 400, { error: 'future date' });
      const body = await readBody(req);
      const day = cleanDay(body);

      // WD-69: baseRev 검증 (X-Base-Rev 헤더 또는 쿼리 baseRev)
      const baseRev = (req.headers['x-base-rev'] || url.searchParams.get('baseRev') || '').trim();
      const currentDay = data.days[targetDate] ? cleanDay(data.days[targetDate]) : cleanDay();
      const currentRev = calcDayRev(currentDay);

      if (baseRev && baseRev !== currentRev) {
        return json(res, 409, { error: 'conflict', rev: currentRev, day: currentDay });
      }

      // WD-79: 내일 날짜(targetDate > today)를 비운 경우(isEmpty) data.days 에서 삭제하여 자정 이월 복사가 정상 동작하도록 처리
      if (targetDate > today && isEmpty(day)) {
        delete data.days[targetDate];
        if (db) {
          try {
            db.prepare('DELETE FROM days WHERE date = ?').run(targetDate);
          } catch (err) {
            console.warn('[경고] DB 내일 삭제 실패:', err.message);
          }
        }
        if (typeof daysSerializedCache !== 'undefined' && daysSerializedCache && daysSerializedCache.delete) {
          daysSerializedCache.delete(targetDate);
        }
        saveData();
        updateSuggestCache();
        broadcast();
        const emptyRev = calcDayRev(cleanDay());
        return json(res, 200, { ok: true, rev: emptyRev });
      }

      data.days[targetDate] = day;
      saveData();
      updateSuggestCache();
      broadcast();
      const newRev = calcDayRev(day);
      return json(res, 200, { ok: true, rev: newRev });
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
