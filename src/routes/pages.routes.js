const { Router } = require('express');
const pages = require('../controllers/pages.controller');
const {
  ensureAuth, ensureGuest, ensureAdmin, ensureAdminOrChapterAdmin, ensureMainAdminOnly, presidentTargetGuard, merchCan,
} = require('../middleware/auth.middleware');
// The admin forms below post a _csrf field; verifyCsrfToken is what checks it.
// withCsrfToken marks a page an anonymous visitor submits a form from: only
// those pages (and signed-in users) get a session, so a visitor just reading
// the site never creates one. See csrf.middleware.js.
const { verifyCsrfToken, withCsrfToken } = require('../middleware/csrf.middleware');
const { requireSeatingFeature } = require('../middleware/feature.middleware');

const router = Router();

// Public
router.get('/', pages.home);
router.get('/about', pages.aboutPage);
router.get('/about/quality-policy', pages.qualityPolicyPage);
router.get('/about/code-of-ethics', pages.codeOfEthicsPage);
router.get('/about/theme-of-the-year', pages.themeOfTheYearPage);
router.get('/about/officers', pages.officersPage);
router.get('/about/membership', pages.membershipPage);
router.get('/contact', withCsrfToken, pages.contactPage);
router.get('/events', pages.eventsPage);
router.get('/events/:id', withCsrfToken, pages.eventDetailPage);
router.get('/events/:id/invite/:token', withCsrfToken, pages.eventInvitePage);
// One-click RSVP link embedded directly in the invitation email (for guests
// who don't need to visit the site first) — records the answer, then lands
// on the normal invite page so the rest of the experience (member CTA, or a
// changed-your-mind option) is identical to arriving there manually.
router.get('/events/:id/invite/:token/rsvp/:status(attending|not-attending)', pages.submitRsvpFromEmailPage);
router.get('/events/:id/payment-return', ensureAuth, pages.eventPaymentReturnPage);
router.get('/events/:id/ticket', ensureAuth, pages.eventTicketPage);
// Picking a seat, by the person who will sit in it. Beside the ticket rather
// than under /admin: the desk can assign a seat, but so can the attendee, and
// this is the half they drive.
router.get('/events/:id/seat', requireSeatingFeature, ensureAuth, pages.eventSeatPickerPage);
router.get('/articles', pages.articlesPage);
// The merchandise Store. Hidden (404) until the main admin opens it, except
// as a preview for the main admin / a President with Merchandise.
router.get('/store', withCsrfToken, pages.storePage);
router.get('/store/products/:id', withCsrfToken, pages.storeProductPage);
router.get('/store/cart', ensureAuth, withCsrfToken, pages.storeCartPage);
router.get('/store/orders', ensureAuth, withCsrfToken, pages.storeOrdersPage);
router.get('/store/orders/:orderNumber', ensureAuth, withCsrfToken, pages.storeOrderPage);
router.get('/store/addresses', ensureAuth, withCsrfToken, pages.storeAddressesPage);
router.get('/articles/:id', pages.articleDetailPage);
// URLs kept as /chapters/* so any existing external links still resolve;
// they render the organization tree behind the scenes.
router.get('/chapters', pages.organizationsPage);
router.get('/organizations', pages.organizationsPage);
router.get('/chapters/:id', pages.organizationDetailPage);
router.get('/organizations/:id', pages.organizationDetailPage);


// Guest-only
router.get('/login', ensureGuest, withCsrfToken, pages.loginPage);
router.get('/register', ensureGuest, withCsrfToken, pages.registerPage);
router.get('/verify-email', withCsrfToken, pages.verifyEmailPage);

// Authenticated user
router.get('/profile', ensureAuth, pages.profilePage);
router.get('/dashboard', ensureAuth, (req, res) => res.redirect('/profile'));
router.get('/membership-payment', ensureAuth, pages.membershipPaymentPage);
router.get('/membership-payment/return', ensureAuth, pages.membershipPaymentReturnPage);
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('jpsme.sid');
    res.redirect('/login');
  });
});

// Admin — shared between main admin and chapter admin
router.get('/jpsme_admin/login', ensureGuest, withCsrfToken, pages.adminLoginPage);
router.get('/jpsme_admin', ensureAdmin, (req, res) => res.redirect('/jpsme_admin/dashboard'));
router.get('/jpsme_admin/dashboard', ensureAdmin, pages.adminDashboardPage);
router.get('/jpsme_admin/events/new', ensureAdmin, pages.adminCreateEventPage);
router.get('/jpsme_admin/events', ensureAdmin, pages.adminEventsPage);
router.get('/jpsme_admin/events/:id/edit', ensureAdmin, pages.adminEditEventPage);
router.get('/jpsme_admin/events/:id/registrations', ensureAdmin, pages.adminEventRegistrationsPage);
// The check-in module's own pages, listed before the per-event ones they lead
// to so the module reads as a unit rather than as an appendix to events.
router.get('/jpsme_admin/check-in', ensureAdmin, pages.adminCheckInHubPage);
router.get('/jpsme_admin/check-in/staff', ensureMainAdminOnly, pages.adminCheckInStaffPage);
router.get('/jpsme_admin/events/:id/check-in/report', ensureAdmin, pages.adminEventCheckInReportPage);
// Rooms sit under the event rather than under check-in: they are part of how
// the event is set up, and the door screen for one is reached from the list.
// One home for the day, then the stations. They are deliberately separate
// screens — the desk hands out seats and admits, the entrance only admits, the
// room door tracks in and out — and this is where an admin starts.
router.get('/jpsme_admin/events/:id/attendance', ensureAdmin, pages.adminEventAttendancePage);
router.get('/jpsme_admin/events/:id/desk', ensureAdmin, pages.adminEventDeskPage);
router.get('/jpsme_admin/events/:id/rooms', ensureAdmin, pages.adminEventRoomsPage);
router.get('/jpsme_admin/events/:id/rooms/:roomId/scan', ensureAdmin, pages.adminRoomScanPage);
// Main admin only: this page shows every attendee's name against a seat and
// can reassign them, which is more than running a door.
router.get('/jpsme_admin/events/:id/seating', requireSeatingFeature, ensureMainAdminOnly, pages.adminEventSeatingPage);

// Payments — MAIN_ADMIN only. Chapter admins have no access to payment data.
router.get('/jpsme_admin/payments', ensureMainAdminOnly, pages.adminPaymentsPage);

// admin chapter start — shared: chapter admin is scoped to their own chapter
// inside the controller (adminChapterMembersPage), main admin sees everything.
router.get('/jpsme_admin/organization-members', ensureAdminOrChapterAdmin, pages.adminOrganizationMembersPage);
router.get('/jpsme_admin/organization-members/:id/edit', ensureAdminOrChapterAdmin, pages.adminEditUserPage);
router.post('/jpsme_admin/organization-members/:id/delete', ensureAdminOrChapterAdmin, verifyCsrfToken, presidentTargetGuard, pages.adminDeleteOrganizationMember);
// Main admin only — full user management
router.get('/jpsme_admin/users', ensureMainAdminOnly, (req, res) => res.redirect('/jpsme_admin/users/approvals'));
router.get('/jpsme_admin/users/all', ensureMainAdminOnly, pages.adminUsersPage);
router.get('/jpsme_admin/users/approvals', ensureMainAdminOnly, pages.adminUsersPage);
router.get('/jpsme_admin/users/:id/edit', ensureMainAdminOnly, pages.adminEditUserPage);
// Beside the user pages rather than under /jpsme_admin/invitations, which already
// belongs to event invitations and would read as the same feature.
router.get('/jpsme_admin/activations', ensureMainAdminOnly, pages.adminActivationsPage);

// Main admin only — chapter/region/area CRUD (not to be confused with
// /jpsme_admin/chapter-members above, which chapter admins can also reach)
router.get('/jpsme_admin/organizations/tree', ensureMainAdminOnly, pages.adminOrganizationTreePage);
router.get('/jpsme_admin/organizations', ensureMainAdminOnly, pages.adminOrganizationsPage);
router.post('/jpsme_admin/organizations', ensureMainAdminOnly, verifyCsrfToken, pages.adminCreateOrganization);
// Must precede the /:id routes below — otherwise "bulk-reassign" is parsed as an :id.
router.post('/jpsme_admin/organizations/bulk-reassign', ensureMainAdminOnly, verifyCsrfToken, pages.adminBulkReassignOrganizations);
router.get('/jpsme_admin/organizations/:id/edit', ensureMainAdminOnly, pages.adminEditOrganizationPage);
router.post('/jpsme_admin/organizations/:id', ensureMainAdminOnly, verifyCsrfToken, pages.adminUpdateOrganization);
router.post('/jpsme_admin/organizations/:id/delete', ensureMainAdminOnly, verifyCsrfToken, pages.adminDeleteOrganization);

// Main admin only — assign/remove chapter admins
router.get('/jpsme_admin/organization-admins', ensureMainAdminOnly, pages.adminOrganizationAdminsPage);

// Main admin only — site settings
router.get('/jpsme_admin/settings', ensureMainAdminOnly, pages.adminSettingsPage);
// Master List: one page per list. Member types first; the old single-page
// address still works.
router.get('/jpsme_admin/master/member-types', ensureMainAdminOnly, pages.adminMasterListPage);
router.get('/jpsme_admin/master/student-organizations', ensureMainAdminOnly, pages.adminStudentOrgMasterPage);
router.get('/jpsme_admin/master/event-fees', ensureMainAdminOnly, pages.adminEventFeeMasterPage);
router.get('/jpsme_admin/master/memberships', ensureMainAdminOnly, pages.adminMembershipMasterPage);
router.get('/jpsme_admin/master/memberships/export.xlsx', ensureMainAdminOnly, pages.adminMembershipMasterExport);
// Merchandise. ensureMainAdminOnly lets in the main admin, a President given
// Merchandise and a Finance & Logistics account with a task group; merchCan
// then asks for the one capability each page needs (adminAccess.merchCapsFor).
const M = (...caps) => [ensureMainAdminOnly, merchCan(...caps)];
router.get('/jpsme_admin/merch', ...M('dashboard.view'), (req, res) => res.redirect('/jpsme_admin/merch/dashboard'));
router.get('/jpsme_admin/merch/dashboard', ...M('dashboard.view'), pages.adminMerchDashboardPage);
router.get('/jpsme_admin/merch/products', ...M('catalog.view'), pages.adminMerchProductsPage);
router.get('/jpsme_admin/merch/products/:id', ...M('catalog.view'), pages.adminMerchProductPage);
router.get('/jpsme_admin/merch/inventory', ...M('stock.view'), pages.adminMerchInventoryPage);
router.get('/jpsme_admin/merch/inventory/export.xlsx', ...M('stock.view'), pages.adminMerchInventoryExport);
router.get('/jpsme_admin/merch/orders', ...M('orders.view'), pages.adminMerchOrdersPage);
router.get('/jpsme_admin/merch/orders/export.xlsx', ...M('orders.view'), pages.adminMerchOrdersExport);
router.get('/jpsme_admin/merch/orders/print', ...M('orders.fulfil'), pages.adminMerchOrdersPrint);
router.get('/jpsme_admin/merch/orders/:orderNumber', ...M('orders.view'), pages.adminMerchOrderPage);
router.get('/jpsme_admin/merch/pickup', ...M('orders.fulfil'), pages.adminMerchPickupPage);
router.get('/jpsme_admin/merch/fulfilment', ...M('catalog.view'), pages.adminMerchFulfilmentPage);
router.get('/jpsme_admin/merch/returns', ...M('returns.view'), pages.adminMerchReturnsPage);
router.get('/jpsme_admin/merch/returns/:returnNumber', ...M('returns.view'), pages.adminMerchReturnPage);
router.get('/jpsme_admin/merch/reconciliation', ...M('reconcile.view'), pages.adminMerchReconciliationPage);
router.get('/jpsme_admin/merch/month-end.xlsx', ...M('reconcile.view'), pages.adminMerchMonthEndExport);
router.get('/jpsme_admin/merch/reports', ...M('reports.view'), pages.adminMerchReportsPage);
router.get('/jpsme_admin/merch/reports/export.xlsx', ...M('reports.view'), pages.adminMerchReportsExport);
router.get('/jpsme_admin/merch/launch', ...M('catalog.view'), pages.adminMerchLaunchPage);
router.get('/jpsme_admin/merch/count', ...M('stock.view'), pages.adminMerchCountPage);
router.get('/jpsme_admin/merch/count/print', ...M('stock.view'), pages.adminMerchCountPrint);
router.get('/jpsme_admin/merch/feedback', ...M('orders.view'), pages.adminMerchFeedbackPage);

// Reports: read-only, main admin only.
router.get('/jpsme_admin/reports', ensureMainAdminOnly, (req, res) => res.redirect('/jpsme_admin/reports/transactions'));
router.get('/jpsme_admin/reports/transactions', ensureMainAdminOnly, pages.adminTransactionReportPage);
router.get('/jpsme_admin/reports/transactions/export.xlsx', ensureMainAdminOnly, pages.adminTransactionReportExport);
router.get('/jpsme_admin/reports/organization-members', ensureMainAdminOnly, pages.adminOrgMemberReportPage);
router.get('/jpsme_admin/reports/organization-members/export.xlsx', ensureMainAdminOnly, pages.adminOrgMemberReportExport);
router.get('/jpsme_admin/reports/organization-events', ensureMainAdminOnly, pages.adminOrgEventReportPage);
router.get('/jpsme_admin/reports/organization-events/export.xlsx', ensureMainAdminOnly, pages.adminOrgEventReportExport);
router.get('/jpsme_admin/master-list', ensureMainAdminOnly, (req, res) => res.redirect('/jpsme_admin/master/member-types'));
router.get('/jpsme_admin/sponsors', ensureMainAdminOnly, pages.adminSponsorsPage);

// Main admin only — certificates
router.get('/jpsme_admin/certificates', ensureMainAdminOnly, pages.adminCertificatesPage);
router.get('/jpsme_admin/event-certificates', ensureMainAdminOnly, pages.adminEventCertificatesListPage);
router.get('/jpsme_admin/events/:id/certificate', ensureMainAdminOnly, pages.adminEventCertificatePage);

// Main admin only — emails
router.get('/jpsme_admin/emails', ensureMainAdminOnly, pages.adminEmailsPage);
router.get('/jpsme_admin/event-emails', ensureMainAdminOnly, pages.adminEventEmailsListPage);
router.get('/jpsme_admin/events/:id/email', ensureMainAdminOnly, pages.adminEventEmailPage);
router.get('/jpsme_admin/broadcasts', ensureMainAdminOnly, pages.adminBroadcastsPage);

// Main admin only — system-wide audit trail (payments/webhooks/refunds/
// reconciliation/user-status changes). No API route needed — this is a
// plain server-rendered, filterable/paginated read, same pattern as
// /jpsme_admin/events, not the client-JS-driven pattern used by /jpsme_admin/payments.
router.get('/jpsme_admin/audit-log', ensureMainAdminOnly, pages.adminAuditLogPage);
router.get('/jpsme_admin/invitations', ensureMainAdminOnly, pages.adminInvitationsPage);

// Main admin only — public Articles content management
router.get('/jpsme_admin/articles', ensureMainAdminOnly, pages.adminArticlesPage);
router.get('/jpsme_admin/articles/new', ensureMainAdminOnly, pages.adminCreateArticlePage);
router.get('/jpsme_admin/articles/:id/edit', ensureMainAdminOnly, pages.adminEditArticlePage);
//end

// A stand-in for another system, for testing the integration API locally.
// No login: the thing it imitates has none. The controller refuses to serve it
// when NODE_ENV is production.
// Getting back in. Reachable while signed out, obviously, but NOT behind
// ensureGuest: somebody already signed in on one device may well be resetting
// because they are locked out on another.
router.get('/forgot-password', withCsrfToken, pages.forgotPasswordPage);
router.get('/reset-password', withCsrfToken, pages.resetPasswordPage);

router.get('/integration-demo', withCsrfToken, pages.integrationDemoPage);

router.get('/jpsme_admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('jpsme.sid');
    res.redirect('/jpsme_admin/login');
  });
});

module.exports = router;
