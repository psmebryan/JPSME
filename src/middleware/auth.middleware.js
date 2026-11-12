const { error } = require('../utils/apiResponse');
const organizationService = require('../services/organization.service');
const adminAccess = require('../services/adminAccess.service');

// The limited admins: the National President (PRESIDENT) and Finance &
// Logistics (FINANCE_LOGISTICS). Each passes an admin guard only for a path
// in a module they have (Site Settings: the President list for the role, the
// ticks on each Finance & Logistics account); see config/adminModules.
// Anything else is refused, so a route nobody listed stays main-admin only.
// Payments is view only for Finance & Logistics.
const LIMITED = adminAccess.LIMITED_ROLES;
const ADMIN_ROLES = ['ADMIN', 'CHAPTER_ADMIN', ...LIMITED];

function limitedGate(req, onAllowed, onDenied) {
  adminAccess.limitedCanOpen(req.session.user, req.originalUrl, req.method)
    .then((ok) => (ok ? onAllowed() : onDenied()))
    .catch(onDenied);
}

// Where a limited admin lands when a page is not theirs.
function limitedHome(req, res) {
  adminAccess.homeFor(req.session.user)
    .then((home) => res.redirect(home))
    .catch(() => res.redirect('/'));
}

const isLimited = (req) => Boolean(req.session.user && LIMITED.includes(req.session.user.role));
const apiDenied = (res) => () => error(res, 'Your access does not include this. Ask the main admin.', 403);

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
  if (req.session.user.role === 'FINANCE_LOGISTICS') return limitedHome(req, res);
  return res.redirect(ADMIN_ROLES.includes(req.session.user.role) ? '/admin/dashboard' : '/profile');
}

function ensureAdmin(req, res, next) {
  const role = req.session.user?.role;
  if (role === 'ADMIN' || role === 'CHAPTER_ADMIN') return next();
  if (isLimited(req)) return limitedGate(req, next, () => limitedHome(req, res));
  return res.redirect('/admin/login');
}

function ensureMainAdminOnly(req, res, next) {
  if (req.session.user && req.session.user.role === 'ADMIN') return next();
  if (isLimited(req)) return limitedGate(req, next, () => limitedHome(req, res));
  if (req.session.user) return res.redirect('/admin/dashboard');
  return res.redirect('/admin/login');
}

function ensureAdminOrChapterAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/admin/login');
  if (req.session.user.role === 'ADMIN') return next();
  if (isLimited(req)) return limitedGate(req, next, () => limitedHome(req, res));
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
  if (isLimited(req)) return limitedGate(req, next, apiDenied(res));
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
  if (isLimited(req)) return limitedGate(req, next, apiDenied(res));
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
// President, not a Finance & Logistics account (those are assigned by the main
// admin only), and cannot hand out any of those roles. Mounted in front of the routes
// that change an account, so a new one there is covered too. Reads are left
// alone; only changes are checked.
const PROTECTED_ROLES = ['ADMIN', 'PRESIDENT', 'FINANCE_LOGISTICS'];
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
      return deny('Only the main admin can give the admin, President or Finance & Logistics role.');
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
    if (protectedOne) return deny('A President cannot change the main admin, a President or a Finance & Logistics account.');
    return next();
  } catch (err) {
    return next(err);
  }
}

// Inside the merchandise store, after the admin guard: refuses unless the
// person has one of these capabilities. Sets req.merchCaps for the handler.
function merchCan(...caps) {
  return (req, res, next) => {
    adminAccess.merchCapsFor(req.session.user).then((have) => {
      req.merchCaps = have;
      res.locals.merchCaps = have;
      if (caps.some((c) => have.has(c))) return next();
      if (req.originalUrl.startsWith('/api/')) return error(res, 'Your access does not include this. Ask the main admin.', 403);
      return limitedHome(req, res);
    }).catch(next);
  };
}

module.exports = {
  merchCan,
  ensureAuth, ensureGuest, ensureAdmin, ensureAdminOrChapterAdmin, ensureMainAdminOnly,
  apiAuth, apiAdmin, apiAdminOrChapterAdmin, presidentTargetGuard,
};
