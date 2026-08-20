const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const AppError = require("../utils/AppError");
const { issueVerificationToken } = require("./emailVerification.service");
const sheetsSyncService = require("./sheetsSync.service");

const SALT_ROUNDS = 12;
const normalizeName = (value) => String(value || '').trim().toUpperCase();

const userInclude = {
  chapter: {
    include: {
      area: {
        include: { region: true },
      },
    },
  },
};

function toPublicUser(user) {
  const { password, ...publicUser } = user;
  return publicUser;
}

async function registerUser({
  firstName,
  middleInitial,
  lastName,
  email,
  password,
  phone,
  school,
  chapterId,
}) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError("An account with this email already exists", 409);
  }

  if (!chapterId) {
    throw new AppError("Please select a chapter", 400);
  }

  const chapter = await prisma.chapter.findUnique({ where: { id: Number(chapterId) } });
  if (!chapter || chapter.isActive === false) {
    throw new AppError("Please select a valid chapter", 400);
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
      chapterId: Number(chapterId),
      status: "PENDING",
      role: "USER",
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

  return toPublicUser(user);
}

async function getById(id) {
  const user = await prisma.user.findUnique({ where: { id: Number(id) }, include: userInclude });
  if (!user) throw new AppError("User not found", 404);
  return toPublicUser(user);
}

async function updateProfile(userId, { middleInitial, phone, school, chapterId }) {
  const value = chapterId === '' || chapterId === undefined || chapterId === null ? null : Number(chapterId);
  if (chapterId !== '' && chapterId !== undefined && chapterId !== null && chapterId !== 'null' && Number.isNaN(value)) {
    throw new AppError('Invalid chapter selection', 400);
  }

  const user = await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      middleInitial: middleInitial && middleInitial.trim() ? normalizeName(middleInitial) : null,
      phone: phone && phone.trim() ? phone.trim() : null,
      school: school && school.trim() ? school.trim() : null,
      chapterId: value,
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
