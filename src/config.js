const crypto = require('crypto');

/**
 * Loads runtime configuration from environment variables with safe defaults.
 */
function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  let sessionSecret = (process.env.SESSION_SECRET || '').trim();
  if (!sessionSecret) {
    if (isProd) {
      // Ephemeral fallback if not provided; logs a clear operational warning.
      console.warn(
        '[config] WARNING: SESSION_SECRET is not set in production. Generating ephemeral secret; sessions will reset on restart.'
      );
      sessionSecret = crypto.randomBytes(32).toString('hex');
    } else {
      sessionSecret = 'dev-only-insecure-session-secret-change-me';
    }
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv,
    isProd,
    appTitle: (process.env.APP_TITLE || 'MJX Labs · Work Ledger').trim(),
    sessionSecret,
    databaseUrl: (process.env.DATABASE_URL || '').trim(),
    sqlitePath: (process.env.SQLITE_PATH || './data/worklog.db').trim(),
    bossName: (process.env.BOSS_NAME || 'Internship Lead').trim(),
    bossEmail: (process.env.BOSS_EMAIL || '').trim().toLowerCase(),
    bossPassword: process.env.BOSS_PASSWORD || '',
    teamInviteCode: (process.env.TEAM_INVITE_CODE || 'MJX-TEAM-2026').trim(),
  };
}

module.exports = { loadConfig };
