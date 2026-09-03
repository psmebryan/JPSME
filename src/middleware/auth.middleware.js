const { error } = require('../utils/apiResponse');
const organizationService = require('../services/organization.service');

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
  return res.redirect(['ADMIN', 'CHAPTER_ADMIN'].includes(req.session.user.role) ? '/admin/dashboard' : '/profile');
}

function ensureAdmin(req, res, next) {
  const role = req.session.user?.role;
  if (role === 'ADMIN' || role === 'CHAPTER_ADMIN') return next();
  return res.redirect('/admin/login');
}

function ensureMainAdminOnly(req, res, next) {
  if (req.session.user && req.session.user.role === 'ADMIN') return next();
  if (req.session.user) return res.redirect('/admin/dashboard');
  return res.redirect('/admin/login');
}

function ensureAdminOrChapterAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/admin/login');
  if (req.session.user.role === 'ADMIN') return next();
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
 
module.exports = { ensureAuth, ensureGuest, ensureAdmin, ensureAdminOrChapterAdmin, ensureMainAdminOnly, apiAuth, apiAdmin, apiAdminOrChapterAdmin };
