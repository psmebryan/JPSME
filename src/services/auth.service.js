const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const AppError = require("../utils/AppError");
const { issueVerificationToken } = require("./emailVerification.service");
const sheetsSyncService = require("./sheetsSync.service");

const SALT_ROUNDS = 12;
const normalizeName = (value) => String(value || '').trim().toUpperCase();

// Precomputed once at startup — compared against when the email doesn't
// exist, purely to burn roughly the same amount of time as the real
// bcrypt.compare below. Without this, a missing account returns
// immediately while a wrong password takes ~100ms, and that timing
// difference alone lets an attacker enumerate which emails have accounts
// without ever seeing a different error message.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

// Ancestors are derived from Organization.path (see organization.service.js),
// so this no longer needs the nested area→region include the fixed chapter
// hierarchy required — a single organization include is enough at any depth.
const userInclude = {
  organization: true,
};

function toPublicUser(user) {
  const { password, ...publicUser } = user;
  return publicUser;
}

// Only a same-site relative path is ever honored — same guard as the client-side
// login redirect in public/js/auth.js, applied here too since this one persists
// to the database and could otherwise be replayed as an open redirect much later.
function sanitizeRedirectPath(path) {
  if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) {
    return path.slice(0, 500);
  }
  return null;
}

async function registerUser({
  firstName,
  middleInitial,
  lastName,
  email,
  password,
  phone,
  school,
  organizationId,
  next,
}) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError("An account with this email already exists", 409);
  }

  if (!organizationId) {
    throw new AppError("Please select your organization", 400);
  }

  // Any organization type is acceptable — a member may belong directly to a
  // student unit, chapter, cluster, or region, whichever is actually correct
  // for them. The old flow could only accept a chapter.
  const organization = await prisma.organization.findUnique({ where: { id: Number(organizationId) } });
  if (!organization || organization.isActive === false) {
    throw new AppError("Please select a valid organization", 400);
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      firstName: normalizeName(firstName),
      middleInitial: middleInitial ? normalizeName(middleInitial) : null,
      lastName: normalizeName(lastName),
      email,
      password: hashedPassword,
      phone: phone || null,
      school: school || null,
      organizationId: Number(organizationId),
      status: "PENDING",
      role: "USER",
      postApprovalRedirectUrl: sanitizeRedirectPath(next),
    },
    include: userInclude,
  });

  await issueVerificationToken(user);

  // Fire-and-forget, same as the email sends elsewhere in this app — must
  // never block or fail registration if the sheet sync has trouble.
  sheetsSyncService.syncMembership();

  return toPublicUser(user);
}

// context: 'user' (default) or 'admin'.
//   'admin' — only ADMIN accounts may log in; anyone else is rejected.
//   'user'  — ADMIN accounts must use the admin login page instead, so they're
//             rejected here too. This keeps the two login forms mutually exclusive:
//             a regular account can't get in through /admin/login, and an admin
//             account can't get in through /login.
async function login(email, password, { context = "user" } = {}) {
  const user = await prisma.user.findUnique({ where: { email }, include: userInclude });
  if (!user) {
    // Still run a bcrypt compare (against a hash nobody's real password will
    // ever match) so this takes roughly the same time as the "wrong
    // password" path below — otherwise a missing account returns near-
    // instantly while a wrong password takes ~100ms, and that timing gap
    // alone lets an attacker enumerate registered emails.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    throw new AppError("Invalid email or password", 401);
  }

  const passwordMatches = await bcrypt.compare(password, user.password);
  if (!passwordMatches) {
    throw new AppError("Invalid email or password", 401);
  }

  if (!user.emailVerifiedAt) {
    throw new AppError(
      "Please verify your email address before logging in",
      403,
    );
  }

  // REJECTED applicants never get a session. PENDING (verified, awaiting admin
  // review) DOES get a session — they need one to complete their membership
  // payment, since the admin's approval decision is informed by seeing that
  // payment status. app.js's pending-user gate then confines a PENDING session
  // to the payment flow only, until an admin approves the account.
  if (user.role === "USER" && user.status === "REJECTED") {
    throw new AppError("Your account registration was rejected", 403);
  }

  if (context === "admin" && user.role !== "ADMIN" && user.role !== "CHAPTER_ADMIN") {
    throw new AppError("This account does not have admin access", 403);
  }

  if (context === "user" && user.role === "ADMIN") {
    throw new AppError("Admin accounts must log in through the admin login page", 403);
  }

  // One-time: only actually usable once the account has cleared payment +
  // admin approval (a still-PENDING user gets forced to /membership-payment
  // regardless — see app.js's pending-user gate and this same check on the
  // client side). Cleared immediately so it doesn't fire on every future login.
  let postApprovalRedirectUrl = null;
  if (user.role === "USER" && user.status === "APPROVED" && user.postApprovalRedirectUrl) {
    postApprovalRedirectUrl = user.postApprovalRedirectUrl;
    await prisma.user.update({ where: { id: user.id }, data: { postApprovalRedirectUrl: null } });
  }

  return { ...toPublicUser(user), postApprovalRedirectUrl };
}

async function getById(id) {
  const user = await prisma.user.findUnique({ where: { id: Number(id) }, include: userInclude });
  if (!user) throw new AppError("User not found", 404);
  return toPublicUser(user);
}

async function updateProfile(userId, { middleInitial, phone, school, organizationId }) {
  const value = organizationId === '' || organizationId === undefined || organizationId === null ? null : Number(organizationId);
  if (organizationId !== '' && organizationId !== undefined && organizationId !== null && organizationId !== 'null' && Number.isNaN(value)) {
    throw new AppError('Invalid organization selection', 400);
  }

  const user = await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      middleInitial: middleInitial && middleInitial.trim() ? normalizeName(middleInitial) : null,
      phone: phone && phone.trim() ? phone.trim() : null,
      school: school && school.trim() ? school.trim() : null,
      organizationId: value,
    },
    include: userInclude,
  });

  return toPublicUser(user);
}

async function updateProfileImage(userId, profileImage) {
  const user = await prisma.user.update({
    where: { id: Number(userId) },
    data: { profileImage },
    include: userInclude,
  });

  return toPublicUser(user);
}

module.exports = { registerUser, login, getById, updateProfile, updateProfileImage, toPublicUser };
