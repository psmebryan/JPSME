const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Member types: the Master List's options, and the fees that hang off them.
//
//   A main admin keeps the list. Each type is a NEW rate (first membership)
//   or a RENEWAL rate (renewing a lapsed one), with a membership amount, a
//   validity (years, or lifetime) and an on/off switch. The amount is the
//   membership fee; there is no site-wide fee any more. The channel fee is not
//   set per type: it is PayMongo's own rate (Site Settings -> PayMongo channel
//   fee), added on top at checkout, and shown here worked out for each amount.
//
//   A member picks their type when they avail membership (from the NEW rates)
//   or renew it (from the RENEWAL rates); it decides what they pay and how
//   long it lasts. An admin can change it any time.
//
//   Event fees are separate: see eventFee.service (Master List -> Event Fee).
//
//   Switching a type off hides it from new choices only: members who have it
//   keep it, and past registrations and payments keep what they recorded.

const MAX_TOTAL = 50;
const MAX_VALIDITY_YEARS = 99; // validity is 1 to 99 whole years; null = lifetime
const MAX_NAME = 60;
const MAX_CENTAVOS = 100000000; // PHP 1,000,000, the same cap as the event fee

// PayMongo's channel fee on an amount, from the rate in Site Settings. The
// same calculation checkout charges with. Required lazily: payment.service
// itself uses this service, and a top-level require would be circular.
function channelFeeFor(amountCentavos) {
  if (amountCentavos === null || amountCentavos === undefined) return Promise.resolve(null);
  // eslint-disable-next-line global-require
  return require('./payment.service').calculateGatewaySurcharge(amountCentavos);
}

function cleanName(name) {
  const value = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!value) throw new AppError('Enter a name for the member type', 422);
  if (value.length > MAX_NAME) throw new AppError(`Keep the name under ${MAX_NAME} characters`, 422);
  return value;
}

// The membership amount from a form box, in centavos. Required.
function parseAmount(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') throw new AppError('Enter the membership amount', 422);
  return parsePesos(text, 'The amount');
}

function parsePesos(text, label) {
  const pesos = Number(text);
  if (!Number.isFinite(pesos) || pesos < 0 || pesos > MAX_CENTAVOS / 100) {
    throw new AppError(`${label} must be between 0 and 1,000,000`, 422);
  }
  return Math.round(pesos * 100);
}

// 'lifetime' -> null (lifetime); otherwise a whole number of years, 1 to 99.
function parseValidity(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim().toLowerCase() === 'lifetime') return null;
  const text = String(raw).trim();
  const years = Number(text);
  if (!/^\d+$/.test(text) || years < 1 || years > MAX_VALIDITY_YEARS) {
    throw new AppError(`Enter the validity as whole years from 1 to ${MAX_VALIDITY_YEARS}, or choose lifetime`, 422);
  }
  return years;
}

function asBool(value) {
  return value === true || value === 'true' || value === 'on' || value === '1' || value === 1;
}

function duplicateName(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function present(t) {
  return {
    id: t.id,
    name: t.name,
    sortOrder: t.sortOrder,
    isActive: t.isActive,
    renewable: t.renewable,
    validityYears: t.validityYears,
    membershipFeeCentavos: t.membershipFeeCentavos,
    // Worked out from PayMongo's rate, never stored: it follows the setting.
    channelFeeCentavos: await channelFeeFor(t.membershipFeeCentavos),
    memberCount: t._count ? t._count.users : undefined,
  };
}

async function listMemberTypes({ activeOnly = false } = {}) {
  const types = await prisma.memberType.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { users: true } } },
  });
  return Promise.all(types.map(present));
}

async function createMemberType({ name, membershipFee, isActive = true, renewable = false, validityYears = 1 }) {
  const data = {
    name: cleanName(name),
    membershipFeeCentavos: parseAmount(membershipFee),
    isActive: isActive === undefined ? true : asBool(isActive),
    renewable: asBool(renewable),
    validityYears: validityYears === undefined ? 1 : parseValidity(validityYears),
  };
  // The name first, so a duplicate is reported as one.
  if (await prisma.memberType.findUnique({ where: { name: data.name } })) {
    throw new AppError('A member type with that name already exists', 409);
  }
  const total = await prisma.memberType.count();
  if (total >= MAX_TOTAL) throw new AppError(`You can keep up to ${MAX_TOTAL} member types. Remove one you no longer need.`, 400);
  try {
    return present(await prisma.memberType.create({ data: { ...data, sortOrder: total } }));
  } catch (err) {
    if (duplicateName(err)) throw new AppError('A member type with that name already exists', 409);
    throw err;
  }
}

// Only the fields sent are changed.
async function updateMemberType(id, { name, membershipFee, isActive, sortOrder, renewable, validityYears }) {
  const existing = await prisma.memberType.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new AppError('Member type not found', 404);
  const data = {};
  if (name !== undefined) data.name = cleanName(name);
  if (membershipFee !== undefined) data.membershipFeeCentavos = parseAmount(membershipFee);
  if (sortOrder !== undefined && Number.isInteger(Number(sortOrder))) data.sortOrder = Number(sortOrder);
  if (isActive !== undefined) data.isActive = asBool(isActive);
  if (renewable !== undefined) data.renewable = asBool(renewable);
  if (validityYears !== undefined) data.validityYears = parseValidity(validityYears);
  try {
    return present(await prisma.memberType.update({ where: { id: existing.id }, data }));
  } catch (err) {
    if (duplicateName(err)) throw new AppError('A member type with that name already exists', 409);
    throw err;
  }
}

// Members of this type become "no type" and choose again when they next
// avail membership. Past payments keep what they recorded.
async function deleteMemberType(id) {
  const existing = await prisma.memberType.findUnique({
    where: { id: Number(id) },
    include: { _count: { select: { users: true } } },
  });
  if (!existing) throw new AppError('Member type not found', 404);
  await prisma.memberType.delete({ where: { id: existing.id } });
  return { id: existing.id, membersCleared: existing._count.users };
}

// An admin may set any type, on or off; null clears it.
async function assertMemberTypeExists(id) {
  if (id === null) return null;
  const type = await prisma.memberType.findUnique({ where: { id: Number(id) } });
  if (!type) throw new AppError('That member type no longer exists', 422);
  return type;
}

// What a member may pick from: the switched-on NEW rates when they have never
// been a member, the switched-on RENEWAL rates when their membership has
// lapsed. If none of the right kind exist, every switched-on type, so nobody
// is left with nothing to choose. A type with no amount set is never offered.
// membershipState is membership.service's state: NONE, EXPIRED or ACTIVE.
async function choicesFor(membershipState) {
  const active = (await listMemberTypes({ activeOnly: true })).filter((t) => t.membershipFeeCentavos !== null);
  const wanted = membershipState === 'EXPIRED';
  const ofKind = active.filter((t) => t.renewable === wanted);
  return ofKind.length ? ofKind : active;
}

// A member choosing for themselves: only one of the choices offered to them.
async function assertChoosable(id, membershipState) {
  const choices = await choicesFor(membershipState);
  const type = choices.find((t) => t.id === Number(id));
  if (!type) throw new AppError('Choose one of the member types offered', 422);
  return type;
}

// --- membership -----------------------------------------------------------------

// What membership costs this member: their type's amount. Null when they have
// no type (or it has no amount): they must choose one before paying. The
// channel fee is PayMongo's, added on top at checkout.
async function membershipQuote(userId) {
  const user = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { memberType: true },
  });
  const type = user && user.memberType;
  const amountCentavos = type && type.membershipFeeCentavos !== null ? type.membershipFeeCentavos : null;
  return {
    amountCentavos,
    channelFeeCentavos: await channelFeeFor(amountCentavos),
    memberTypeId: type ? type.id : null,
    memberTypeName: type ? type.name : null,
    validityYears: type ? type.validityYears : null,
  };
}

module.exports = {
  MAX_TOTAL,
  MAX_VALIDITY_YEARS,
  listMemberTypes,
  createMemberType,
  updateMemberType,
  deleteMemberType,
  assertMemberTypeExists,
  choicesFor,
  assertChoosable,
  membershipQuote,
};
