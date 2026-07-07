const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const QUESTION_COUNT = 15;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'today.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const values = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  const y = values.year;
  const m = values.month;
  const d = values.day;
  const hh = values.hour;
  const mm = values.minute;
  const ss = values.second;
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function createDefaultSession(sessionNo) {
  return {
    sessionNo,
    period: sessionNo <= 3 ? '上午' : '下午',
    records: [1, 2, 3].map(candidateNo => ({
      candidateNo,
      questionNo: null,
      absent: false
    }))
  };
}

function createDefaultData() {
  return {
    date: getTodayString(),
    currentSession: 1,
    lastUpdatedAt: '',
    sessions: [1, 2, 3, 4, 5, 6].map(createDefaultSession)
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(createDefaultData(), null, 2), 'utf8');
  }
}

function normalizeData(data) {
  const today = getTodayString();
  if (!data || typeof data !== 'object') return createDefaultData();

  if (!data.date) data.date = today;
  if (!Array.isArray(data.sessions)) data.sessions = [];

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
        record = { candidateNo: c, questionNo: null, absent: false };
        session.records.push(record);
      }
      record.candidateNo = c;
      record.questionNo = record.questionNo === '' || record.questionNo === undefined ? null : record.questionNo;
      if (record.questionNo !== null) record.questionNo = Number(record.questionNo);
      record.absent = Boolean(record.absent);
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
    return normalizeData(JSON.parse(raw));
  } catch (error) {
    console.error('讀取 today.json 失敗，將重建預設資料：', error);
    const data = createDefaultData();
    writeData(data);
    return data;
  }
}

function writeData(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalizeData(data), null, 2), 'utf8');
}

function getSummary(data) {
  const counts = Array.from({ length: QUESTION_COUNT }, (_, index) => ({
    questionNo: index + 1,
    printCount: 0
  }));

  data.sessions.forEach(session => {
    session.records.forEach(record => {
      const q = Number(record.questionNo);
      if (!record.absent && q >= 1 && q <= QUESTION_COUNT) {
        counts[q - 1].printCount += 1;
      }
    });
  });

  return counts;
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

app.get('/', (req, res) => {
  res.redirect('/display');
});

app.get('/input', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'input.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/summary', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'summary.html'));
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ questionCount: QUESTION_COUNT })};`);
});

app.get('/api/state', (req, res) => {
  const data = readData();
  res.json({ data, summary: getSummary(data) });
});

app.post('/api/update-session', (req, res) => {
  const { sessionNo, records } = req.body;
  const sessionNumber = Number(sessionNo);

  if (!Number.isInteger(sessionNumber) || sessionNumber < 1 || sessionNumber > 6) {
    return res.status(400).json({ error: '場次必須是 1 到 6。' });
  }

  if (!Array.isArray(records) || records.length !== 3) {
    return res.status(400).json({ error: '每場次必須有 3 位考生資料。' });
  }

  try {
    const cleanRecords = records.map((record, index) => {
      const questionNo = record.questionNo === null || record.questionNo === '' ? null : Number(record.questionNo);
      const absent = Boolean(record.absent);

      if (!absent && (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > QUESTION_COUNT)) {
        throw new Error(`考生 ${index + 1} 到考時，題號必須是 1 到 ${QUESTION_COUNT}。`);
      }

      if (questionNo !== null && (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > QUESTION_COUNT)) {
        throw new Error(`考生 ${index + 1} 題號必須是 1 到 ${QUESTION_COUNT}。`);
      }

      return {
        candidateNo: index + 1,
        questionNo,
        absent
      };
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
  const sessionNo = Number(req.body.sessionNo);
  if (!Number.isInteger(sessionNo) || sessionNo < 1 || sessionNo > 6) {
    return res.status(400).json({ error: '場次必須是 1 到 6。' });
  }

  const data = readData();
  data.currentSession = sessionNo;
  data.lastUpdatedAt = formatDateTime();
  writeData(data);
  const summary = getSummary(data);
  broadcast({ type: 'state', data, summary });
  res.json({ ok: true, data, summary });
});

app.post('/api/reset', (req, res) => {
  const data = createDefaultData();
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
  console.log(`Exam system is running on port ${PORT}`);
});
