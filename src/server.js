require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const { loadConfig } = require('./config');
const { createDb } = require('./db');
const {
  safeEqualStrings,
  setSessionCookie,
  clearSessionCookie,
  createAuthMiddleware,
} = require('./auth');

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160;
}

function escapeCsvCell(value) {
  let str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatTimestampWithOffset(isoString, tzOffsetMinutes) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  if (!Number.isFinite(tzOffsetMinutes)) {
    return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
  // JS getTimezoneOffset() returns (UTC - local) in minutes, e.g., -330 for IST (+05:30)
  const localMs = date.getTime() - tzOffsetMinutes * 60 * 1000;
  const local = new Date(localMs);
  return local.toISOString().replace('T', ' ').slice(0, 19);
}

function buildLogsFilter(req) {
  const conditions = [];
  const params = [];
  const push = (val) => {
    params.push(val);
    return `$${params.length}`;
  };

  // STRICT ISOLATION: Employees can ONLY ever query their own user_id.
  if (req.user.role !== 'boss') {
    conditions.push(`user_id = ${push(req.user.id)}`);
  } else if (req.query.userId) {
    const uid = Number(req.query.userId);
    if (Number.isInteger(uid) && uid > 0) {
      conditions.push(`user_id = ${push(uid)}`);
    }
  }

  const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
  if (project) {
    conditions.push(`project = ${push(project)}`);
  }

  const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  if (from && !Number.isNaN(Date.parse(from))) {
    conditions.push(`logged_at >= ${push(new Date(from).toISOString())}`);
  }

  const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
  if (to && !Number.isNaN(Date.parse(to))) {
    conditions.push(`logged_at <= ${push(new Date(to).toISOString())}`);
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  if (search) {
    const patternRef = push(`%${search}%`);
    if (req.user.role === 'boss') {
      conditions.push(
        `(LOWER(person_name) LIKE ${patternRef} OR LOWER(project) LIKE ${patternRef} OR LOWER(work_done) LIKE ${patternRef})`
      );
    } else {
      conditions.push(`(LOWER(project) LIKE ${patternRef} OR LOWER(work_done) LIKE ${patternRef})`);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

function createApp(db, config) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const { attachUser, requireAuth, requireBoss } = createAuthMiddleware(db, config);
  app.use(attachUser);

  // Health & public app metadata (never returns any user list or log data)
  app.get('/api/health', async (_req, res, next) => {
    try {
      await db.get('SELECT 1 AS ok');
      res.json({ ok: true, db: db.type });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/auth/status', async (req, res, next) => {
    try {
      const bossRow = await db.get("SELECT id FROM users WHERE role = 'boss' LIMIT 1");
      res.json({
        appTitle: config.appTitle,
        authenticated: Boolean(req.user),
        user: req.user,
        needsBossSetup: !bossRow,
      });
    } catch (err) {
      next(err);
    }
  });

  // One-time initial Boss setup (only when no Boss exists yet)
  app.post('/api/auth/setup-boss', async (req, res, next) => {
    try {
      const existingBoss = await db.get("SELECT id FROM users WHERE role = 'boss' LIMIT 1");
      if (existingBoss) {
        return res.status(403).json({ error: 'Executive account already configured.' });
      }

      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please provide a valid work email address.' });
      }
      if (password.length < 6 || password.length > 128) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const existingEmail = await db.get('SELECT id FROM users WHERE email = $1', [email]);
      if (existingEmail) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const inserted = await db.run(
        `INSERT INTO users (name, email, password_hash, role, is_active, token_version, created_at)
         VALUES ($1, $2, $3, 'boss', 1, 1, $4)
         RETURNING id, name, email, role, token_version, created_at`,
        [name, email, passwordHash, new Date().toISOString()]
      );
      const user = inserted.rows[0];
      setSessionCookie(res, user, config);

      return res.status(201).json({
        user: {
          id: Number(user.id),
          name: user.name,
          email: user.email,
          role: user.role,
          createdAt: user.created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Employee self-registration using the private Team Invite Code
  app.post('/api/auth/register', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const inviteCode = String(req.body?.inviteCode || '').trim();

      const setting = await db.get('SELECT value FROM settings WHERE key = $1', [
        'team_invite_code',
      ]);
      const expectedCode = setting?.value || config.teamInviteCode;
      if (!inviteCode || !safeEqualStrings(inviteCode, expectedCode, config.sessionSecret)) {
        return res.status(403).json({ error: 'Invalid team invite code.' });
      }

      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ error: 'Full name must be between 2 and 80 characters.' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
      if (password.length < 6 || password.length > 128) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const existing = await db.get('SELECT id FROM users WHERE email = $1', [email]);
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const inserted = await db.run(
        `INSERT INTO users (name, email, password_hash, role, is_active, token_version, created_at)
         VALUES ($1, $2, $3, 'employee', 1, 1, $4)
         RETURNING id, name, email, role, token_version, created_at`,
        [name, email, passwordHash, new Date().toISOString()]
      );
      const user = inserted.rows[0];
      setSessionCookie(res, user, config);

      return res.status(201).json({
        user: {
          id: Number(user.id),
          name: user.name,
          email: user.email,
          role: user.role,
          createdAt: user.created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const user = await db.get(
        'SELECT id, name, email, password_hash, role, is_active, token_version, created_at FROM users WHERE email = $1',
        [email]
      );

      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (Number(user.is_active) !== 1) {
        return res.status(403).json({ error: 'This account has been deactivated. Contact your lead.' });
      }

      await db.run('UPDATE users SET reset_requested_at = NULL WHERE id = $1', [user.id]);

      setSessionCookie(res, user, config);
      return res.json({
        user: {
          id: Number(user.id),
          name: user.name,
          email: user.email,
          role: user.role,
          createdAt: user.created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Request a password reset (flagged for the Boss in Team & Access; never leaks email existence)
  app.post('/api/auth/forgot-password', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const inviteCode = String(req.body?.inviteCode || '').trim();

      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please enter a valid work email address.' });
      }

      const setting = await db.get('SELECT value FROM settings WHERE key = $1', [
        'team_invite_code',
      ]);
      const expectedCode = setting?.value || config.teamInviteCode;
      if (!inviteCode || !safeEqualStrings(inviteCode, expectedCode, config.sessionSecret)) {
        return res.status(403).json({ error: 'Invalid team invite code.' });
      }

      await db.run(
        "UPDATE users SET reset_requested_at = $1 WHERE email = $2 AND role = 'employee'",
        [new Date().toISOString(), email]
      );

      return res.json({
        ok: true,
        message:
          'If an account matches that email, a password reset request has been flagged for your executive lead.',
      });
    } catch (err) {
      next(err);
    }
  });

  // Change password for the currently signed-in user
  app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
    try {
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');

      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required.' });
      }
      if (newPassword.length < 6 || newPassword.length > 128) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }

      const user = await db.get(
        'SELECT id, password_hash, token_version FROM users WHERE id = $1',
        [req.user.id]
      );
      if (!user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      const updated = await db.run(
        `UPDATE users
         SET password_hash = $1, token_version = token_version + 1, reset_requested_at = NULL
         WHERE id = $2
         RETURNING id, token_version`,
        [newHash, req.user.id]
      );

      setSessionCookie(res, updated.rows[0], config);
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  // Work Logs: strictly scoped to req.user.id for employees, full view for boss
  app.get('/api/logs', requireAuth, async (req, res, next) => {
    try {
      const { whereClause, params } = buildLogsFilter(req);

      const logs = await db.query(
        `SELECT id, user_id, person_name, project, work_done, logged_at
         FROM work_logs
         ${whereClause}
         ORDER BY logged_at DESC, id DESC
         LIMIT 1000`,
        params
      );

      // Determine today/week boundaries from client if valid ISO, else UTC day
      const now = new Date();
      const fallbackTodayStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      ).toISOString();
      const fallbackWeekStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
      ).toISOString();

      const todayStart =
        typeof req.query.todayStart === 'string' && !Number.isNaN(Date.parse(req.query.todayStart))
          ? new Date(req.query.todayStart).toISOString()
          : fallbackTodayStart;
      const weekStart =
        typeof req.query.weekStart === 'string' && !Number.isNaN(Date.parse(req.query.weekStart))
          ? new Date(req.query.weekStart).toISOString()
          : fallbackWeekStart;

      if (req.user.role === 'boss') {
        const totalRow = await db.get('SELECT COUNT(*) AS count FROM work_logs');
        const todayRow = await db.get(
          'SELECT COUNT(*) AS count, COUNT(DISTINCT user_id) AS contributors FROM work_logs WHERE logged_at >= $1',
          [todayStart]
        );
        const projectRows = await db.query(
          'SELECT DISTINCT project, LOWER(project) AS sort_key FROM work_logs ORDER BY sort_key ASC'
        );
        const employeeRows = await db.query(
          "SELECT id, name FROM users WHERE role = 'employee' ORDER BY LOWER(name) ASC"
        );

        return res.json({
          logs: logs.map((r) => ({
            id: Number(r.id),
            userId: Number(r.user_id),
            personName: r.person_name,
            project: r.project,
            workDone: r.work_done,
            loggedAt: r.logged_at,
          })),
          projects: projectRows.map((r) => r.project),
          employees: employeeRows.map((e) => ({ id: Number(e.id), name: e.name })),
          stats: {
            todayCount: Number(todayRow?.count || 0),
            activeContributorsToday: Number(todayRow?.contributors || 0),
            totalCount: Number(totalRow?.count || 0),
            projectCount: projectRows.length,
          },
        });
      }

      // Employee response: NEVER includes any other user's names, projects, or counts
      const totalRow = await db.get(
        'SELECT COUNT(*) AS count FROM work_logs WHERE user_id = $1',
        [req.user.id]
      );
      const todayRow = await db.get(
        'SELECT COUNT(*) AS count FROM work_logs WHERE user_id = $1 AND logged_at >= $2',
        [req.user.id, todayStart]
      );
      const weekRow = await db.get(
        'SELECT COUNT(*) AS count FROM work_logs WHERE user_id = $1 AND logged_at >= $2',
        [req.user.id, weekStart]
      );
      const myProjects = await db.query(
        'SELECT DISTINCT project, LOWER(project) AS sort_key FROM work_logs WHERE user_id = $1 ORDER BY sort_key ASC',
        [req.user.id]
      );

      return res.json({
        logs: logs.map((r) => ({
          id: Number(r.id),
          userId: Number(r.user_id),
          personName: r.person_name,
          project: r.project,
          workDone: r.work_done,
          loggedAt: r.logged_at,
        })),
        projects: myProjects.map((r) => r.project),
        stats: {
          todayCount: Number(todayRow?.count || 0),
          weekCount: Number(weekRow?.count || 0),
          totalCount: Number(totalRow?.count || 0),
          projectCount: myProjects.length,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/logs', requireAuth, async (req, res, next) => {
    try {
      const project = String(req.body?.project || '').trim();
      const workDone = String(req.body?.workDone || '').trim();
      const rawClientReqId = String(
        req.get('x-idempotency-key') || req.body?.clientRequestId || ''
      ).trim();
      const clientRequestId =
        rawClientReqId && rawClientReqId.length <= 80 ? rawClientReqId : null;

      if (!project || project.length > 120) {
        return res.status(400).json({ error: 'Project name is required (max 120 characters).' });
      }
      if (!workDone || workDone.length > 2000) {
        return res.status(400).json({ error: 'Work description is required (max 2000 characters).' });
      }

      if (clientRequestId) {
        const existingLog = await db.get(
          `SELECT id, user_id, person_name, project, work_done, logged_at
           FROM work_logs
           WHERE user_id = $1 AND client_request_id = $2`,
          [req.user.id, clientRequestId]
        );
        if (existingLog) {
          return res.status(200).json({
            log: {
              id: Number(existingLog.id),
              userId: Number(existingLog.user_id),
              personName: existingLog.person_name,
              project: existingLog.project,
              workDone: existingLog.work_done,
              loggedAt: existingLog.logged_at,
            },
          });
        }
      }

      // Server enforces person_name and timestamp so entries cannot be spoofed
      const loggedAt = new Date().toISOString();
      let row;
      try {
        const inserted = await db.run(
          `INSERT INTO work_logs (user_id, person_name, project, work_done, client_request_id, logged_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, user_id, person_name, project, work_done, logged_at`,
          [req.user.id, req.user.name, project, workDone, clientRequestId, loggedAt]
        );
        row = inserted.rows[0];
      } catch (insertErr) {
        // Handle concurrent duplicate retry on unique (user_id, client_request_id)
        if (clientRequestId) {
          const existingLog = await db.get(
            `SELECT id, user_id, person_name, project, work_done, logged_at
             FROM work_logs
             WHERE user_id = $1 AND client_request_id = $2`,
            [req.user.id, clientRequestId]
          );
          if (existingLog) {
            row = existingLog;
          } else {
            throw insertErr;
          }
        } else {
          throw insertErr;
        }
      }

      return res.status(201).json({
        log: {
          id: Number(row.id),
          userId: Number(row.user_id),
          personName: row.person_name,
          project: row.project,
          workDone: row.work_done,
          loggedAt: row.logged_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/logs/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(404).json({ error: 'Log entry not found.' });
      }

      const project = String(req.body?.project || '').trim();
      const workDone = String(req.body?.workDone || '').trim();
      if (!project || project.length > 120) {
        return res.status(400).json({ error: 'Project name is required (max 120 characters).' });
      }
      if (!workDone || workDone.length > 2000) {
        return res.status(400).json({ error: 'Work description is required (max 2000 characters).' });
      }

      let result;
      if (req.user.role === 'boss') {
        result = await db.run(
          `UPDATE work_logs SET project = $1, work_done = $2 WHERE id = $3
           RETURNING id, user_id, person_name, project, work_done, logged_at`,
          [project, workDone, id]
        );
      } else {
        // Strict ownership check; returns 404 (not 403) so IDs cannot be probed
        result = await db.run(
          `UPDATE work_logs SET project = $1, work_done = $2 WHERE id = $3 AND user_id = $4
           RETURNING id, user_id, person_name, project, work_done, logged_at`,
          [project, workDone, id, req.user.id]
        );
      }

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Log entry not found.' });
      }

      const row = result.rows[0];
      return res.json({
        log: {
          id: Number(row.id),
          userId: Number(row.user_id),
          personName: row.person_name,
          project: row.project,
          workDone: row.work_done,
          loggedAt: row.logged_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/logs/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(404).json({ error: 'Log entry not found.' });
      }

      let result;
      if (req.user.role === 'boss') {
        result = await db.run('DELETE FROM work_logs WHERE id = $1', [id]);
      } else {
        // Strict ownership check; returns 404 (not 403) so IDs cannot be probed
        result = await db.run('DELETE FROM work_logs WHERE id = $1 AND user_id = $2', [
          id,
          req.user.id,
        ]);
      }

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Log entry not found.' });
      }

      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/logs/export.csv', requireAuth, async (req, res, next) => {
    try {
      const { whereClause, params } = buildLogsFilter(req);
      const rows = await db.query(
        `SELECT person_name, project, work_done, logged_at
         FROM work_logs
         ${whereClause}
         ORDER BY logged_at DESC, id DESC`,
        params
      );

      const tzOffset = req.query.tzOffsetMinutes !== undefined ? Number(req.query.tzOffsetMinutes) : NaN;
      const header = ['Name', 'Project', 'Work Done', 'Date & Time'].join(',');
      const lines = rows.map((r) =>
        [
          escapeCsvCell(r.person_name),
          escapeCsvCell(r.project),
          escapeCsvCell(r.work_done),
          escapeCsvCell(formatTimestampWithOffset(r.logged_at, tzOffset)),
        ].join(',')
      );

      const filename =
        req.user.role === 'boss'
          ? `team-work-logs-${new Date().toISOString().slice(0, 10)}.csv`
          : `my-work-logs-${new Date().toISOString().slice(0, 10)}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send([header, ...lines].join('\r\n'));
    } catch (err) {
      next(err);
    }
  });

  // Boss-only Team & Access Management endpoints
  app.get('/api/boss/team', requireBoss, async (_req, res, next) => {
    try {
      const members = await db.query(`
        SELECT
          u.id,
          u.name,
          u.email,
          u.role,
          u.is_active,
          u.reset_requested_at,
          u.created_at,
          COUNT(w.id) AS entry_count,
          MAX(w.logged_at) AS last_logged_at
        FROM users u
        LEFT JOIN work_logs w ON w.user_id = u.id
        GROUP BY u.id, u.name, u.email, u.role, u.is_active, u.reset_requested_at, u.created_at
        ORDER BY CASE WHEN u.role = 'boss' THEN 0 ELSE 1 END, LOWER(u.name) ASC
      `);

      const setting = await db.get('SELECT value FROM settings WHERE key = $1', [
        'team_invite_code',
      ]);

      return res.json({
        teamInviteCode: setting?.value || config.teamInviteCode,
        members: members.map((m) => ({
          id: Number(m.id),
          name: m.name,
          email: m.email,
          role: m.role,
          isActive: Number(m.is_active) === 1,
          resetRequestedAt: m.reset_requested_at || null,
          createdAt: m.created_at,
          entryCount: Number(m.entry_count || 0),
          lastLoggedAt: m.last_logged_at || null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/boss/team', requireBoss, async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
      if (password.length < 6 || password.length > 128) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const existing = await db.get('SELECT id FROM users WHERE email = $1', [email]);
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const inserted = await db.run(
        `INSERT INTO users (name, email, password_hash, role, is_active, token_version, created_at)
         VALUES ($1, $2, $3, 'employee', 1, 1, $4)
         RETURNING id, name, email, role, is_active, created_at`,
        [name, email, passwordHash, new Date().toISOString()]
      );
      const m = inserted.rows[0];
      return res.status(201).json({
        member: {
          id: Number(m.id),
          name: m.name,
          email: m.email,
          role: m.role,
          isActive: Number(m.is_active) === 1,
          createdAt: m.created_at,
          entryCount: 0,
          lastLoggedAt: null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/boss/team/:id', requireBoss, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(404).json({ error: 'Team member not found.' });
      }

      const existing = await db.get(
        'SELECT id, name, email, role, is_active, token_version FROM users WHERE id = $1',
        [id]
      );
      if (!existing) {
        return res.status(404).json({ error: 'Team member not found.' });
      }

      const updates = [];
      const params = [];
      const push = (val) => {
        params.push(val);
        return `$${params.length}`;
      };

      if (typeof req.body?.isActive === 'boolean') {
        if (id === req.user.id && !req.body.isActive) {
          return res.status(400).json({ error: 'You cannot deactivate your own executive account.' });
        }
        updates.push(`is_active = ${push(req.body.isActive ? 1 : 0)}`);
        if (!req.body.isActive) {
          updates.push('token_version = token_version + 1');
        }
      }

      if (typeof req.body?.name === 'string') {
        const newName = req.body.name.trim();
        if (newName.length < 2 || newName.length > 80) {
          return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
        }
        updates.push(`name = ${push(newName)}`);
        await db.run('UPDATE work_logs SET person_name = $1 WHERE user_id = $2', [newName, id]);
      }

      if (typeof req.body?.password === 'string' && req.body.password.length > 0) {
        if (req.body.password.length < 6 || req.body.password.length > 128) {
          return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }
        const hash = await bcrypt.hash(req.body.password, 10);
        updates.push(`password_hash = ${push(hash)}`);
        updates.push('token_version = token_version + 1');
        updates.push('reset_requested_at = NULL');
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
      }

      const idRef = push(id);
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ${idRef}`, params);

      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/boss/team/:id', requireBoss, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(404).json({ error: 'Team member not found.' });
      }
      if (id === req.user.id) {
        return res.status(400).json({ error: 'You cannot delete your own executive account.' });
      }

      const result = await db.run('DELETE FROM users WHERE id = $1', [id]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Team member not found.' });
      }
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/boss/invite-code', requireBoss, async (req, res, next) => {
    try {
      const code = String(req.body?.inviteCode || '').trim();
      if (code.length < 4 || code.length > 64) {
        return res.status(400).json({ error: 'Invite code must be between 4 and 64 characters.' });
      }

      const existing = await db.get('SELECT key FROM settings WHERE key = $1', [
        'team_invite_code',
      ]);
      if (existing) {
        await db.run('UPDATE settings SET value = $1 WHERE key = $2', [code, 'team_invite_code']);
      } else {
        await db.run('INSERT INTO settings (key, value) VALUES ($1, $2)', [
          'team_invite_code',
          code,
        ]);
      }

      return res.json({ teamInviteCode: code });
    } catch (err) {
      next(err);
    }
  });

  // Static frontend
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Endpoint not found.' });
    }
    return res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, _req, res, _next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

async function startServer() {
  const config = loadConfig();
  const db = await createDb(config);
  const app = createApp(db, config);

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[server] ${config.appTitle} listening on port ${config.port} (db=${db.type}, env=${config.nodeEnv})`
    );
  });
  // Keep Node's HTTP keep-alive longer than Render's reverse proxy to avoid socket-reset "Load failed"
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const shutdown = async () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
