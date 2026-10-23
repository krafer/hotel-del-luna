function createAuthentication(verifyIdToken) {
  async function authenticate(req, res, next, optional) {
    const authorization = req.get('authorization');

    if (!authorization) {
      if (optional) {
        return next();
      }
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const match = authorization.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Invalid authentication token.' });
    }

    try {
      const decodedToken = await verifyIdToken(match[1]);
      if (!decodedToken || typeof decodedToken.uid !== 'string' || !decodedToken.uid) {
        return res.status(401).json({ error: 'Invalid authentication token.' });
      }

      req.auth = decodedToken;
      return next();
    } catch (error) {
      if (error && error.code === 'AUTH_UNAVAILABLE') {
        return res.status(503).json({ error: 'Authentication service is unavailable.' });
      }
      return res.status(401).json({ error: 'Invalid authentication token.' });
    }
  }

  return {
    optional: (req, res, next) => authenticate(req, res, next, true),
    required: (req, res, next) => authenticate(req, res, next, false)
  };
}

function requireAdmin(req, res, next) {
  if (req.auth && req.auth.admin === true) {
    return next();
  }
  return res.status(403).json({ error: 'Administrator access required.' });
}

module.exports = { createAuthentication, requireAdmin };
