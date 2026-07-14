const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const QUESTION_COUNT = 15;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DISPLAY_PASSWORD_LENGTH = 6;
const DISPLAY_PASSWORD_ROTATION_HOUR = 4;
const UPSTREAM_STATE_URL = process.env.UPSTREAM_STATE_URL || '';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'today.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

function getAdminAuthToken() {
  const password = getAdminPassword();
  if (!password) return '';
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(';');
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i].trim();
    if (!segment) continue;
    const equalIndex = segment.indexOf('=');
    if (equalIndex < 0) continue;
    const name = segment.slice(0, equalIndex).trim();
    const value = segment.slice(equalIndex + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function getAdminAuthCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.adminAuth || '';
}

function isAdminAuthenticated(req) {
  const expectedToken = getAdminAuthToken();
  if (!expectedToken) return true;
  return getAdminAuthCookie(req) === expectedToken;
}

function sanitizeNextPath(nextPath) {
  if (nextPath === '/input' || nextPath === '/summary') return nextPath;
  return '/input';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}

function renderLoginPage(nextPath, errorMessage) {
  const safeNext = sanitizeNextPath(nextPath);
  const safeError = errorMessage ? escapeHtml(errorMessage) : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>管理登入｜考場抽題系統</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="display-body">
  <div class="display-auth-shell">
    <div class="display-auth-card">
      <div class="display-auth-kicker">管理登入</div>
      <div class="display-auth-title">請輸入管理密碼</div>
      <div class="display-auth-note">密碼由 docker-compose.yml 的 ADMIN_PASSWORD 控制，重啟服務後更換。</div>
      ${safeError ? `<div class="display-auth-error" style="margin-top:12px;">${safeError}</div>` : ''}
      <form method="post" action="/auth/login" class="display-auth-form" style="margin-top:22px;">
        <input type="hidden" name="next" value="${safeNext}">
        <label for="adminPassword">密碼</label>
        <input id="adminPassword" name="password" class="display-auth-input" type="password" autocomplete="current-password" spellcheck="false" placeholder="輸入管理密碼">
        <div class="display-auth-actions"><button type="submit">登入</button></div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderDisplayAutoLoginPage(authState, errorMessage) {
  const safeStateJson = JSON.stringify(authState);
  const safeError = errorMessage ? `<div class="display-auth-error" style="margin-top:12px;">${escapeHtml(errorMessage)}</div>` : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登入中｜考場抽題系統</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="display-body">
  <div class="display-auth-shell">
    <div class="display-auth-card">
      <div class="display-auth-kicker">抽題顯示登入</div>
      <div class="display-auth-title">登入中，請稍候...</div>
      ${safeError}
    </div>
  </div>
  <script>
    (function() {
      var state = ${safeStateJson};
      try {
        localStorage.setItem('displayAuthState', JSON.stringify(state));
        location.replace('/display');
      } catch (error) {
        document.querySelector('.display-auth-card').insertAdjacentHTML('beforeend', '<div class="display-auth-error" style="margin-top:12px;">瀏覽器無法儲存登入狀態，請回到顯示頁手動登入。</div>');
      }
    })();
  </script>
</body>
</html>`;
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.secure ? 'https' : 'http');
  const host = req.get('host') || 'localhost:3000';
  return `${protocol}://${host}`;
}

function getDisplayLoginUrl(req, password) {
  return `${getRequestBaseUrl(req)}/display/login/${encodeURIComponent(password)}`;
}

function setAdminAuthCookie(res) {
  const token = getAdminAuthToken();
  if (!token) return;
  const maxAgeSeconds = 30 * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `adminAuth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

function clearAdminAuthCookie(res) {
  res.setHeader('Set-Cookie', 'adminAuth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTaipeiDateParts(date = new Date()) {
  const taipeiDate = new Date(date.getTime() + TAIPEI_OFFSET_MS);
  return {
    year: taipeiDate.getUTCFullYear(),
    month: taipeiDate.getUTCMonth() + 1,
    day: taipeiDate.getUTCDate(),
    hour: taipeiDate.getUTCHours(),
    minute: taipeiDate.getUTCMinutes(),
    second: taipeiDate.getUTCSeconds()
  };
}

function formatDateTime(date = new Date()) {
  const parts = getTaipeiDateParts(date);
  const y = parts.year;
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const hh = String(parts.hour).padStart(2, '0');
  const mm = String(parts.minute).padStart(2, '0');
  const ss = String(parts.second).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function getDisplayPasswordDayKey(date = new Date()) {
  const parts = getTaipeiDateParts(date);
  const businessDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (parts.hour < DISPLAY_PASSWORD_ROTATION_HOUR) businessDay.setUTCDate(businessDay.getUTCDate() - 1);
  return businessDay.toISOString().slice(0, 10);
}

function generateDisplayPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < DISPLAY_PASSWORD_LENGTH; i++) password += chars[crypto.randomInt(chars.length)];
  return password;
}

function ensureDisplayPassword(data, date = new Date()) {
  const dayKey = getDisplayPasswordDayKey(date);
  const hasValidPassword = typeof data.displayPassword === 'string' && data.displayPassword.length === DISPLAY_PASSWORD_LENGTH;
  const isCurrentDay = data.displayPasswordDayKey === dayKey;
  if (!hasValidPassword || !isCurrentDay) {
    data.displayPassword = generateDisplayPassword();
    data.displayPasswordDayKey = dayKey;
    data.displayPasswordGeneratedAt = formatDateTime(date);
    return true;
  }
  if (!data.displayPasswordGeneratedAt) {
    data.displayPasswordGeneratedAt = formatDateTime(date);
    return true;
  }
  return false;
}

function forceRotateDisplayPassword(data, date = new Date(), invalidateExistingCookies = false) {
  data.displayPassword = generateDisplayPassword();
  data.displayPasswordDayKey = getDisplayPasswordDayKey(date);
  data.displayPasswordGeneratedAt = formatDateTime(date);
  if (invalidateExistingCookies) {
    const currentVersion = Number(data.displayAuthVersion || 1);
    data.displayAuthVersion = String(Number.isFinite(currentVersion) ? currentVersion + 1 : 2);
  }
  return data;
}

function getNextDisplayPasswordRefreshDelay(date = new Date()) {
  const parts = getTaipeiDateParts(date);
  const nextRotationUtc = Date.UTC(parts.year, parts.month - 1, parts.day, DISPLAY_PASSWORD_ROTATION_HOUR, 0, 0) - TAIPEI_OFFSET_MS + (parts.hour >= DISPLAY_PASSWORD_ROTATION_HOUR ? 24 * 60 * 60 * 1000 : 0);
  return Math.max(0, nextRotationUtc - date.getTime());
}

function createDefaultSession(sessionNo) {
  return {
    sessionNo,
    period: sessionNo <= 3 ? '上午' : '下午',
    records: [1, 2, 3].map(candidateNo => ({ candidateNo, questionNo: null, absent: false, abandoned: false }))
  };
}

function createDefaultData() {
  return {
    date: getTodayString(),
    currentSession: 1,
    lastUpdatedAt: '',
    displayPassword: '',
    displayPasswordDayKey: '',
    displayPasswordGeneratedAt: '',
    displayAuthVersion: '1',
    sessions: [1, 2, 3, 4, 5, 6].map(createDefaultSession)
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(createDefaultData(), null, 2), 'utf8');
}

function normalizeRecordStatus(record) {
  record.absent = Boolean(record.absent);
  record.abandoned = Boolean(record.abandoned);
  if (record.absent) record.abandoned = false;
  return record;
}

function normalizeData(data) {
  const today = getTodayString();
  if (!data || typeof data !== 'object') return createDefaultData();
  if (!data.date) data.date = today;
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (typeof data.displayPassword !== 'string') data.displayPassword = '';
  if (typeof data.displayPasswordDayKey !== 'string') data.displayPasswordDayKey = '';
  if (typeof data.displayPasswordGeneratedAt !== 'string') data.displayPasswordGeneratedAt = '';
  if (typeof data.displayAuthVersion !== 'string' || !data.displayAuthVersion) data.displayAuthVersion = '1';

  for (let i = 1; i <= 6; i++) {
    let session = data.sessions.find(s => Number(s.sessionNo) === i);
    if (!session) {
      session = createDefaultSession(i);
      data.sessions.push(session);
    }
    session.sessionNo = i;
    session.period = i <= 3 ? '上午' : '下午';
    if (!Array.isArray(session.records)) session.records = [];
    for (let c = 1; c <= 3; c++) {
      let record = session.records.find(r => Number(r.candidateNo) === c);
      if (!record) {
        record = { candidateNo: c, questionNo: null, absent: false, abandoned: false };
        session.records.push(record);
      }
      record.candidateNo = c;
      record.questionNo = record.questionNo === '' || record.questionNo === undefined ? null : record.questionNo;
      if (record.questionNo !== null) record.questionNo = Number(record.questionNo);
      normalizeRecordStatus(record);
    }
    session.records.sort((a, b) => a.candidateNo - b.candidateNo);
    session.records = session.records.slice(0, 3);
  }

  data.sessions.sort((a, b) => a.sessionNo - b.sessionNo);
  data.sessions = data.sessions.slice(0, 6);
  const currentSession = Number(data.currentSession);
  data.currentSession = currentSession >= 1 && currentSession <= 6 ? currentSession : 1;
  if (!data.lastUpdatedAt) data.lastUpdatedAt = '';
  return data;
}

function readData() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = normalizeData(JSON.parse(raw));
    const changed = ensureDisplayPassword(data);
    if (changed) writeData(data);
    return data;
  } catch (error) {
    console.error('讀取 today.json 失敗，將重建預設資料：', error);
    const data = createDefaultData();
    ensureDisplayPassword(data);
    writeData(data);
    return data;
  }
}

function writeData(data) {
  ensureDataFile();
  const normalized = normalizeData(data);
  ensureDisplayPassword(normalized);
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2), 'utf8');
}

function refreshDisplayPassword(options = {}) {
  const date = options.date instanceof Date ? options.date : new Date();
  const data = readData();
  const before = JSON.stringify({
    displayPassword: data.displayPassword,
    displayPasswordDayKey: data.displayPasswordDayKey,
    displayPasswordGeneratedAt: data.displayPasswordGeneratedAt,
    displayAuthVersion: data.displayAuthVersion
  });
  let changed = false;
  if (options.force) {
    forceRotateDisplayPassword(data, date, Boolean(options.invalidateExistingCookies));
    changed = true;
  } else {
    changed = ensureDisplayPassword(data, date);
  }
  const after = JSON.stringify({
    displayPassword: data.displayPassword,
    displayPasswordDayKey: data.displayPasswordDayKey,
    displayPasswordGeneratedAt: data.displayPasswordGeneratedAt,
    displayAuthVersion: data.displayAuthVersion
  });
  if (changed || before !== after) {
    writeData(data);
    broadcast({ type: 'state', data, summary: getSummary(data) });
  }
  return data;
}

function mergeLiveStateWithLocalAuth(payload, localData) {
  const merged = payload && typeof payload === 'object' ? payload : {};
  const sourceData = merged.data && typeof merged.data === 'object' ? merged.data : {};
  const authSource = localData && typeof localData === 'object' ? localData : readData();
  merged.data = Object.assign({}, sourceData, {
    displayPassword: authSource.displayPassword || '',
    displayPasswordDayKey: authSource.displayPasswordDayKey || '',
    displayPasswordGeneratedAt: authSource.displayPasswordGeneratedAt || '',
    displayAuthVersion: authSource.displayAuthVersion || '1'
  });
  return merged;
}

function getSummary(data) {
  const counts = Array.from({ length: QUESTION_COUNT }, (_, index) => ({ questionNo: index + 1, printCount: 0 }));
  data.sessions.forEach(session => {
    session.records.forEach(record => {
      const q = Number(record.questionNo);
      if (!record.absent && q >= 1 && q <= QUESTION_COUNT) counts[q - 1].printCount += 1;
    });
  });
  return counts;
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

app.get('/', (req, res) => res.redirect('/display'));

app.get('/input', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Finput');
  res.sendFile(path.join(__dirname, 'public', 'input.html'));
});

app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

app.get('/display/login/:password', (req, res) => {
  const data = readData();
  const password = String(req.params.password || '');
  if (!data.displayPassword) return res.redirect('/display');
  if (password !== String(data.displayPassword)) {
    return res.status(403).send(renderDisplayAutoLoginPage({ expiresAt: 0, version: data.displayAuthVersion || '1' }, '登入連結已失效，請重新產生 QRCode。'));
  }
  return res.type('text/html').send(renderDisplayAutoLoginPage({
    expiresAt: Date.now() + (12 * 60 * 60 * 1000),
    version: data.displayAuthVersion || '1'
  }));
});

app.get('/summary', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Fsummary');
  res.sendFile(path.join(__dirname, 'public', 'summary.html'));
});

app.get('/auth', (req, res) => {
  if (isAdminAuthenticated(req)) return res.redirect(sanitizeNextPath(req.query.next));
  res.type('text/html');
  res.send(renderLoginPage(req.query.next, req.query.error));
});

app.post('/auth/login', (req, res) => {
  const nextPath = sanitizeNextPath(req.body.next);
  const password = String(req.body.password || '');
  const expectedPassword = getAdminPassword();
  if (!expectedPassword) return res.redirect(nextPath);
  if (password !== expectedPassword) return res.status(401).send(renderLoginPage(nextPath, '密碼錯誤，請重新輸入。'));
  setAdminAuthCookie(res);
  return res.redirect(nextPath);
});

app.post('/auth/logout', (req, res) => {
  clearAdminAuthCookie(res);
  res.redirect('/auth?next=%2Finput');
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ questionCount: QUESTION_COUNT, useLiveState: Boolean(UPSTREAM_STATE_URL) })};`);
});

app.get('/api/live-state', async (req, res) => {
  if (!UPSTREAM_STATE_URL) {
    const data = readData();
    return res.json({ data, summary: getSummary(data) });
  }
  try {
    const upstreamUrl = new URL('/api/state', UPSTREAM_STATE_URL).toString();
    const upstreamResponse = await fetch(upstreamUrl, { headers: { Accept: 'application/json' } });
    if (!upstreamResponse.ok) throw new Error(`上游狀態讀取失敗：${upstreamResponse.status}`);
    const payload = await upstreamResponse.json();
    const localData = readData();
    return res.json(mergeLiveStateWithLocalAuth(payload, localData));
  } catch (error) {
    console.error('讀取正式版資料失敗：', error);
    return res.status(502).json({ error: '讀取正式版資料失敗。' });
  }
});

app.get('/api/state', (req, res) => {
  const data = readData();
  res.json({ data, summary: getSummary(data) });
});

app.post('/api/refresh-display-password', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const invalidateExistingCookies = Boolean(req.body && req.body.invalidateExistingCookies);
  const data = refreshDisplayPassword({ force: true, invalidateExistingCookies });
  const summary = getSummary(data);
  res.json({ ok: true, data, summary });
});

app.get('/api/display-password-qr', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  try {
    const data = readData();
    const password = data.displayPassword || '';
    if (!password) return res.status(400).json({ error: '目前沒有可用的登入密碼。' });
    const loginUrl = getDisplayLoginUrl(req, password);
    const svg = await QRCode.toString(loginUrl, { type: 'svg', margin: 1, width: 280, color: { dark: '#111827', light: '#ffffff' } });
    res.type('image/svg+xml');
    res.set('Cache-Control', 'no-store');
    res.send(svg);
  } catch (error) {
    console.error('產生 QRCode 失敗：', error);
    res.status(500).json({ error: '產生 QRCode 失敗。' });
  }
});

app.post('/api/update-session', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const { sessionNo, records } = req.body;
  const sessionNumber = Number(sessionNo);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 1 || sessionNumber > 6) return res.status(400).json({ error: '場次必須是 1 到 6。' });
  if (!Array.isArray(records) || records.length !== 3) return res.status(400).json({ error: '每場次必須有 3 位考生資料。' });
  try {
    const cleanRecords = records.map((record, index) => {
      const questionNo = record.questionNo === null || record.questionNo === '' ? null : Number(record.questionNo);
      const absent = Boolean(record.absent);
      const abandoned = absent ? false : Boolean(record.abandoned);
      if (!absent && (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > QUESTION_COUNT)) throw new Error(`崗位 ${index + 1} 未標記缺席時，題號必須是 1 到 ${QUESTION_COUNT}。`);
      if (questionNo !== null && (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > QUESTION_COUNT)) throw new Error(`崗位 ${index + 1} 題號必須是 1 到 ${QUESTION_COUNT}。`);
      return { candidateNo: index + 1, questionNo, absent, abandoned };
    });
    const data = readData();
    const session = data.sessions.find(s => s.sessionNo === sessionNumber);
    session.records = cleanRecords;
    data.currentSession = sessionNumber;
    data.lastUpdatedAt = formatDateTime();
    writeData(data);
    const summary = getSummary(data);
    broadcast({ type: 'state', data, summary });
    res.json({ ok: true, data, summary });
  } catch (error) {
    res.status(400).json({ error: error.message || '更新失敗。' });
  }
});

app.post('/api/set-current-session', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const sessionNo = Number(req.body.sessionNo);
  if (!Number.isInteger(sessionNo) || sessionNo < 1 || sessionNo > 6) return res.status(400).json({ error: '場次必須是 1 到 6。' });
  const data = readData();
  data.currentSession = sessionNo;
  data.lastUpdatedAt = formatDateTime();
  writeData(data);
  const summary = getSummary(data);
  broadcast({ type: 'state', data, summary });
  res.json({ ok: true, data, summary });
});

app.post('/api/reset', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const existingData = readData();
  const data = createDefaultData();
  data.displayPassword = existingData.displayPassword;
  data.displayPasswordDayKey = existingData.displayPasswordDayKey;
  data.displayPasswordGeneratedAt = existingData.displayPasswordGeneratedAt;
  data.displayAuthVersion = existingData.displayAuthVersion;
  data.lastUpdatedAt = formatDateTime();
  writeData(data);
  const summary = getSummary(data);
  broadcast({ type: 'state', data, summary });
  res.json({ ok: true, data, summary });
});

wss.on('connection', ws => {
  const data = readData();
  ws.send(JSON.stringify({ type: 'state', data, summary: getSummary(data) }));
});

server.listen(PORT, () => {
  ensureDataFile();
  setTimeout(function scheduleDisplayPasswordRotation() {
    refreshDisplayPassword();
    setTimeout(scheduleDisplayPasswordRotation, getNextDisplayPasswordRefreshDelay());
  }, getNextDisplayPasswordRefreshDelay());
  console.log(`Exam system is running on port ${PORT}`);
});
