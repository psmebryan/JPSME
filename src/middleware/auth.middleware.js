const { error } = require('../utils/apiResponse');
const organizationService = require('../services/organization.service');
const adminAccess = require('../services/adminAccess.service');

// The National President (role PRESIDENT) passes an admin guard only for a
// path in a module the main admin has ticked (Site Settings -> National
// President access); see config/adminModules. Anything else is refused, so a
// route nobody listed stays main-admin only. Inside a module they may use, a
// President acts with national reach, like the main admin.
function presidentGate(req, onAllowed, onDenied) {
  adminAccess.presidentCanOpen(req.originalUrl)
    .then((ok) => (ok ? onAllowed() : onDenied()))
    .catch(onDenied);
}

// Where a President lands when a page is not theirs: the dashboard if they
// have it, otherwise their first module, otherwise the public site.
function presidentHome(req, res) {
  adminAccess.getPresidentModules().then((mods) => {
    if (mods.includes('dashboard')) return res.redirect('/admin/dashboard?denied=1');
    const first = adminAccess.MODULES.find((m) => mods.includes(m.key) && m.home);
    return res.redirect(first ? first.home : '/');
  }).catch(() => res.redirect('/'));
}

// Session shape has varied historically (scalar id vs. a nested object), so
// read both rather than assuming one.
function sessionOrganizationId(req) {
  const u = req.session.user;
  if (!u) return null;
  return u.organizationId ?? (u.organization && u.organization.id) ?? null;
}

// --- Page routes (redirect-based protection) ---

function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  return res.redirect('/login');
}

function ensureGuest(req, res, next) {
  if (!req.session.user) return next();
  return res.redirect(['ADMIN', 'CHAPTER_ADMIN', 'PRESIDENT'].includes(req.session.user.role) ? '/admin/dashboard' : '/profile');
}

function ensureAdmin(req, res, next) {
  const role = req.session.user?.role;
  if (role === 'ADMIN' || role === 'CHAPTER_ADMIN') return next();
  if (role === 'PRESIDENT') return presidentGate(req, next, () => presidentHome(req, res));
  return res.redirect('/admin/login');
}

function ensureMainAdminOnly(req, res, next) {
  if (req.session.user && req.session.user.role === 'ADMIN') return next();
  if (req.session.user && req.session.user.role === 'PRESIDENT') return presidentGate(req, next, () => presidentHome(req, res));
  if (req.session.user) return res.redirect('/admin/dashboard');
  return res.redirect('/admin/login');
}

function ensureAdminOrChapterAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/admin/login');
  if (req.session.user.role === 'ADMIN') return next();
  if (req.session.user.role === 'PRESIDENT') return presidentGate(req, next, () => presidentHome(req, res));
  if (req.session.user.role === 'CHAPTER_ADMIN') {
    const organizationId = sessionOrganizationId(req);
    if (organizationId) return next();
  }
  return res.redirect('/admin/login');
}
 
// --- API routes (JSON-based protection) ---
 
function apiAuth(req, res, next) {
  if (req.session.user) return next();
  return error(res, 'Authentication required', 401);
}
 
function apiAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'ADMIN') return next();
  if (req.session.user && req.session.user.role === 'PRESIDENT') {
    return presidentGate(req, next, () => error(res, 'Your access does not include this. Ask the main admin.', 403));
  }
  return error(res, 'Admin access required', 403);
}

// Resolves a scoped admin's authority to an organization SUBTREE rather than a
// single id. Previously this exposed one scalar (`req.chapterScope`) that
// controllers compared with `!==`, which could only ever express "exactly this
// chapter". `req.orgScope.descendantIds` includes the admin's own organization
// plus everything beneath it, so a chapter admin whose chapter has no children
// behaves exactly as before, while region/cluster admins become expressible
// later without another migration.
//
// The subtree is resolved once per request via a single indexed id-only query
// (Organization.path prefix scan) and reused by controllers — it does not add
// a query per row checked. MAIN_ADMIN skips the lookup entirely.
async function apiAdminOrChapterAdmin(req, res, next) {
  if (!req.session.user) return error(res, 'Authentication required', 401);
  if (req.session.user.role === 'ADMIN') return next();
  if (req.session.user.role === 'PRESIDENT') {
    return presidentGate(req, next, () => error(res, 'Your access does not include this. Ask the main admin.', 403));
  }
  if (req.session.user.role === 'CHAPTER_ADMIN') {
    const organizationId = sessionOrganizationId(req);
    if (organizationId) {
      try {
        const descendantIds = await organizationService.getDescendantIds(organizationId);
        if (!descendantIds.length) return error(res, 'Admin access required', 403);
        req.orgScope = { id: Number(organizationId), descendantIds };
        return next();
      } catch (err) {
        return next(err);
      }
    }
  }
  return error(res, 'Admin access required', 403);
}
 
// A President can manage members (when given Users or Organizations) but can
// never touch an account above or beside them: not the main admin, not another
// President, and cannot hand out either role. Mounted in front of the routes
// that change an account, so a new one there is covered too. Reads are left
// alone; only changes are checked.
const PROTECTED_ROLES = ['ADMIN', 'PRESIDENT'];
const TARGET_IN_PATH = [/\/users\/(\d+)(\/|$)/, /\/organization-members\/(\d+)(\/|$)/];

async function presidentTargetGuard(req, res, next) {
  const actor = req.session && req.session.user;
  if (!actor || actor.role !== 'PRESIDENT') return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const deny = (message) => (req.originalUrl.startsWith('/api/')
    ? error(res, message, 403)
    : res.status(403).send(message));
  try {
    const body = req.body || {};
    if (PROTECTED_ROLES.includes(String(body.role || '').toUpperCase())) {
      return deny('Only the main admin can give the admin or President role.');
    }
    const ids = [];
    TARGET_IN_PATH.forEach((re) => { const m = req.originalUrl.split('?')[0].match(re); if (m) ids.push(Number(m[1])); });
    if (Array.isArray(body.ids)) body.ids.forEach((id) => ids.push(Number(id)));
    if (body.userId !== undefined) ids.push(Number(body.userId));
    const wanted = ids.filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!wanted.length) return next();
    // eslint-disable-next-line global-require
    const prisma = require('../config/prisma');
    const protectedOne = await prisma.user.findFirst({ where: { id: { in: wanted }, role: { in: PROTECTED_ROLES } }, select: { id: true } });
    if (protectedOne) return deny('A President cannot change the main admin or a President account.');
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  ensureAuth, ensureGuest, ensureAdmin, ensureAdminOrChapterAdmin, ensureMainAdminOnly,
  apiAuth, apiAdmin, apiAdminOrChapterAdmin, presidentTargetGuard,
};
