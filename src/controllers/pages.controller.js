const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const eventService = require('../services/event.service');
const userService = require('../services/user.service');
const authService = require('../services/auth.service');
const organizationService = require('../services/organization.service');
const organizationAdminService = require('../services/organizationAdmin.service');
const settingsService = require('../services/settings.service');
const checkinService = require('../services/checkin.service');
const ticketService = require('../services/ticket.service');
const qrService = require('../services/qr.service');
const checkinReportService = require('../services/checkinReport.service');
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
  // The picker is search-driven (see /api/organizations/search); this seeds it
  // with a first page so the form is usable before the user types anything.
  const seed = await organizationService.searchOrganizations({ page: 1, pageSize: 50 });
  // Same-site-only, mirroring the login page's own ?next= guard — this one
  // just gets embedded as a hidden field and re-validated/sanitized again
  // server-side at actual registration time (auth.service.js), so a bad
  // value here is harmless either way.
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')
    ? req.query.next
    : '';
  res.render('register', { title: 'Create Account', organizations: seed.organizations, next });
});

// Now a form rather than a landing page for a link. Verification happens when
// the person types the code, so this renders the same whether they arrived
// straight from registering or came back to it hours later.
//
// ?email= only prefills the field as a convenience after registering. It
// confirms nothing on its own — the code is still required, and an address
// that is not registered is answered exactly like a wrong code.
const verifyEmailPage = asyncHandler(async (req, res) => {
  const paymentRequired = await settingsService.getMembershipPaymentRequired().catch(() => false);
  res.render('verify-email', {
    title: 'Verify your email',
    email: typeof req.query.email === 'string' ? req.query.email.slice(0, 200) : '',
    paymentRequired,
  });
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

  res.render('event-details', {
    title: event.title, event, isRegistered, registrationStatus, surchargeCentavos,
    // Computed from the same helper registration.service enforces with, so the
    // page and the server can never disagree about whether this is still open.
    hasEnded: eventService.hasEventEnded(event),
  });
});

// A member's own ticket, on screen. The PDF is for printing and for keeping;
// this is for the thirty seconds at an entrance where someone holds up a phone.
// The code is inlined as a data URI rather than loaded from the PNG endpoint so
// it is already painted when the page appears — a door is exactly where a
// second request has the worst chance of completing.
const eventTicketPage = asyncHandler(async (req, res) => {
  const registration = await ticketService.getTicket(req.session.user.id, req.params.id);
  const qrDataUrl = await qrService.renderQrDataUrl(registration.qrToken, { width: 600 });
  res.render('event-ticket', {
    title: 'My Ticket',
    registration,
    event: registration.event,
    qrDataUrl,
  });
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

  res.render('event-details', {
    title: event.title, event, isRegistered, registrationStatus, invitation, invitationMismatch, surchargeCentavos,
    hasEnded: eventService.hasEventEnded(event),
  });
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
  const [userProfile, registrations, orgSeed, membership] = await Promise.all([
    authService.getById(req.session.user.id),
    registrationService.getUserRegistrations(req.session.user.id),
    organizationService.searchOrganizations({ page: 1, pageSize: 50 }),
    paymentService.getMembershipStatus(req.session.user.id),
  ]);

  const organizationPath = userProfile.organizationId
    ? await organizationService.getOrganizationPathLabel(userProfile.organizationId)
    : null;

  const registeredEventIds = registrations
    .filter((reg) => reg.status === 'REGISTERED')
    .map((reg) => reg.eventId);
  const certifiedEventIds = Array.from(await certificateService.getCertifiedEventIds(req.session.user.id, registeredEventIds));

  res.render('profile', {
    title: 'My Profile',
    userProfile,
    registrations,
    membership,
    organizations: orgSeed.organizations,
    organizationPath,
    certifiedEventIds,
  });
});

const membershipPaymentPage = asyncHandler(async (req, res) => {
  const [payment, feeCentavos, membershipPaymentRequired, membership] = await Promise.all([
    paymentService.getLatestMembershipPayment(req.session.user.id),
    settingsService.getMembershipFeeCentavos(),
    settingsService.getMembershipPaymentRequired(),
    paymentService.getMembershipStatus(req.session.user.id),
  ]);
  // Shown before they click "Continue to Payment" so the total on PayMongo's
  // own checkout page (fee + this same surcharge, itemized) isn't a surprise.
  const surchargeCentavos = await paymentService.calculateGatewaySurcharge(feeCentavos);
  res.render('membership-payment', {
    title: 'Membership Payment', payment, feeCentavos, surchargeCentavos, membershipPaymentRequired, membership,
  });
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

  const dashboard = req.session.user.organizationId
    ? await statsService.getOrganizationAdminDashboard(req.session.user.organizationId)
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
  // Organizations for the assignment dropdown — one page; the picker searches
  // server-side for anything beyond this. Narrowed to the two fields the client
  // actually uses (see admin.js's option renderers and doAssign): shipping whole
  // rows also embedded importNote/path/timestamps into the page for no reason.
  const orgSeed = await organizationService.searchOrganizations({ page: 1, pageSize: 50 });
  const organizations = orgSeed.organizations.map((o) => ({ id: o.id, name: o.name }));
  const currentUser = req.session.user
    ? { role: req.session.user.role, organizationId: req.session.user.organizationId }
    : { role: null, organizationId: null };
  renderAdmin(req, res, 'admin/users', { title, viewMode, organizations, currentUser });
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
  const [logoUrl, membershipFeeCentavos, paymentsEnabled, gatewaySurchargePercent, membershipPaymentRequired] = await Promise.all([
    settingsService.getLogoUrl(),
    settingsService.getMembershipFeeCentavos(),
    settingsService.getPaymentsEnabled(),
    settingsService.getGatewaySurchargePercent(),
    settingsService.getMembershipPaymentRequired(),
  ]);
  renderAdmin(req, res, 'admin/settings', { title: 'Site Settings', logoUrl, membershipFeeCentavos, paymentsEnabled, gatewaySurchargePercent, membershipPaymentRequired });
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
  const [broadcasts, orgSeed, members] = await Promise.all([
    broadcastEmailService.listBroadcasts(),
    organizationService.searchOrganizations({ page: 1, pageSize: 50 }),
    userService.listByStatus('APPROVED'),
  ]);
  renderAdmin(req, res, 'admin/broadcasts', {
    title: 'Broadcast Email',
    broadcasts,
    organizations: orgSeed.organizations,
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

// Public browse. Renders one level at a time from the real tree rather than a
// fixed region>area>chapter nesting, so a branch with no cluster simply shows
// its chapters directly — no empty level is displayed just to pad the shape.
const organizationsPage = asyncHandler(async (req, res) => {
  const root = await prisma.organization.findFirst({ where: { parentId: null } });
  const children = root ? await organizationService.getChildren(root.id, { activeOnly: true }) : [];
  res.render('organizations', { title: 'Organizations', root, children });
});

const organizationDetailPage = asyncHandler(async (req, res) => {
  const organization = await organizationService.getOrganization(Number(req.params.id));
  if (!organization) throw new AppError('Organization not found', 404);
  const [ancestors, children, memberCount] = await Promise.all([
    organizationService.getAncestors(organization.id),
    organizationService.getChildren(organization.id, { activeOnly: true }),
    organizationService.countMembersInSubtree(organization.id),
  ]);
  res.render('organization-detail', {
    title: organization.name, organization, ancestors, children, memberCount,
  });
});

// Paginated + filterable, per the 5K work — the tree can hold thousands of
// organizations, so this never loads it wholesale. needsReview surfaces the
// rows the Excel import could not fully resolve.
const adminOrganizationsPage = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const q = (req.query.q || '').toString().trim();
  const type = (req.query.type || '').toString();
  const needsReview = req.query.needsReview === '1';

  const [result, root, reviewCount] = await Promise.all([
    organizationService.listForAdmin({ q, type, needsReview, page }),
    prisma.organization.findFirst({ where: { parentId: null } }),
    prisma.organization.count({ where: { needsReview: true } }),
  ]);

  renderAdmin(req, res, 'admin/organizations', {
    title: 'Manage Organizations',
    organizations: result.organizations,
    total: result.total, page: result.page, totalPages: result.totalPages,
    q, type, needsReview, reviewCount, root,
  });
});

// The hierarchy as a tree rather than a flat page of rows — the shape is the
// point, and a paginated table can't show that a chapter sits directly under a
// region with no cluster between them. Only the first level is rendered here;
// deeper levels load on expand via /api/admin/organization-tree.
const adminOrganizationTreePage = asyncHandler(async (req, res) => {
  const root = await organizationService.getRoot();
  const [children, reviewCount] = await Promise.all([
    root ? organizationService.getChildrenForTree(root.id) : [],
    prisma.organization.count({ where: { needsReview: true } }),
  ]);
  renderAdmin(req, res, 'admin/organization-tree', {
    title: 'Organization Structure',
    root,
    children,
    reviewCount,
    typeLabels: organizationService.TYPE_LABELS,
    csrfToken: req.session.csrfToken,
  });
});

// Members of an organization AND its descendants — a cluster admin sees the
// members of the chapters and units beneath them, which the old exact-chapter
// lookup could not express.
const adminOrganizationMembersPage = asyncHandler(async (req, res) => {
  let organizationId = null;
  if (req.session.user.role === 'CHAPTER_ADMIN') organizationId = req.session.user.organizationId;
  if (req.session.user.role === 'ADMIN' && req.query.organizationId) organizationId = req.query.organizationId;

  let members = [];
  let organization = null;
  let organizationPath = null;
  let leader = null;

  if (organizationId) {
    [members, organization] = await Promise.all([
      userService.listByOrganization(organizationId),
      organizationService.getOrganization(Number(organizationId)),
    ]);
    if (organization) organizationPath = await organizationService.getOrganizationPathLabel(organization.id);
    leader = members.find((m) => m.role === 'CHAPTER_ADMIN') || null;
  }

  renderAdmin(req, res, 'admin/organization-members', {
    title: organization ? `${organization.name} Members` : 'Organization Members',
    members,
    organization,
    organizationPath,
    organizationId,
    leader,
  });
});

const adminOrganizationAdminsPage = asyncHandler(async (req, res) => {
  const [assignments, orgSeed, users] = await Promise.all([
    organizationAdminService.listAssignments(),
    organizationService.searchOrganizations({ page: 1, pageSize: 100 }),
    userService.listByStatus('APPROVED'),
  ]);
  renderAdmin(req, res, 'admin/organization-admins', {
    title: 'Organization Admins',
    assignments,
    organizations: orgSeed.organizations,
    users,
    csrfToken: req.session.csrfToken,
  });
});

const adminEditUserPage = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id);
  const isScopedAdmin = req.session.user && req.session.user.role === 'CHAPTER_ADMIN';

  if (isScopedAdmin) {
    const scopeIds = await organizationService.getDescendantIds(req.session.user.organizationId);
    if (!user.organizationId || !scopeIds.includes(Number(user.organizationId))) {
      throw new AppError('User not found', 404);
    }
  }

  const orgSeed = await organizationService.searchOrganizations({ page: 1, pageSize: 100 });
  renderAdmin(req, res, 'admin/user-edit', {
    title: isScopedAdmin ? 'Edit Member' : 'Edit User',
    user,
    organizations: orgSeed.organizations,
    csrfToken: req.session.csrfToken,
    restricted: isScopedAdmin,
  });
});

const adminDeleteOrganizationMember = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id);
  const isScopedAdmin = req.session.user && req.session.user.role === 'CHAPTER_ADMIN';

  if (isScopedAdmin) {
    const scopeIds = await organizationService.getDescendantIds(req.session.user.organizationId);
    if (!user.organizationId || !scopeIds.includes(Number(user.organizationId))) {
      throw new AppError('User not found', 404);
    }
  }

  await userService.deleteUser(req.params.id);
  res.redirect(isScopedAdmin ? '/admin/organization-members' : '/admin/users/all');
});

// One entity replaces three: the old region / area / chapter CRUD handlers
// collapse into a single set, with `type` and `parentId` supplied by the form.
const adminCreateOrganization = asyncHandler(async (req, res) => {
  await organizationService.createOrganization({
    name: req.body.name,
    type: req.body.type,
    parentId: req.body.parentId ? Number(req.body.parentId) : null,
    code: req.body.code || null,
    institution: req.body.institution || null,
    email: req.body.email || null,
    yearFounded: req.body.yearFounded ? Number(req.body.yearFounded) : null,
    isActive: req.body.isActive === 'on',
  });
  res.redirect('/admin/organizations');
});

const adminEditOrganizationPage = asyncHandler(async (req, res) => {
  const organization = await organizationService.getOrganizationOrThrow(Number(req.params.id));
  const [ancestors, children, orgSeed] = await Promise.all([
    organizationService.getAncestors(organization.id),
    organizationService.getChildren(organization.id),
    organizationService.searchOrganizations({ page: 1, pageSize: 100 }),
  ]);
  renderAdmin(req, res, 'admin/organization-edit', {
    title: 'Edit Organization',
    organization, ancestors, children,
    organizations: orgSeed.organizations,
    csrfToken: req.session.csrfToken,
  });
});

const adminUpdateOrganization = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await organizationService.updateOrganization(id, {
    name: req.body.name,
    type: req.body.type,
    code: req.body.code || null,
    institution: req.body.institution || null,
    email: req.body.email || null,
    yearFounded: req.body.yearFounded,
    isActive: req.body.isActive === 'on',
    // Resolving an imported row is exactly what clears its review flag.
    needsReview: req.body.needsReview === 'on',
  });
  // Reparenting is a separate operation because it rewrites a whole subtree's
  // materialized paths and must reject cycles — see moveOrganization.
  if (req.body.parentId && Number(req.body.parentId) !== Number(req.body.currentParentId)) {
    await organizationService.moveOrganization(id, Number(req.body.parentId));
  }
  res.redirect('/admin/organizations');
});

const adminDeleteOrganization = asyncHandler(async (req, res) => {
  await organizationService.deleteOrganization(Number(req.params.id));
  res.redirect('/admin/organizations');
});

// The Excel import left ~180 rows needing a real parent assigned by hand
// (see organization.service.js's importOrganizations note) — reassigning one
// at a time through adminUpdateOrganization above is workable but slow at
// that volume. This applies one target parent to every checked row from the
// current filtered page in a single submit; each move still goes through
// moveOrganization so a cycle attempt on any row is rejected individually
// rather than aborting the whole batch.
const adminBulkReassignOrganizations = asyncHandler(async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const parentId = Number(req.body.bulkParentId);
  const clearReview = req.body.clearReview === 'on';

  if (ids.length && parentId) {
    for (const id of ids) {
      if (id === parentId) continue; // a stray click landing an org on itself — skip, don't abort the batch
      // eslint-disable-next-line no-await-in-loop
      await organizationService.moveOrganization(id, parentId);
      if (clearReview) {
        // eslint-disable-next-line no-await-in-loop
        await organizationService.updateOrganization(id, { needsReview: false });
      }
    }
  }

  const qs = new URLSearchParams();
  if (req.body.q) qs.set('q', req.body.q);
  if (req.body.type) qs.set('type', req.body.type);
  if (req.body.needsReview) qs.set('needsReview', '1');
  if (req.body.page) qs.set('page', req.body.page);
  const query = qs.toString();
  res.redirect(`/admin/organizations${query ? `?${query}` : ''}`);
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
// The module's landing page: which doors this person can run, and how each is
// doing. A chapter admin sees only the events granted to them, so this is never
// a list of doors they cannot open.
const adminCheckInHubPage = asyncHandler(async (req, res) => {
  const scope = ['current', 'past', 'all'].includes(req.query.scope) ? req.query.scope : 'current';
  const rows = await checkinService.listCheckInEvents(req.session.user, { scope });
  renderAdmin(req, res, 'admin/checkin-hub', { title: 'Event Check-in', rows, scope });
});

// Who may run which door. Main admin only — being trusted to scan at an event
// is not the same as being able to hand that trust to someone else.
const adminCheckInStaffPage = asyncHandler(async (req, res) => {
  const events = await eventService.getAdminEventsListing({ tablePage: 1, pageSize: 100 });
  const eventId = req.query.eventId ? Number(req.query.eventId) : null;

  let event = null;
  let staff = [];
  let grantable = [];
  if (eventId) {
    event = await eventService.getEventById(eventId);
    [staff, grantable] = await Promise.all([
      checkinService.listCheckInStaff(eventId),
      checkinService.listGrantableUsers(),
    ]);
  }

  renderAdmin(req, res, 'admin/checkin-staff', {
    title: 'Check-in Staff',
    events: events.tableEvents,
    event,
    staff,
    grantable,
  });
});

// The door screen. Reachable by any admin-role session (ensureAdmin), then
// narrowed here to the people actually allowed to run THIS door — a chapter
// admin without a grant gets 403 rather than a working scanner that fails on
// every scan, which would be a far more confusing thing to hand someone at an
// entrance.
const adminEventCheckInPage = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id);
  if (!(await checkinService.canCheckIn(req.session.user, event.id))) {
    throw new AppError('You do not have check-in access for this event', 403);
  }

  // Rendered server-side so the screen is useful the instant it loads, before
  // any polling — someone opening this at the start of a shift should see the
  // real numbers, not zeros that fill in a moment later.
  const [stats, recent] = await Promise.all([
    checkinService.getEventCheckInStats(event.id),
    checkinService.getRecentCheckIns(event.id, 8),
  ]);

  renderAdmin(req, res, 'admin/event-checkin', {
    title: `Check-in — ${event.title}`,
    event,
    stats,
    recent,
  });
});

// The report on a door after the fact. Gated the same way the door itself is:
// a chapter admin who was trusted to run this entrance can read what happened
// at it, and nobody else can.
const adminEventCheckInReportPage = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id);
  if (!(await checkinService.canCheckIn(req.session.user, event.id))) {
    throw new AppError('You do not have check-in access for this event', 403);
  }

  const result = (req.query.result || '').toString();
  const station = (req.query.station || '').toString();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [summary, log, notCheckedIn] = await Promise.all([
    checkinReportService.getReportSummary(event.id),
    checkinReportService.listScans(event.id, { result, station, page }),
    checkinReportService.getNotCheckedIn(event.id),
  ]);

  renderAdmin(req, res, 'admin/event-checkin-report', {
    title: `Check-in report — ${event.title}`,
    event,
    summary,
    scans: log.scans,
    total: log.total,
    page: log.page,
    totalPages: log.totalPages,
    notCheckedIn,
    result,
    station,
    resultOptions: checkinReportService.RESULTS,
  });
});

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
  eventTicketPage,
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
  adminCheckInHubPage,
  adminCheckInStaffPage,
  adminEventCheckInPage,
  adminEventCheckInReportPage,
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
  organizationsPage,
  organizationDetailPage,
  adminOrganizationsPage,
  adminOrganizationTreePage,
  adminOrganizationMembersPage,
  adminOrganizationAdminsPage,
  adminEditUserPage,
  adminDeleteOrganizationMember,
  adminCreateOrganization,
  adminEditOrganizationPage,
  adminUpdateOrganization,
  adminDeleteOrganization,
  adminBulkReassignOrganizations,
};
