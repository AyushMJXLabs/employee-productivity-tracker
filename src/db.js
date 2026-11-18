const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

/**
 * Converts $1, $2... positional placeholders into SQLite ? placeholders,
 * duplicating arguments if any positional index is referenced multiple times.
 */
function toSqliteQuery(sql, params = []) {
  const expanded = [];
  const converted = sql.replace(/\$(\d+)/g, (_, idxStr) => {
    const idx = Number(idxStr) - 1;
    expanded.push(params[idx]);
    return '?';
  });
  return { sql: converted, params: expanded };
}

/**
 * Creates a unified async database client supporting PostgreSQL (DATABASE_URL)
 * and built-in Node SQLite (fallback for local or single-disk deployments).
 */
async function createDb(config) {
  const usePostgres = Boolean(config.databaseUrl);
  let driver;

  if (usePostgres) {
    const useSsl =
      !config.databaseUrl.includes('localhost') &&
      !config.databaseUrl.includes('127.0.0.1') &&
      process.env.PGSSLMODE !== 'disable';

    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });

    driver = {
      type: 'postgres',
      async query(sql, params = []) {
        const res = await pool.query(sql, params);
        return res.rows;
      },
      async get(sql, params = []) {
        const res = await pool.query(sql, params);
        return res.rows[0] || null;
      },
      async run(sql, params = []) {
        const res = await pool.query(sql, params);
        return { rowCount: res.rowCount, rows: res.rows };
      },
      async close() {
        await pool.end();
      },
    };
  } else {
    const { DatabaseSync } = require('node:sqlite');
    if (config.sqlitePath !== ':memory:') {
      const dir = path.dirname(path.resolve(config.sqlitePath));
      fs.mkdirSync(dir, { recursive: true });
    }
    const sqlite = new DatabaseSync(config.sqlitePath);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    if (config.sqlitePath !== ':memory:') {
      sqlite.exec('PRAGMA journal_mode = WAL;');
    }

    driver = {
      type: 'sqlite',
      async query(sql, params = []) {
        const q = toSqliteQuery(sql, params);
        return sqlite.prepare(q.sql).all(...q.params);
      },
      async get(sql, params = []) {
        const q = toSqliteQuery(sql, params);
        return sqlite.prepare(q.sql).get(...q.params) || null;
      },
      async run(sql, params = []) {
        const q = toSqliteQuery(sql, params);
        const stmt = sqlite.prepare(q.sql);
        if (/\bRETURNING\b/i.test(q.sql)) {
          const rows = stmt.all(...q.params);
          return { rowCount: rows.length, rows };
        }
        const info = stmt.run(...q.params);
        return { rowCount: info.changes, rows: [] };
      },
      async close() {
        sqlite.close();
      },
    };
  }

  await initSchema(driver, config);
  return driver;
}

async function initSchema(db, config) {
  const idCol =
    db.type === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  await db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id ${idCol},
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('boss', 'employee')),
      is_active INTEGER NOT NULL DEFAULT 1,
      token_version INTEGER NOT NULL DEFAULT 1,
      reset_requested_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Safe migration for existing databases created before reset_requested_at existed
  if (db.type === 'postgres') {
    await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_requested_at TEXT');
  } else {
    const cols = await db.query('PRAGMA table_info(users)');
    if (!cols.some((c) => c.name === 'reset_requested_at')) {
      await db.run('ALTER TABLE users ADD COLUMN reset_requested_at TEXT');
    }
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS work_logs (
      id ${idCol},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      person_name TEXT NOT NULL,
      project TEXT NOT NULL,
      work_done TEXT NOT NULL,
      logged_at TEXT NOT NULL
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_work_logs_user_logged
    ON work_logs (user_id, logged_at DESC)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_work_logs_logged
    ON work_logs (logged_at DESC)
  `);

  // Seed initial team invite code if none exists yet
  const existingCode = await db.get(
    'SELECT value FROM settings WHERE key = $1',
    ['team_invite_code']
  );
  if (!existingCode) {
    await db.run('INSERT INTO settings (key, value) VALUES ($1, $2)', [
      'team_invite_code',
      config.teamInviteCode,
    ]);
  }

  // Seed initial boss account if BOSS_EMAIL + BOSS_PASSWORD are set and no boss exists
  if (config.bossEmail && config.bossPassword) {
    const bossRow = await db.get(
      "SELECT id FROM users WHERE role = 'boss' LIMIT 1"
    );
    if (!bossRow) {
      const passwordHash = await bcrypt.hash(config.bossPassword, 10);
      await db.run(
        `INSERT INTO users (name, email, password_hash, role, is_active, token_version, created_at)
         VALUES ($1, $2, $3, 'boss', 1, 1, $4)`,
        [config.bossName || 'Internship Lead', config.bossEmail, passwordHash, new Date().toISOString()]
      );
      console.log(`[db] Seeded initial boss account: ${config.bossEmail}`);
    } else if (process.env.BOSS_FORCE_PASSWORD_RESET === 'true') {
      const passwordHash = await bcrypt.hash(config.bossPassword, 10);
      await db.run(
        `UPDATE users
         SET password_hash = $1, token_version = token_version + 1, reset_requested_at = NULL
         WHERE id = $2`,
        [passwordHash, bossRow.id]
      );
      console.log('[db] Reset boss password via BOSS_FORCE_PASSWORD_RESET.');
    }
  }
}

module.exports = { createDb };
