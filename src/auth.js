const crypto = require('crypto');

const COOKIE_NAME = 'mjx_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Constant-time string comparison using SHA-256 HMAC digests so length is never leaked.
 */
function safeEqualStrings(a, b, secret = 'compare-key') {
  const digestA = crypto.createHmac('sha256', secret).update(String(a)).digest();
  const digestB = crypto.createHmac('sha256', secret).update(String(b)).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function signToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;

  const data = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');

  const bufA = Buffer.from(sig, 'utf8');
  const bufB = Buffer.from(expectedSig, 'utf8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.uid !== 'number' || typeof parsed.exp !== 'number') {
      return null;
    }
    if (Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setSessionCookie(res, user, config) {
  const token = signToken(
    {
      uid: user.id,
      ver: user.token_version,
      exp: Date.now() + SESSION_TTL_MS,
    },
    config.sessionSecret
  );

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res, config) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
  });
}

function createAuthMiddleware(db, config) {
  async function attachUser(req, _res, next) {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      const payload = verifyToken(token, config.sessionSecret);
      if (!payload) {
        req.user = null;
        return next();
      }

      const user = await db.get(
        'SELECT id, name, email, role, is_active, token_version, created_at FROM users WHERE id = $1',
        [payload.uid]
      );

      if (!user || Number(user.is_active) !== 1 || Number(user.token_version) !== payload.ver) {
        req.user = null;
        return next();
      }

      req.user = {
        id: Number(user.id),
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.created_at,
      };
      return next();
    } catch (err) {
      return next(err);
    }
  }

  function requireAuth(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    return next();
  }

  function requireBoss(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (req.user.role !== 'boss') {
      return res.status(403).json({ error: 'Executive access required.' });
    }
    return next();
  }

  return { attachUser, requireAuth, requireBoss };
}

module.exports = {
  safeEqualStrings,
  setSessionCookie,
  clearSessionCookie,
  createAuthMiddleware,
};
