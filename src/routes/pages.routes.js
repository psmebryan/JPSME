const { Router } = require('express');
const pages = require('../controllers/pages.controller');
const { ensureAuth, ensureGuest, ensureAdmin, ensureAdminOrChapterAdmin, ensureMainAdminOnly } = require('../middleware/auth.middleware');

const router = Router();

// Public
router.get('/', pages.home);
router.get('/about', pages.aboutPage);
router.get('/about/quality-policy', pages.qualityPolicyPage);
router.get('/about/code-of-ethics', pages.codeOfEthicsPage);
router.get('/about/theme-of-the-year', pages.themeOfTheYearPage);
router.get('/about/officers', pages.officersPage);
router.get('/about/membership', pages.membershipPage);
router.get('/contact', pages.contactPage);
router.get('/events', pages.eventsPage);
router.get('/events/:id', pages.eventDetailPage);
router.get('/events/:id/payment-return', ensureAuth, pages.eventPaymentReturnPage);
router.get('/chapters', pages.chaptersPage);
router.get('/chapters/region/:id', pages.chapterRegionPage);
router.get('/chapters/:id', pages.chapterDetailPage);


// Guest-only
router.get('/login', ensureGuest, pages.loginPage);
router.get('/register', ensureGuest, pages.registerPage);
router.get('/verify-email', pages.verifyEmailPage);

// Authenticated user
router.get('/profile', ensureAuth, pages.profilePage);
router.get('/dashboard', ensureAuth, (req, res) => res.redirect('/profile'));
router.get('/membership-payment', ensureAuth, pages.membershipPaymentPage);
router.get('/membership-payment/return', ensureAuth, pages.membershipPaymentReturnPage);
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// Admin — shared between main admin and chapter admin
router.get('/admin/login', ensureGuest, pages.adminLoginPage);
router.get('/admin', ensureAdmin, (req, res) => res.redirect('/admin/dashboard'));
router.get('/admin/dashboard', ensureAdmin, pages.adminDashboardPage);
router.get('/admin/events/new', ensureAdmin, pages.adminCreateEventPage);
router.get('/admin/events', ensureAdmin, pages.adminEventsPage);
router.get('/admin/events/:id/edit', ensureAdmin, pages.adminEditEventPage);
router.get('/admin/events/:id/registrations', ensureAdmin, pages.adminEventRegistrationsPage);

// Payments — MAIN_ADMIN only. Chapter admins have no access to payment data.
router.get('/admin/payments', ensureMainAdminOnly, pages.adminPaymentsPage);

// admin chapter start — shared: chapter admin is scoped to their own chapter
// inside the controller (adminChapterMembersPage), main admin sees everything.
router.get('/admin/chapter-members', ensureAdminOrChapterAdmin, pages.adminChapterMembersPage);
router.get('/admin/chapter-members/:id/edit', ensureAdminOrChapterAdmin, pages.adminEditUserPage);
router.post('/admin/chapter-members/:id/delete', ensureAdminOrChapterAdmin, pages.adminDeleteChapterMember);
// Main admin only — full user management
router.get('/admin/users', ensureMainAdminOnly, (req, res) => res.redirect('/admin/users/approvals'));
router.get('/admin/users/all', ensureMainAdminOnly, pages.adminUsersPage);
router.get('/admin/users/approvals', ensureMainAdminOnly, pages.adminUsersPage);
router.get('/admin/users/:id/edit', ensureMainAdminOnly, pages.adminEditUserPage);

// Main admin only — chapter/region/area CRUD (not to be confused with
// /admin/chapter-members above, which chapter admins can also reach)
router.get('/admin/chapters', ensureMainAdminOnly, pages.adminChaptersPage);
router.post('/admin/chapters/regions', ensureMainAdminOnly, pages.adminCreateRegion);
router.post('/admin/chapters/regions/:id/delete', ensureMainAdminOnly, pages.adminDeleteRegion);
router.post('/admin/chapters/areas', ensureMainAdminOnly, pages.adminCreateArea);
router.post('/admin/chapters/areas/:id/delete', ensureMainAdminOnly, pages.adminDeleteArea);
router.post('/admin/chapters', ensureMainAdminOnly, pages.adminCreateChapter);
router.get('/admin/chapters/:id/edit', ensureMainAdminOnly, pages.adminEditChapterPage);
router.post('/admin/chapters/:id', ensureMainAdminOnly, pages.adminUpdateChapter);
router.post('/admin/chapters/:id/delete', ensureMainAdminOnly, pages.adminDeleteChapter);

// Main admin only — assign/remove chapter admins
router.get('/admin/chapter-admins', ensureMainAdminOnly, pages.adminChapterAdminsPage);

// Main admin only — site settings
router.get('/admin/settings', ensureMainAdminOnly, pages.adminSettingsPage);
router.get('/admin/sponsors', ensureMainAdminOnly, pages.adminSponsorsPage);

// Main admin only — certificates
router.get('/admin/certificates', ensureMainAdminOnly, pages.adminCertificatesPage);
router.get('/admin/event-certificates', ensureMainAdminOnly, pages.adminEventCertificatesListPage);
router.get('/admin/events/:id/certificate', ensureMainAdminOnly, pages.adminEventCertificatePage);

// Main admin only — emails
router.get('/admin/emails', ensureMainAdminOnly, pages.adminEmailsPage);
router.get('/admin/event-emails', ensureMainAdminOnly, pages.adminEventEmailsListPage);
router.get('/admin/events/:id/email', ensureMainAdminOnly, pages.adminEventEmailPage);
router.get('/admin/broadcasts', ensureMainAdminOnly, pages.adminBroadcastsPage);

// Main admin only — system-wide audit trail (payments/webhooks/refunds/
// reconciliation/user-status changes). No API route needed — this is a
// plain server-rendered, filterable/paginated read, same pattern as
// /admin/events, not the client-JS-driven pattern used by /admin/payments.
router.get('/admin/audit-log', ensureMainAdminOnly, pages.adminAuditLogPage);
//end

router.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

module.exports = router;
