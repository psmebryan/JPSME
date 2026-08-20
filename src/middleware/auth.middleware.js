const { error } = require('../utils/apiResponse');

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
    const chapterId = req.session.user.chapterId ?? (req.session.user.chapter && req.session.user.chapter.id);
    if (chapterId) return next();
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

function apiAdminOrChapterAdmin(req, res, next) {
  if (!req.session.user) return error(res, 'Authentication required', 401);
  if (req.session.user.role === 'ADMIN') return next();
  if (req.session.user.role === 'CHAPTER_ADMIN') {
    // accept either chapterId scalar or nested chapter.id in session.user
    const chapterId = req.session.user.chapterId ?? (req.session.user.chapter && req.session.user.chapter.id);
    if (chapterId) {
      // expose the chapter scope so controllers can enforce object-level access
      req.chapterScope = chapterId;
      return next();
    }
  }
  return error(res, 'Admin access required', 403);
}
 
module.exports = { ensureAuth, ensureGuest, ensureAdmin, ensureAdminOrChapterAdmin, ensureMainAdminOnly, apiAuth, apiAdmin, apiAdminOrChapterAdmin };
