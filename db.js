const crypto = require('crypto');
const mysql = require('mysql2/promise');

function readBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

const config = {
  enabled: readBooleanEnv('DB_ENABLED', false),
  host: process.env.DB_HOST || 'mariadb',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'exam_system',
  user: process.env.DB_USER || 'exam_user',
  password: process.env.DB_PASSWORD || '',
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
  autoArchiveOnFinalSession: readBooleanEnv('AUTO_ARCHIVE_ON_FINAL_SESSION', true)
};

let pool = null;
let schemaPromise = null;

function isEnabled() {
  return config.enabled;
}

function isAutoArchiveEnabled() {
  return config.enabled && config.autoArchiveOnFinalSession;
}

function createDisabledError() {
  const error = new Error('MariaDB 歷史歸檔功能尚未啟用。');
  error.code = 'DB_DISABLED';
  return error;
}

function getPool() {
  if (!config.enabled) throw createDisabledError();
  if (!pool) {
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      waitForConnections: true,
      connectionLimit: Number.isInteger(config.connectionLimit) && config.connectionLimit > 0 ? config.connectionLimit : 5,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      charset: 'utf8mb4',
      timezone: '+08:00',
      dateStrings: true
    });
  }
  return pool;
}

async function initialize() {
  if (!config.enabled) return { enabled: false };
  if (!schemaPromise) {
    schemaPromise = initializeSchema().catch(error => {
      // 初始化失敗後清除 Promise，讓後續健康檢查或手動歸檔可以再次嘗試連線。
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
  return { enabled: true };
}

async function initializeSchema() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS exam_days (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      exam_date DATE NOT NULL,
      source_last_updated_at DATETIME NULL,
      archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archive_method VARCHAR(20) NOT NULL DEFAULT 'manual',
      question_count SMALLINT UNSIGNED NOT NULL,
      source_hash CHAR(64) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_exam_days_date (exam_date),
      KEY idx_exam_days_archived_at (archived_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS exam_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      exam_day_id BIGINT UNSIGNED NOT NULL,
      session_no TINYINT UNSIGNED NOT NULL,
      period VARCHAR(10) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_exam_sessions_day_session (exam_day_id, session_no),
      KEY idx_exam_sessions_session_no (session_no),
      CONSTRAINT fk_exam_sessions_day
        FOREIGN KEY (exam_day_id) REFERENCES exam_days(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS exam_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      exam_session_id BIGINT UNSIGNED NOT NULL,
      candidate_no TINYINT UNSIGNED NOT NULL,
      question_no SMALLINT UNSIGNED NULL,
      absent TINYINT(1) NOT NULL DEFAULT 0,
      abandoned TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_exam_records_session_candidate (exam_session_id, candidate_no),
      KEY idx_exam_records_question_no (question_no),
      KEY idx_exam_records_candidate_no (candidate_no),
      KEY idx_exam_records_absent (absent),
      KEY idx_exam_records_abandoned (abandoned),
      CONSTRAINT fk_exam_records_session
        FOREIGN KEY (exam_session_id) REFERENCES exam_sessions(id)
        ON DELETE CASCADE,
      CONSTRAINT chk_exam_records_status
        CHECK (NOT (absent = 1 AND abandoned = 1))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function buildArchiveSource(data) {
  return {
    date: String(data.date || ''),
    lastUpdatedAt: String(data.lastUpdatedAt || ''),
    sessions: (data.sessions || []).map(session => ({
      sessionNo: Number(session.sessionNo),
      period: String(session.period || ''),
      records: (session.records || []).map(record => ({
        candidateNo: Number(record.candidateNo),
        questionNo: record.questionNo === null || record.questionNo === undefined ? null : Number(record.questionNo),
        absent: Boolean(record.absent),
        abandoned: Boolean(record.abandoned)
      }))
    }))
  };
}

function getSourceHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(buildArchiveSource(data)), 'utf8').digest('hex');
}

function validateArchiveData(data, questionCount) {
  if (!data || typeof data !== 'object') throw new Error('沒有可歸檔的 JSON 資料。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) throw new Error('JSON 資料日期格式錯誤。');
  if (!Array.isArray(data.sessions) || data.sessions.length !== 6) throw new Error('歸檔資料必須包含 6 個場次。');

  for (const session of data.sessions) {
    if (!Array.isArray(session.records) || session.records.length !== 3) {
      throw new Error(`第 ${session.sessionNo || '-'} 場必須包含 3 個崗位。`);
    }
    for (const record of session.records) {
      const absent = Boolean(record.absent);
      const abandoned = absent ? false : Boolean(record.abandoned);
      const questionNo = record.questionNo === null || record.questionNo === undefined || record.questionNo === ''
        ? null
        : Number(record.questionNo);
      if (questionNo !== null && (!Number.isInteger(questionNo) || questionNo < 1 || questionNo > questionCount)) {
        throw new Error(`第 ${session.sessionNo} 場崗位 ${record.candidateNo} 的題號超出範圍。`);
      }
      if (absent && abandoned) throw new Error('缺席與棄考不可同時成立。');
    }
  }
}

async function archiveExamDay(data, options = {}) {
  if (!config.enabled) throw createDisabledError();
  const questionCount = Number(options.questionCount || 15);
  const method = String(options.method || 'manual').slice(0, 20);
  validateArchiveData(data, questionCount);
  await initialize();

  const sourceHash = getSourceHash(data);
  const db = getPool();
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [dayResult] = await connection.execute(`
      INSERT INTO exam_days
        (exam_date, source_last_updated_at, archived_at, archive_method, question_count, source_hash)
      VALUES (?, ?, NOW(), ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        source_last_updated_at = VALUES(source_last_updated_at),
        archived_at = NOW(),
        archive_method = VALUES(archive_method),
        question_count = VALUES(question_count),
        source_hash = VALUES(source_hash)
    `, [
      data.date,
      data.lastUpdatedAt || null,
      method,
      questionCount,
      sourceHash
    ]);

    const examDayId = Number(dayResult.insertId);

    // 每次歸檔以 JSON 為完整快照，先清除同一天的場次再重建，避免殘留舊資料。
    await connection.execute('DELETE FROM exam_sessions WHERE exam_day_id = ?', [examDayId]);

    for (const session of data.sessions) {
      const [sessionResult] = await connection.execute(`
        INSERT INTO exam_sessions (exam_day_id, session_no, period)
        VALUES (?, ?, ?)
      `, [examDayId, Number(session.sessionNo), String(session.period || '')]);

      const examSessionId = Number(sessionResult.insertId);
      for (const record of session.records) {
        const absent = Boolean(record.absent);
        const abandoned = absent ? false : Boolean(record.abandoned);
        const questionNo = record.questionNo === null || record.questionNo === undefined || record.questionNo === ''
          ? null
          : Number(record.questionNo);

        await connection.execute(`
          INSERT INTO exam_records
            (exam_session_id, candidate_no, question_no, absent, abandoned)
          VALUES (?, ?, ?, ?, ?)
        `, [examSessionId, Number(record.candidateNo), questionNo, absent ? 1 : 0, abandoned ? 1 : 0]);
      }
    }

    await connection.commit();
    return {
      ok: true,
      examDate: data.date,
      archivedAt: new Date().toISOString(),
      archiveMethod: method,
      sourceHash
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getArchiveStatus(data) {
  const base = {
    enabled: config.enabled,
    connected: false,
    archived: false,
    upToDate: false,
    examDate: data && data.date ? data.date : null,
    lastArchivedAt: null,
    archiveMethod: null,
    error: null
  };

  if (!config.enabled) return base;

  try {
    await initialize();
    const [rows] = await getPool().execute(`
      SELECT archived_at, archive_method, source_hash
      FROM exam_days
      WHERE exam_date = ?
      LIMIT 1
    `, [data.date]);

    const row = rows[0];
    return Object.assign(base, {
      connected: true,
      archived: Boolean(row),
      upToDate: Boolean(row) && String(row.source_hash) === getSourceHash(data),
      lastArchivedAt: row ? row.archived_at : null,
      archiveMethod: row ? row.archive_method : null
    });
  } catch (error) {
    return Object.assign(base, {
      error: error.message || 'MariaDB 連線失敗。'
    });
  }
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function percentage(count, total) {
  if (!total) return 0;
  return Number(((count / total) * 100).toFixed(2));
}

function createQuestionCounter(questionCount) {
  return Array.from({ length: questionCount }, (_, index) => ({
    questionNo: index + 1,
    count: 0,
    percentage: 0
  }));
}

async function getHistoryStatistics(startDate, endDate, questionCount = 15) {
  if (!config.enabled) throw createDisabledError();
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) throw new Error('請提供正確的開始與結束日期。');
  if (startDate > endDate) throw new Error('開始日期不可晚於結束日期。');
  await initialize();

  const [rows] = await getPool().execute(`
    SELECT
      DATE_FORMAT(d.exam_date, '%Y-%m-%d') AS exam_date,
      s.session_no,
      s.period,
      r.candidate_no,
      r.question_no,
      r.absent,
      r.abandoned
    FROM exam_days d
    INNER JOIN exam_sessions s ON s.exam_day_id = d.id
    INNER JOIN exam_records r ON r.exam_session_id = s.id
    WHERE d.exam_date BETWEEN ? AND ?
    ORDER BY d.exam_date, s.session_no, r.candidate_no
  `, [startDate, endDate]);

  const overall = createQuestionCounter(questionCount);
  const dailyMap = new Map();
  const candidateMap = new Map();
  const sessionMap = new Map();
  const archivedDays = new Set();
  let countedDraws = 0;
  let absentCount = 0;
  let abandonedCount = 0;

  for (let candidateNo = 1; candidateNo <= 3; candidateNo++) {
    candidateMap.set(candidateNo, { total: 0, rows: createQuestionCounter(questionCount) });
  }
  for (let sessionNo = 1; sessionNo <= 6; sessionNo++) {
    sessionMap.set(sessionNo, { total: 0, rows: createQuestionCounter(questionCount) });
  }

  const records = rows.map(row => {
    const examDate = String(row.exam_date);
    const sessionNo = Number(row.session_no);
    const candidateNo = Number(row.candidate_no);
    const questionNo = row.question_no === null ? null : Number(row.question_no);
    const absent = Boolean(row.absent);
    const abandoned = !absent && Boolean(row.abandoned);
    archivedDays.add(examDate);

    if (absent) absentCount += 1;
    if (abandoned) abandonedCount += 1;

    // 出題機率採「實際使用題目」口徑：缺席不計，棄考仍計入。
    if (!absent && Number.isInteger(questionNo) && questionNo >= 1 && questionNo <= questionCount) {
      countedDraws += 1;
      overall[questionNo - 1].count += 1;

      if (!dailyMap.has(examDate)) dailyMap.set(examDate, { total: 0, rows: createQuestionCounter(questionCount) });
      const daily = dailyMap.get(examDate);
      daily.total += 1;
      daily.rows[questionNo - 1].count += 1;

      const candidate = candidateMap.get(candidateNo);
      candidate.total += 1;
      candidate.rows[questionNo - 1].count += 1;

      const session = sessionMap.get(sessionNo);
      session.total += 1;
      session.rows[questionNo - 1].count += 1;
    }

    return {
      examDate,
      sessionNo,
      period: String(row.period || ''),
      candidateNo,
      questionNo,
      absent,
      abandoned,
      status: absent ? '缺席' : (abandoned ? '棄考' : (questionNo === null ? '未登錄' : '到考'))
    };
  });

  overall.forEach(item => { item.percentage = percentage(item.count, countedDraws); });

  const dailyQuestionRate = [];
  Array.from(dailyMap.keys()).sort().forEach(examDate => {
    const group = dailyMap.get(examDate);
    group.rows.forEach(item => {
      dailyQuestionRate.push({
        examDate,
        questionNo: item.questionNo,
        count: item.count,
        percentage: percentage(item.count, group.total)
      });
    });
  });

  const candidateQuestionRate = [];
  candidateMap.forEach((group, candidateNo) => {
    group.rows.forEach(item => {
      candidateQuestionRate.push({
        candidateNo,
        questionNo: item.questionNo,
        count: item.count,
        percentage: percentage(item.count, group.total)
      });
    });
  });

  const sessionQuestionRate = [];
  sessionMap.forEach((group, sessionNo) => {
    group.rows.forEach(item => {
      sessionQuestionRate.push({
        sessionNo,
        questionNo: item.questionNo,
        count: item.count,
        percentage: percentage(item.count, group.total)
      });
    });
  });

  return {
    range: { startDate, endDate },
    summary: {
      archivedDays: archivedDays.size,
      totalRecords: rows.length,
      countedDraws,
      absentCount,
      abandonedCount
    },
    overallQuestionRate: overall,
    dailyQuestionRate,
    candidateQuestionRate,
    sessionQuestionRate,
    records
  };
}

module.exports = {
  isEnabled,
  isAutoArchiveEnabled,
  initialize,
  archiveExamDay,
  getArchiveStatus,
  getHistoryStatistics
};
