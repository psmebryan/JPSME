const asyncHandler = require('../utils/asyncHandler');
const eventService = require('../services/event.service');
const userService = require('../services/user.service');
const authService = require('../services/auth.service');
const chapterService = require('../services/chapter.service');
const settingsService = require('../services/settings.service');
const registrationService = require('../services/registration.service');
const invitationService = require('../services/invitation.service');
const emailVerificationService = require('../services/emailVerification.service');
const statsService = require('../services/stats.service');
const sponsorService = require('../services/sponsor.service');
const certificateService = require('../services/certificate.service');
const paymentService = require('../services/payment.service');
const emailTemplateService = require('../services/emailTemplate.service');
const broadcastEmailService = require('../services/broadcastEmail.service');
const auditService = require('../services/audit.service');
const articleService = require('../services/article.service');
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
  // Same-site-only, mirroring the login page's own ?next= guard — this one
  // just gets embedded as a hidden field and re-validated/sanitized again
  // server-side at actual registration time (auth.service.js), so a bad
  // value here is harmless either way.
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')
    ? req.query.next
    : '';
  res.render('register', { title: 'Create Account', chapters: activeChapters, next });
});

const verifyEmailPage = asyncHandler(async (req, res) => {
  try {
    const user = await emailVerificationService.verifyEmailToken(req.query.token);
    // Mentioned here, not just saved silently, so they know their original
    // intent (e.g. the event they wanted to attend) wasn't lost — it'll
    // resurface automatically once payment + admin approval clears and they
    // log in for the first time (see auth.service.js's login).
    const message = user.postApprovalRedirectUrl
      ? 'Your email is verified. Log in to complete your membership payment — an admin will review and approve your account once it\'s received. Once approved, logging in will take you straight back to the event you wanted to join.'
      : 'Your email is verified. Log in to complete your membership payment — an admin will review and approve your account once it\'s received.';
    res.render('verify-email', { title: 'Email Verified', success: true, message });
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

  // Previewed before "Register & Pay" so the total on PayMongo's own checkout
  // page (fee + this same surcharge, itemized) isn't a surprise.
  const surchargeCentavos = event.feeCentavos > 0 ? await paymentService.calculateGatewaySurcharge(event.feeCentavos) : 0;

  res.render('event-details', { title: event.title, event, isRegistered, registrationStatus, surchargeCentavos });
});

// PayMongo's redirect-return pages aside, this is the one other place a
// visitor can land without ever having clicked "Register" themselves — via
// an emailed invitation link. Reuses the same event-details template (not a
// separate page) so the registration flow itself (free vs paid, login gate)
// stays exactly one code path; only the extra `invitation` local changes
// what's shown.
const eventInvitePage = asyncHandler(async (req, res) => {
  const invitation = await invitationService.getInvitationByToken(req.params.token);
  if (invitation.eventId !== Number(req.params.id)) {
    throw new AppError('This invitation is for a different event.', 400);
  }
  await invitationService.markClicked(req.params.token);

  const event = invitation.event;
  let isRegistered = false;
  let registrationStatus = null;
  let invitationMismatch = false;
  if (req.session.user && req.session.user.role !== 'ADMIN') {
    registrationStatus = await registrationService.getRegistrationStatus(req.session.user.id, event.id);
    isRegistered = registrationStatus === 'REGISTERED';
    // Checked here too (not just at register-submit time) so a logged-in
    // visitor who isn't who this was sent to sees a clear explanation
    // instead of clicking Register and hitting a raw 403.
    invitationMismatch = invitation.userId
      ? invitation.userId !== req.session.user.id
      : invitation.email.toLowerCase() !== req.session.user.email.toLowerCase();
  }

  const surchargeCentavos = event.feeCentavos > 0 ? await paymentService.calculateGatewaySurcharge(event.feeCentavos) : 0;

  res.render('event-details', { title: event.title, event, isRegistered, registrationStatus, invitation, invitationMismatch, surchargeCentavos });
});

// One-click RSVP link embedded directly in the invitation email's
// {{attendUrl}} token — lets a guest (no account) confirm/decline straight
// from their inbox with no page-load-then-click step. Always lands on the
// normal invite page afterward, whether it worked or not: a member clicking
// this (recordRsvp's 409 guard) just sees their normal registration flow
// instead of a raw error, since that's genuinely the right flow for them.
const submitRsvpFromEmailPage = asyncHandler(async (req, res) => {
  const status = req.params.status === 'attending' ? 'ATTENDING' : 'NOT_ATTENDING';
  try {
    await invitationService.recordRsvp(req.params.token, req.params.id, status);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  res.redirect(`/events/${req.params.id}/invite/${req.params.token}`);
});

const articlesPage = asyncHandler(async (req, res) => {
  const category = (req.query.category || '').toString().trim();
  const [articles, categories] = await Promise.all([
    articleService.listPublishedArticles(category || undefined),
    articleService.listCategories(),
  ]);
  res.render('articles', { title: 'Articles', articles, categories, activeCategory: category });
});

const articleDetailPage = asyncHandler(async (req, res) => {
  const article = await articleService.getPublishedArticleById(req.params.id);
  res.render('article-details', { title: article.title, article });
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
  // Shown before they click "Continue to Payment" so the total on PayMongo's
  // own checkout page (fee + this same surcharge, itemized) isn't a surprise.
  const surchargeCentavos = await paymentService.calculateGatewaySurcharge(feeCentavos);
  res.render('membership-payment', { title: 'Membership Payment', payment, feeCentavos, surchargeCentavos });
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
  const [logoUrl, membershipFeeCentavos, paymentsEnabled, gatewaySurchargePercent] = await Promise.all([
    settingsService.getLogoUrl(),
    settingsService.getMembershipFeeCentavos(),
    settingsService.getPaymentsEnabled(),
    settingsService.getGatewaySurchargePercent(),
  ]);
  renderAdmin(req, res, 'admin/settings', { title: 'Site Settings', logoUrl, membershipFeeCentavos, paymentsEnabled, gatewaySurchargePercent });
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
  const [event, template, invitationTemplate] = await Promise.all([
    eventService.getEventById(req.params.id),
    emailTemplateService.getEventTemplate(req.params.id),
    emailTemplateService.getEventInvitationTemplate(req.params.id),
  ]);
  renderAdmin(req, res, 'admin/event-email', {
    title: `Email — ${event.title}`,
    event,
    template,
    invitationTemplate,
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
  const isMainAdmin = req.session.user.role === 'ADMIN';
  const search = (req.query.search || '').toString().trim();
  const status = (req.query.status || '').toString();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [event, result] = await Promise.all([
    eventService.getEventById(req.params.id),
    registrationService.getEventRegistrationsForAdmin(req.params.id, { search, status, page }),
  ]);
  renderAdmin(req, res, 'admin/event-registrations', {
    title: `Registrations — ${event.title}`,
    event,
    registrations: result.registrations,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
    search,
    status,
    isMainAdmin,
  });
});

// Admin — Invitations (MAIN_ADMIN only). A standalone module rather than
// buried inside one event's registrations page — the dropdown at the top
// picks which event's invitations/report to view, so this is the one place
// to manage invitations across every event instead of drilling into each
// event individually.
const adminInvitationsPage = asyncHandler(async (req, res) => {
  const events = await eventService.listAllEvents();
  const eventId = req.query.eventId ? Number(req.query.eventId) : null;

  // Lets the sidebar's "Invitation Requests" link land here pre-filtered
  // (?source=SELF_REQUESTED) instead of needing a separate page/route for
  // what's really just this same report with one filter pre-set.
  const sourceFilter = req.query.source === 'SELF_REQUESTED' ? 'SELF_REQUESTED' : '';

  let selectedEvent = null;
  let members = [];
  let summary = null;
  let invitedEmailStatuses = [];
  const reportParams = { eventId: eventId || undefined, source: sourceFilter || undefined, page: 1 };

  const [reportResult, filterOptions] = await Promise.all([
    invitationService.listInvitationsForAdmin(reportParams),
    invitationService.getInvitationFilterOptions(eventId),
  ]);

  if (eventId) {
    [selectedEvent, members, summary, invitedEmailStatuses] = await Promise.all([
      eventService.getEventById(eventId),
      userService.listByStatus('APPROVED'),
      invitationService.getInvitationSummary(eventId),
      invitationService.getInvitedEmailStatusesForEvent(eventId),
    ]);
  }

  renderAdmin(req, res, 'admin/invitations', {
    title: 'Invitations',
    events,
    selectedEvent,
    invitations: reportResult.invitations,
    total: reportResult.total,
    page: reportResult.page,
    totalPages: reportResult.totalPages,
    filterOptions,
    summary,
    members,
    invitedEmailStatuses,
    sourceFilter,
  });
});

// Admin — Articles (MAIN_ADMIN only, route-gated)
const adminArticlesPage = asyncHandler(async (req, res) => {
  const articles = await articleService.listAllArticles();
  renderAdmin(req, res, 'admin/articles', { title: 'Manage Articles', articles });
});

const adminCreateArticlePage = asyncHandler(async (req, res) => {
  renderAdmin(req, res, 'admin/article-new', { title: 'Create Article' });
});

const adminEditArticlePage = asyncHandler(async (req, res) => {
  const article = await articleService.getArticleById(req.params.id);
  renderAdmin(req, res, 'admin/article-edit', { title: 'Edit Article', article });
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
  eventInvitePage,
  submitRsvpFromEmailPage,
  articlesPage,
  articleDetailPage,
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
  adminInvitationsPage,
  adminArticlesPage,
  adminCreateArticlePage,
  adminEditArticlePage,
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
