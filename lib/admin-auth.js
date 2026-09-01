'use strict';

const MAX_PIN_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;

function getPinGuard(req) {
  if (!req.session.pinGuard) {
    req.session.pinGuard = { fails: 0, lockedUntil: 0 };
  }
  return req.session.pinGuard;
}

function assertNotLocked(req) {
  const guard = getPinGuard(req);
  if (guard.lockedUntil && Date.now() < guard.lockedUntil) {
    const err = new Error('Too many PIN attempts. Try again in 15 minutes.');
    err.status = 429;
    throw err;
  }
}

function recordPinFailure(req) {
  const guard = getPinGuard(req);
  guard.fails += 1;
  if (guard.fails >= MAX_PIN_ATTEMPTS) {
    guard.lockedUntil = Date.now() + LOCK_MS;
  }
}

function clearPinGuard(req) {
  req.session.pinGuard = { fails: 0, lockedUntil: 0 };
}

function setAppUserSession(req, user) {
  req.session.appUser = {
    id: user.id,
    handle: user.handle,
    name: user.name,
    isAdmin: Boolean(user.isAdmin),
  };
}

function publicSession(req) {
  return req.session.appUser || null;
}

function requireAppUser(req, res, next) {
  const user = req.session.appUser;
  if (!user?.id) {
    return res.status(401).json({ error: 'PIN sign-in required', code: 'ADMIN_PIN_REQUIRED' });
  }
  req.appUser = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = req.session.appUser;
  if (!user?.id) {
    return res.status(401).json({ error: 'PIN sign-in required', code: 'ADMIN_PIN_REQUIRED' });
  }
  if (!user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  req.appUser = user;
  next();
}

module.exports = {
  assertNotLocked,
  recordPinFailure,
  clearPinGuard,
  setAppUserSession,
  publicSession,
  requireAppUser,
  requireAdmin,
};
