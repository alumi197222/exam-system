const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const historyDb = require('./db');

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
  for (const part of cookieHeader.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const equalIndex = segment.indexOf('=');
    if (equalIndex < 0) continue;
    cookies[segment.slice(0, equalIndex).trim()] = decodeURIComponent(segment.slice(equalIndex + 1).trim());
  }
  return cookies;
}

function isAdminAuthenticated(req) {
  const expectedToken = getAdminAuthToken();
  if (!expectedToken) return true;
  return (parseCookies(req.headers.cookie).adminAuth || '') === expectedToken;
}

function sanitizeNextPath(nextPath) {
  if (nextPath === '/input' || nextPath === '/summary' || nextPath === '/summary2' || nextPath === '/history' || nextPath === '/backfill') return nextPath;
  return '/input';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
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
      <div class="display-auth-note">密碼由 docker-compose.yml 的 ADMIN_PASSWORD 控制。</div>
      ${safeError ? `<div class="display-auth-error" style="margin-top:12px;">${safeError}</div>` : ''}
      <form method="post" action="/auth/login" class="display-auth-form">
        <input type="hidden" name="next" value="${safeNext}">
        <label for="adminPassword">密碼</label>
        <input id="adminPassword" name="password" class="display-auth-input" type="password" autocomplete="current-password" placeholder="輸入管理密碼">
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
  <div class="display-auth-shell"><div class="display-auth-card">
    <div class="display-auth-kicker">抽題顯示登入</div>
    <div class="display-auth-title">登入中，請稍候...</div>${safeError}
  </div></div>
  <script>
    (function() {
      try {
        localStorage.setItem('displayAuthState', JSON.stringify(${safeStateJson}));
        location.replace('/display');
      } catch (error) {
        document.querySelector('.display-auth-card').insertAdjacentHTML('beforeend', '<div class="display-auth-error">瀏覽器無法儲存登入狀態。</div>');
      }
    })();
  </script>
</body>
</html>`;
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.secure ? 'https' : 'http');
  return `${protocol}://${req.get('host') || 'localhost:3000'}`;
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
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
  const p = getTaipeiDateParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

function getDisplayPasswordDayKey(date = new Date()) {
  const p = getTaipeiDateParts(date);
  const businessDay = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour < DISPLAY_PASSWORD_ROTATION_HOUR) businessDay.setUTCDate(businessDay.getUTCDate() - 1);
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
  const valid = typeof data.displayPassword === 'string' && data.displayPassword.length === DISPLAY_PASSWORD_LENGTH;
  if (!valid || data.displayPasswordDayKey !== dayKey) {
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

function forceRotateDisplayPassword(data, invalidateExistingCookies) {
  data.displayPassword = generateDisplayPassword();
  data.displayPasswordDayKey = getDisplayPasswordDayKey();
  data.displayPasswordGeneratedAt = formatDateTime();
  if (invalidateExistingCookies) {
    const version = Number(data.displayAuthVersion || 1);
    data.displayAuthVersion = String(Number.isFinite(version) ? version + 1 : 2);
  }
}

function getNextDisplayPasswordRefreshDelay(date = new Date()) {
  const p = getTaipeiDateParts(date);
  const nextRotationUtc = Date.UTC(p.year, p.month - 1, p.day, DISPLAY_PASSWORD_ROTATION_HOUR, 0, 0)
    - TAIPEI_OFFSET_MS
    + (p.hour >= DISPLAY_PASSWORD_ROTATION_HOUR ? 24 * 60 * 60 * 1000 : 0);
  return Math.max(0, nextRotationUtc - date.getTime());
}

function createDefaultSession(sessionNo) {
  return {
    sessionNo,
    period: sessionNo <= 3 ? '上午' : '下午',
    records: [1, 2, 3].map(candidateNo => ({
      candidateNo,
      questionNo: null,
      absent: false,
      abandoned: false
    }))
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

function normalizeData(data) {
  if (!data || typeof data !== 'object') return createDefaultData();
  if (!data.date) data.date = getTodayString();
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (typeof data.displayPassword !== 'string') data.displayPassword = '';
  if (typeof data.displayPasswordDayKey !== 'string') data.displayPasswordDayKey = '';
  if (typeof data.displayPasswordGeneratedAt !== 'string') data.displayPasswordGeneratedAt = '';
  if (typeof data.displayAuthVersion !== 'string' || !data.displayAuthVersion) data.displayAuthVersion = '1';

  for (let i = 1; i <= 6; i++) {
    let session = data.sessions.find(item => Number(item.sessionNo) === i);
    if (!session) {
      session = createDefaultSession(i);
      data.sessions.push(session);
    }
    session.sessionNo = i;
    session.period = i <= 3 ? '上午' : '下午';
    if (!Array.isArray(session.records)) session.records = [];

    for (let candidateNo = 1; candidateNo <= 3; candidateNo++) {
      let record = session.records.find(item => Number(item.candidateNo) === candidateNo);
      if (!record) {
        record = { candidateNo, questionNo: null, absent: false, abandoned: false };
        session.records.push(record);
      }
      record.candidateNo = candidateNo;
      record.questionNo = record.questionNo === '' || record.questionNo === undefined ? null : record.questionNo;
      if (record.questionNo !== null) record.questionNo = Number(record.questionNo);
      record.absent = Boolean(record.absent);
      record.abandoned = record.absent ? false : Boolean(record.abandoned);
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
    const data = normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    if (ensureDisplayPassword(data)) writeData(data);
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

function getSummary(data) {
  const counts = Array.from({ length: QUESTION_COUNT }, (_, index) => ({ questionNo: index + 1, printCount: 0 }));
  for (const session of data.sessions) {
    for (const record of session.records) {
      const questionNo = Number(record.questionNo);
      if (!record.absent && questionNo >= 1 && questionNo <= QUESTION_COUNT) counts[questionNo - 1].printCount += 1;
    }
  }
  return counts;
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

async function tryAutoArchive(data) {
  if (!historyDb.isAutoArchiveEnabled()) return;
  try {
    await historyDb.archiveExamDay(data, { questionCount: QUESTION_COUNT, method: 'automatic' });
    console.log(`已自動歸檔 ${data.date} 的考試資料。`);
  } catch (error) {
    console.error('自動歸檔失敗，當日 JSON 作業仍可繼續：', error.message || error);
  }
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function createArchiveDataFromRequest(body) {
  const examDate = String(body && body.date ? body.date : '');
  if (!isDateString(examDate)) throw new Error('請選擇要補登的日期。');

  const inputSessions = Array.isArray(body.sessions) ? body.sessions : [];
  const sessions = [1, 2, 3, 4, 5, 6].map(sessionNo => {
    const inputSession = inputSessions.find(item => Number(item.sessionNo) === sessionNo) || {};
    const inputRecords = Array.isArray(inputSession.records) ? inputSession.records : [];

    return {
      sessionNo,
      period: sessionNo <= 3 ? '上午' : '下午',
      records: [1, 2, 3].map(candidateNo => {
        const inputRecord = inputRecords.find(item => Number(item.candidateNo) === candidateNo) || {};
        const questionNo = inputRecord.questionNo === null || inputRecord.questionNo === undefined || inputRecord.questionNo === ''
          ? null
          : Number(inputRecord.questionNo);
        const absent = Boolean(inputRecord.absent);
        const abandoned = absent ? false : Boolean(inputRecord.abandoned);
        return { candidateNo, questionNo, absent, abandoned };
      })
    };
  });

  return {
    date: examDate,
    currentSession: 1,
    lastUpdatedAt: formatDateTime(),
    displayPassword: '',
    displayPasswordDayKey: '',
    displayPasswordGeneratedAt: '',
    displayAuthVersion: '1',
    sessions
  };
}

function normalizeUpdateRecords(records) {
  if (!Array.isArray(records) || records.length !== 3) {
    throw new Error('每場次必須送出 3 個崗位資料。');
  }

  let hasAnyInput = false;
  const cleanRecords = records.map((record, index) => {
    const candidateNo = index + 1;
    const rawQuestion = record && record.questionNo;
    const questionNo = rawQuestion === null || rawQuestion === undefined || rawQuestion === '' ? null : Number(rawQuestion);
    const absent = Boolean(record && record.absent);
    const abandoned = absent ? false : Boolean(record && record.abandoned);

    if (questionNo !== null && (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > QUESTION_COUNT)) {
      throw new Error(`崗位 ${candidateNo} 題號必須是 1 到 ${QUESTION_COUNT}。`);
    }

    if (abandoned && questionNo === null) {
      throw new Error(`崗位 ${candidateNo} 勾選棄考時，仍需輸入抽到的題號。`);
    }

    if (absent || abandoned || questionNo !== null) hasAnyInput = true;
    return { candidateNo, questionNo, absent, abandoned };
  });

  if (!hasAnyInput) throw new Error('至少需要輸入一個崗位資料才可以送出。');
  return cleanRecords;
}

app.get('/', (req, res) => res.redirect('/display'));

app.get('/input', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Finput');
  res.sendFile(path.join(__dirname, 'public', 'input.html'));
});

app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

app.get('/summary', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Fsummary');
  res.sendFile(path.join(__dirname, 'public', 'summary.html'));
});

app.get('/summary2', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Fsummary2');
  res.sendFile(path.join(__dirname, 'public', 'summary2.html'));
});

app.get('/history', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Fhistory');
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/backfill', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/auth?next=%2Fbackfill');
  res.sendFile(path.join(__dirname, 'public', 'backfill.html'));
});

app.get('/display/login/:password', (req, res) => {
  const data = readData();
  const password = String(req.params.password || '');
  if (!data.displayPassword) return res.redirect('/display');
  if (password !== String(data.displayPassword)) {
    return res.status(403).send(renderDisplayAutoLoginPage({ expiresAt: 0, version: data.displayAuthVersion || '1' }, '登入連結已失效，請重新產生 QRCode。'));
  }
  return res.type('text/html').send(renderDisplayAutoLoginPage({
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    version: data.displayAuthVersion || '1'
  }));
});

app.get('/auth', (req, res) => {
  if (isAdminAuthenticated(req)) return res.redirect(sanitizeNextPath(req.query.next));
  res.type('text/html').send(renderLoginPage(req.query.next, req.query.error));
});

app.post('/auth/login', (req, res) => {
  const nextPath = sanitizeNextPath(req.body.next);
  const expectedPassword = getAdminPassword();
  if (!expectedPassword) return res.redirect(nextPath);
  if (String(req.body.password || '') !== expectedPassword) {
    return res.status(401).send(renderLoginPage(nextPath, '密碼錯誤，請重新輸入。'));
  }
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
  res.send(`window.APP_CONFIG = ${JSON.stringify({
    questionCount: QUESTION_COUNT,
    useLiveState: Boolean(UPSTREAM_STATE_URL),
    dbEnabled: historyDb.isEnabled()
  })};`);
});

app.get('/api/state', (req, res) => {
  const data = readData();
  res.json({ data, summary: getSummary(data) });
});

app.get('/api/live-state', async (req, res) => {
  if (!UPSTREAM_STATE_URL) {
    const data = readData();
    return res.json({ data, summary: getSummary(data) });
  }
  try {
    const upstreamResponse = await fetch(new URL('/api/state', UPSTREAM_STATE_URL), { headers: { Accept: 'application/json' } });
    if (!upstreamResponse.ok) throw new Error(`上游狀態讀取失敗：${upstreamResponse.status}`);
    const payload = await upstreamResponse.json();
    const local = readData();
    payload.data = Object.assign({}, payload.data || {}, {
      displayPassword: local.displayPassword,
      displayPasswordDayKey: local.displayPasswordDayKey,
      displayPasswordGeneratedAt: local.displayPasswordGeneratedAt,
      displayAuthVersion: local.displayAuthVersion
    });
    return res.json(payload);
  } catch (error) {
    console.error('讀取正式版資料失敗：', error);
    return res.status(502).json({ error: '讀取正式版資料失敗。' });
  }
});

app.post('/api/update-session', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const sessionNumber = Number(req.body.sessionNo);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 1 || sessionNumber > 6) return res.status(400).json({ error: '場次必須是 1 到 6。' });

  try {
    const cleanRecords = normalizeUpdateRecords(req.body.records);
    const data = readData();
    const session = data.sessions.find(item => Number(item.sessionNo) === sessionNumber);
    session.records = cleanRecords;
    data.currentSession = sessionNumber;
    data.lastUpdatedAt = formatDateTime();
    writeData(data);

    const summary = getSummary(data);
    broadcast({ type: 'state', data, summary });
    res.json({ ok: true, data, summary });

    if (sessionNumber === 6) void tryAutoArchive(data);
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

app.post('/api/refresh-display-password', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const data = readData();
  forceRotateDisplayPassword(data, Boolean(req.body && req.body.invalidateExistingCookies));
  writeData(data);
  const summary = getSummary(data);
  broadcast({ type: 'state', data, summary });
  res.json({ ok: true, data, summary });
});

app.get('/api/display-password-qr', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  try {
    const data = readData();
    if (!data.displayPassword) return res.status(400).json({ error: '目前沒有可用的登入密碼。' });
    const loginUrl = `${getRequestBaseUrl(req)}/display/login/${encodeURIComponent(data.displayPassword)}`;
    const svg = await QRCode.toString(loginUrl, { type: 'svg', margin: 1, width: 280 });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (error) {
    res.status(500).json({ error: '產生 QRCode 失敗。' });
  }
});

app.get('/api/archive-status', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  res.json(await historyDb.getArchiveStatus(readData()));
});

app.post('/api/archive-today', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  try {
    const result = await historyDb.archiveExamDay(readData(), { questionCount: QUESTION_COUNT, method: 'manual' });
    res.json(result);
  } catch (error) {
    res.status(error.code === 'DB_DISABLED' ? 503 : 500).json({ error: error.message || '寫入 MariaDB 失敗。JSON 資料仍保留。' });
  }
});

app.post('/api/history/backfill', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  try {
    const archiveData = createArchiveDataFromRequest(req.body || {});
    const result = await historyDb.archiveExamDay(archiveData, { questionCount: QUESTION_COUNT, method: 'backfill' });
    res.json(result);
  } catch (error) {
    res.status(error.code === 'DB_DISABLED' ? 503 : 400).json({ error: error.message || '補登歷史資料失敗。' });
  }
});

app.get('/api/history/statistics', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  try {
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    res.json(await historyDb.getHistoryStatistics(start, end, QUESTION_COUNT));
  } catch (error) {
    res.status(error.code === 'DB_DISABLED' ? 503 : 400).json({ error: error.message || '歷史統計查詢失敗。' });
  }
});

app.post('/api/reset', (req, res) => {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ error: '請先登入管理密碼。' });
  const existing = readData();
  const data = createDefaultData();
  data.displayPassword = existing.displayPassword;
  data.displayPasswordDayKey = existing.displayPasswordDayKey;
  data.displayPasswordGeneratedAt = existing.displayPasswordGeneratedAt;
  data.displayAuthVersion = existing.displayAuthVersion;
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

  historyDb.initialize()
    .then(result => console.log(result.enabled ? 'MariaDB 歷史歸檔已啟用。' : 'MariaDB 歷史歸檔未啟用。'))
    .catch(error => console.error('MariaDB 初始化失敗，JSON 作業仍可使用：', error.message || error));

  setTimeout(function scheduleRotation() {
    const data = readData();
    if (ensureDisplayPassword(data)) {
      writeData(data);
      broadcast({ type: 'state', data, summary: getSummary(data) });
    }
    setTimeout(scheduleRotation, getNextDisplayPasswordRefreshDelay());
  }, getNextDisplayPasswordRefreshDelay());

  console.log(`Exam system is running on port ${PORT}`);
});
