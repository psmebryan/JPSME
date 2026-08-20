const asyncHandler = require('../utils/asyncHandler');
const eventService = require('../services/event.service');
const userService = require('../services/user.service');
const authService = require('../services/auth.service');
const chapterService = require('../services/chapter.service');
const settingsService = require('../services/settings.service');
const registrationService = require('../services/registration.service');
const emailVerificationService = require('../services/emailVerification.service');
const statsService = require('../services/stats.service');
const sponsorService = require('../services/sponsor.service');
const certificateService = require('../services/certificate.service');
const paymentService = require('../services/payment.service');
const emailTemplateService = require('../services/emailTemplate.service');
const broadcastEmailService = require('../services/broadcastEmail.service');
const auditService = require('../services/audit.service');
const AppError = require('../utils/AppError');

const home = asyncHandler(async (req, res) => {
  const [events, stats, sponsors] = await Promise.all([
    eventService.listActiveEvents(),
    statsService.getHomeStats(),
    sponsorService.listActiveSponsors(),
  ]);
  res.render('index', { title: 'Home', events, stats, sponsors });
});

const loginPage = (req, res) => res.render('login', { title: 'Login' });

const aboutPage = (req, res) => res.render('about', { title: 'About' });

const contactPage = (req, res) => res.render('contact', { title: 'Contact Us' });

// TODO: replace with the real AnyFlip embed URL for the Quality Policy
// document (AnyFlip > Publish > Embed > copy the iframe "src").
const qualityPolicyPage = (req, res) => res.render('quality-policy', {
  title: 'About',
  flipbookEmbedUrl: 'https://online.anyflip.com/wrjin/uull/index.html',
});

// TODO: replace these with real content once it's ready; for now they just
// keep the About dropdown links (navbar.ejs) from 404ing.
const aboutPlaceholderPage = (heading) => (req, res) => res.render('about-placeholder', { title: 'About', heading });
const codeOfEthicsPage = aboutPlaceholderPage('Code of Ethics');
const themeOfTheYearPage = aboutPlaceholderPage('Theme of the Year');
const officersPage = aboutPlaceholderPage('Officers');
const membershipPage = aboutPlaceholderPage('Membership');

const registerPage = asyncHandler(async (req, res) => {
  const chapters = await chapterService.listChapters();
  const activeChapters = chapters.filter((chapter) => chapter.isActive !== false);
  res.render('register', { title: 'Create Account', chapters: activeChapters });
});

const verifyEmailPage = asyncHandler(async (req, res) => {
  try {
    await emailVerificationService.verifyEmailToken(req.query.token);
    res.render('verify-email', { title: 'Email Verified', success: true, message: 'Your email is verified. Log in to complete your membership payment — an admin will review and approve your account once it\'s received.' });
  } catch (err) {
    if (err instanceof AppError) {
      return res.render('verify-email', { title: 'Verification Failed', success: false, message: err.message });
    }
    throw err;
  }
});

const eventsPage = asyncHandler(async (req, res) => {
  const upcomingPage = Math.max(1, parseInt(req.query.upcomingPage, 10) || 1);
  const endedPage = Math.max(1, parseInt(req.query.endedPage, 10) || 1);

  const listing = await eventService.getPublicEventsListing({ upcomingPage, endedPage });

  let registeredEventIds = [];
  if (req.session.user && req.session.user.role !== 'ADMIN') {
    registeredEventIds = await registrationService.getRegisteredEventIds(req.session.user.id);
  }

  res.render('events', {
    title: 'Events',
    ...listing,
    registeredEventIds,
  });
});

const eventDetailPage = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id);

  let isRegistered = false;
  let registrationStatus = null;
  if (req.session.user && req.session.user.role !== 'ADMIN') {
    registrationStatus = await registrationService.getRegistrationStatus(req.session.user.id, event.id);
    isRegistered = registrationStatus === 'REGISTERED';
  }

  res.render('event-details', { title: event.title, event, isRegistered, registrationStatus });
});

const profilePage = asyncHandler(async (req, res) => {
  const [userProfile, registrations, chapters] = await Promise.all([
    authService.getById(req.session.user.id),
    registrationService.getUserRegistrations(req.session.user.id),
    chapterService.listChapters(),
  ]);

  const activeChapters = chapters.filter((chapter) => chapter.isActive !== false);

  const registeredEventIds = registrations
    .filter((reg) => reg.status === 'REGISTERED')
    .map((reg) => reg.eventId);
  const certifiedEventIds = Array.from(await certificateService.getCertifiedEventIds(req.session.user.id, registeredEventIds));

  res.render('profile', {
    title: 'My Profile',
    userProfile,
    registrations,
    chapters: activeChapters,
    certifiedEventIds,
  });
});

const membershipPaymentPage = asyncHandler(async (req, res) => {
  const [payment, feeCentavos] = await Promise.all([
    paymentService.getLatestMembershipPayment(req.session.user.id),
    settingsService.getMembershipFeeCentavos(),
  ]);
  res.render('membership-payment', { title: 'Membership Payment', payment, feeCentavos });
});

const membershipPaymentReturnPage = asyncHandler(async (req, res) => {
  // This is PayMongo's redirect target after checkout — it only ever reflects
  // whatever the webhook has already confirmed in the database. It never marks
  // anything paid itself, no matter what query params the redirect carries.
  const payment = await paymentService.getLatestMembershipPayment(req.session.user.id);
  res.render('membership-payment-return', { title: 'Payment Status', payment });
});

// Same rule as membershipPaymentReturnPage above — this only ever reflects
// the webhook-confirmed Payment row, never anything from the redirect itself.
const eventPaymentReturnPage = asyncHandler(async (req, res) => {
  const [event, payment] = await Promise.all([
    eventService.getEventById(req.params.id),
    paymentService.getLatestEventPayment(req.session.user.id, req.params.id),
  ]);
  res.render('event-payment-return', { title: 'Payment Status', event, payment });
});

const adminLoginPage = (req, res) => res.render('admin/login', { title: 'Admin Login', layout: 'admin/layout-guest' });

// The admin sidebar loads modules via AJAX (see admin-nav.js), so each admin page
// renders as a bare fragment for that request and as a full page otherwise.
function renderAdmin(req, res, view, locals) {
  if (req.get('X-Requested-With') === 'fragment') {
    res.set('X-Page-Title', encodeURIComponent(locals.title));
    return res.render(view, { ...locals, layout: false });
  }
  return res.render(view, { ...locals, layout: 'admin/layout' });
}

const adminDashboardPage = asyncHandler(async (req, res) => {
  const isMainAdmin = req.session.user.role === 'ADMIN';

  if (isMainAdmin) {
    const dashboard = await statsService.getMainAdminDashboard();
    return renderAdmin(req, res, 'admin/dashboard', { title: 'Admin Dashboard', isMainAdmin, ...dashboard });
  }

  const dashboard = req.session.user.chapterId
    ? await statsService.getChapterAdminDashboard(req.session.user.chapterId)
    : { totals: { totalMembers: 0, pendingApprovals: 0 }, upcomingEvents: [] };
  return renderAdmin(req, res, 'admin/dashboard', { title: 'Admin Dashboard', isMainAdmin, ...dashboard });
});

const adminUsersPage = asyncHandler(async (req, res) => {
  // support multiple entry paths: '/admin/users/approvals' and '/admin/users/all'
  const path = req.path || '';
  let viewMode = 'approvals';
  let title = 'Pending User Approvals';
  if (path === '/admin/users/all') {
    viewMode = 'list';
    title = 'Manage Users';
  }
  // fetch chapters for assignment dropdown
  const chapters = await chapterService.listChapters();
  const currentUser = req.session.user ? { role: req.session.user.role, chapterId: req.session.user.chapterId } : { role: null, chapterId: null };
  renderAdmin(req, res, 'admin/users', { title, viewMode, chapters, currentUser });
});

const adminEventsPage = asyncHandler(async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const modality = (req.query.modality || '').toString();
  const published = (req.query.published || '').toString();
  const upcomingPage = Math.max(1, parseInt(req.query.upcomingPage, 10) || 1);
  const endedPage = Math.max(1, parseInt(req.query.endedPage, 10) || 1);
  const tablePage = Math.max(1, parseInt(req.query.tablePage, 10) || 1);

  const listing = await eventService.getAdminEventsListing({
    search,
    modality,
    published,
    upcomingPage,
    endedPage,
    tablePage,
  });

  renderAdmin(req, res, 'admin/events', {
    title: 'Manage Events',
    ...listing,
    search,
    modality,
    published,
  });
});

const adminSettingsPage = asyncHandler(async (req, res) => {
  const [logoUrl, membershipFeeCentavos, paymentsEnabled] = await Promise.all([
    settingsService.getLogoUrl(),
    settingsService.getMembershipFeeCentavos(),
    settingsService.getPaymentsEnabled(),
  ]);
  renderAdmin(req, res, 'admin/settings', { title: 'Site Settings', logoUrl, membershipFeeCentavos, paymentsEnabled });
});

const adminSponsorsPage = asyncHandler(async (req, res) => {
  const sponsors = await sponsorService.listSponsors();
  renderAdmin(req, res, 'admin/sponsors', { title: 'Manage Sponsors', sponsors });
});

// MAIN_ADMIN only (route-gated) — chapter admins have no access to payment data.
const adminPaymentsPage = asyncHandler(async (req, res) => {
  const [summary, listing] = await Promise.all([
    paymentService.getPaymentSummary(),
    paymentService.listPaymentsForAdmin({ page: 1 }),
  ]);

  renderAdmin(req, res, 'admin/payments', {
    title: 'Payments',
    summary,
    isMainAdmin: true,
    ...listing,
  });
});

const adminCertificatesPage = asyncHandler(async (req, res) => {
  const template = await certificateService.getMembershipTemplate();
  renderAdmin(req, res, 'admin/certificates', { title: 'Membership Certificate', template });
});

const adminEventCertificatesListPage = asyncHandler(async (req, res) => {
  const events = await certificateService.listEventCertificateSummaries();
  renderAdmin(req, res, 'admin/event-certificates', { title: 'Event Certificates', events });
});

const adminEventCertificatePage = asyncHandler(async (req, res) => {
  const [event, template, registrants] = await Promise.all([
    eventService.getEventById(req.params.id),
    certificateService.getEventTemplate(req.params.id),
    certificateService.listEventCertificateStatus(req.params.id, 'all'),
  ]);
  renderAdmin(req, res, 'admin/event-certificate', {
    title: `Certificate — ${event.title}`,
    event,
    template,
    registrants,
    filter: 'all',
  });
});

const adminEmailsPage = asyncHandler(async (req, res) => {
  const template = await emailTemplateService.getMemberApprovedTemplate();
  renderAdmin(req, res, 'admin/emails', { title: 'Membership Email', template });
});

const adminEventEmailsListPage = asyncHandler(async (req, res) => {
  const events = await eventService.listAllEvents();
  renderAdmin(req, res, 'admin/event-emails', { title: 'Event Emails', events });
});

const adminEventEmailPage = asyncHandler(async (req, res) => {
  const [event, template] = await Promise.all([
    eventService.getEventById(req.params.id),
    emailTemplateService.getEventTemplate(req.params.id),
  ]);
  renderAdmin(req, res, 'admin/event-email', {
    title: `Email — ${event.title}`,
    event,
    template,
  });
});

const adminBroadcastsPage = asyncHandler(async (req, res) => {
  const [broadcasts, chapters, members] = await Promise.all([
    broadcastEmailService.listBroadcasts(),
    chapterService.listChapters(),
    userService.listByStatus('APPROVED'),
  ]);
  renderAdmin(req, res, 'admin/broadcasts', {
    title: 'Broadcast Email',
    broadcasts,
    chapters,
    members,
  });
});

const adminAuditLogPage = asyncHandler(async (req, res) => {
  const { action, actor, targetUserId, paymentId, dateFrom, dateTo, page } = req.query;

  const [listing, admins] = await Promise.all([
    auditService.listAuditLogs({
      action: action || undefined,
      actor: actor || undefined,
      targetUserId: targetUserId || undefined,
      paymentId: paymentId || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      page: Math.max(1, parseInt(page, 10) || 1),
    }),
    userService.listAdmins(),
  ]);

  renderAdmin(req, res, 'admin/audit-log', {
    title: 'Audit Log',
    ...listing,
    admins,
    filters: { action: action || '', actor: actor || '', targetUserId: targetUserId || '', paymentId: paymentId || '', dateFrom: dateFrom || '', dateTo: dateTo || '' },
    auditActions: auditService.AUDIT_ACTIONS,
  });
});

const chaptersPage = asyncHandler(async (req, res) => {
  const regions = await chapterService.listChaptersGrouped();
  res.render('chapters', { title: 'Chapters', regions });
});

const chapterRegionPage = asyncHandler(async (req, res) => {
  const region = await chapterService.getRegionWithChapters(Number(req.params.id));
  if (!region) throw new AppError('Region not found', 404);
  res.render('chapters-region', { title: region.name, region });
});

const chapterDetailPage = asyncHandler(async (req, res) => {
  const chapter = await chapterService.getChapterWithRegion(Number(req.params.id));
  if (!chapter) throw new AppError('Chapter not found', 404);
  res.render('chapter-detail', { title: chapter.name, chapter });
});

const adminChaptersPage = asyncHandler(async (req, res) => {
  const [regions, areas, chapters] = await Promise.all([
    chapterService.listRegions(),
    chapterService.listAreas(),
    chapterService.listChapters(),
  ]);
  renderAdmin(req, res, 'admin/chapters', { title: 'Manage Chapters', regions, areas, chapters });
});

const adminChapterMembersPage = asyncHandler(async (req, res) => {
  let chapterId = null;
  if (req.session.user.role === 'CHAPTER_ADMIN') chapterId = req.session.user.chapterId;
  if (req.session.user.role === 'ADMIN' && req.query.chapterId) chapterId = req.query.chapterId;

  let members = [];
  let chapter = null;
  let leader = null;

  if (chapterId) {
    [members, chapter] = await Promise.all([
      userService.listByChapter(chapterId),
      chapterService.getChapterById(Number(chapterId)),
    ]);
    leader = members.find((m) => m.role === 'CHAPTER_ADMIN') || null;
  }

  renderAdmin(req, res, 'admin/chapter-members', {
    title: chapter ? `${chapter.name} Members` : 'Chapter Members',
    members,
    chapter,
    chapterId,
    leader,
  });
});

const adminChapterAdminsPage = asyncHandler(async (req, res) => {
  const [chaptersWithStats, chapters, users] = await Promise.all([
    chapterService.listChaptersWithStats(),
    chapterService.listChapters(),
    userService.listByStatus('APPROVED'),
  ]);
  renderAdmin(req, res, 'admin/chapter-admins', {
    title: 'Chapter Admins',
    chaptersWithStats,
    chapters,
    users,
    csrfToken: req.session.csrfToken,
  });
});

const adminEditUserPage = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id);
  const isChapterAdmin = req.session.user && req.session.user.role === 'CHAPTER_ADMIN';

  if (isChapterAdmin) {
    const adminChapterId = req.session.user.chapterId;
    if (!user.chapter || Number(user.chapter.id) !== Number(adminChapterId)) {
      throw new AppError('User not found', 404);
    }
  }

  const chapters = await chapterService.listChapters();
  renderAdmin(req, res, 'admin/user-edit', {
    title: isChapterAdmin ? 'Edit Member' : 'Edit User',
    user,
    chapters,
    csrfToken: req.session.csrfToken,
    restricted: isChapterAdmin,
  });
});

const adminDeleteChapterMember = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id);
  const isChapterAdmin = req.session.user && req.session.user.role === 'CHAPTER_ADMIN';

  if (isChapterAdmin) {
    const adminChapterId = req.session.user.chapterId;
    if (!user.chapter || Number(user.chapter.id) !== Number(adminChapterId)) {
      throw new AppError('User not found', 404);
    }
  }

  await userService.deleteUser(req.params.id);
  res.redirect(isChapterAdmin ? '/admin/chapter-members' : '/admin/users/all');
});

const adminCreateRegion = asyncHandler(async (req, res) => {
  await chapterService.createRegion({ name: req.body.name });
  res.redirect('/admin/chapters');
});

const adminDeleteRegion = asyncHandler(async (req, res) => {
  await chapterService.deleteRegion(Number(req.params.id));
  res.redirect('/admin/chapters');
});

const adminCreateArea = asyncHandler(async (req, res) => {
  await chapterService.createArea({ name: req.body.name, regionId: Number(req.body.regionId) });
  res.redirect('/admin/chapters');
});

const adminDeleteArea = asyncHandler(async (req, res) => {
  await chapterService.deleteArea(Number(req.params.id));
  res.redirect('/admin/chapters');
});

const adminCreateChapter = asyncHandler(async (req, res) => {
  await chapterService.createChapter({
    name: req.body.name,
    yearFounded: Number(req.body.yearFounded),
    areaId: Number(req.body.areaId),
    isActive: req.body.isActive === 'on',
  });
  res.redirect('/admin/chapters');
});

const adminEditChapterPage = asyncHandler(async (req, res) => {
  const [chapter, areas] = await Promise.all([
    chapterService.getChapterById(Number(req.params.id)),
    chapterService.listAreas(),
  ]);
  if (!chapter) throw new AppError('Chapter not found', 404);
  renderAdmin(req, res, 'admin/chapter-edit', { title: 'Edit Chapter', chapter, areas });
});

const adminUpdateChapter = asyncHandler(async (req, res) => {
  await chapterService.updateChapter(Number(req.params.id), {
    name: req.body.name,
    yearFounded: Number(req.body.yearFounded),
    areaId: Number(req.body.areaId),
    isActive: req.body.isActive === 'on',
  });
  res.redirect('/admin/chapters');
});

const adminDeleteChapter = asyncHandler(async (req, res) => {
  await chapterService.deleteChapter(Number(req.params.id));
  res.redirect('/admin/chapters');
});

// Render the admin "Create Event" page (Add Event)
const adminCreateEventPage = asyncHandler(async (req, res) => {
  renderAdmin(req, res, 'admin/event-new', { title: 'Create Event' });
});

// Admin edit event page
const adminEditEventPage = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id);
  renderAdmin(req, res, 'admin/event-edit', { title: 'Edit Event', event });
});

// Admin view registrations page
const adminEventRegistrationsPage = asyncHandler(async (req, res) => {
  const [event, registrations] = await Promise.all([
    eventService.getEventById(req.params.id),
    registrationService.getEventRegistrations(req.params.id),
  ]);
  renderAdmin(req, res, 'admin/event-registrations', { title: `Registrations — ${event.title}`, event, registrations });
});

module.exports = {
  home,
  aboutPage,
  qualityPolicyPage,
  codeOfEthicsPage,
  themeOfTheYearPage,
  officersPage,
  membershipPage,
  contactPage,
  loginPage,
  registerPage,
  verifyEmailPage,
  eventsPage,
  eventDetailPage,
  profilePage,
  membershipPaymentPage,
  membershipPaymentReturnPage,
  eventPaymentReturnPage,
  adminLoginPage,
  adminDashboardPage,
  adminUsersPage,
  adminEventsPage,
  adminCreateEventPage,
  adminEditEventPage,
  adminEventRegistrationsPage,
  adminSettingsPage,
  adminSponsorsPage,
  adminPaymentsPage,
  adminCertificatesPage,
  adminEventCertificatesListPage,
  adminEventCertificatePage,
  adminEmailsPage,
  adminEventEmailsListPage,
  adminEventEmailPage,
  adminBroadcastsPage,
  adminAuditLogPage,
  chaptersPage,
  chapterRegionPage,
  chapterDetailPage,
  adminChaptersPage,
  adminChapterMembersPage,
  adminChapterAdminsPage,
  adminEditUserPage,
  adminDeleteChapterMember,
  adminCreateRegion,
  adminDeleteRegion,
  adminCreateArea,
  adminDeleteArea,
  adminCreateChapter,
  adminEditChapterPage,
  adminUpdateChapter,
  adminDeleteChapter,
};
