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
//   Each event can set a fee per type. A registrant picks one of the event's
//   options (a type with a fee, or "everyone else" at the event's own fee).
//   Nobody checks that a Student really is one; the desk does.
//
//   Switching a type off hides it from new choices only: members who have it
//   keep it, and past registrations and payments keep what they recorded.

const MAX_TOTAL = 50;
const VALIDITY_CHOICES = [1, 2, 3, 5, null]; // years; null = lifetime
const MAX_NAME = 60;
const MAX_CENTAVOS = 100000000; // PHP 1,000,000, the same cap as the event fee
const STANDARD_OPTION = 'standard';

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

// '' or 'lifetime' -> null (lifetime); otherwise one of VALIDITY_CHOICES.
function parseValidity(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '' || String(raw).toLowerCase() === 'lifetime') return null;
  const years = Number(raw);
  if (!VALIDITY_CHOICES.includes(years)) throw new AppError('Choose a validity of 1, 2, 3 or 5 years, or lifetime', 422);
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

// Members of this type become "no type"; the type's event fees go with it.
// Past registrations keep the type name and fee they were recorded with.
async function deleteMemberType(id) {
  const existing = await prisma.memberType.findUnique({
    where: { id: Number(id) },
    include: { _count: { select: { users: true, eventFees: true } } },
  });
  if (!existing) throw new AppError('Member type not found', 404);
  await prisma.memberType.delete({ where: { id: existing.id } });
  return { id: existing.id, membersCleared: existing._count.users, eventFeesRemoved: existing._count.eventFees };
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

// --- event fees -------------------------------------------------------------------

// { [memberTypeId]: feeCentavos } for one event, every type on or off.
async function getEventFees(eventId) {
  const rows = await prisma.eventFee.findMany({ where: { eventId: Number(eventId) } });
  return Object.fromEntries(rows.map((r) => [r.memberTypeId, r.feeCentavos]));
}

// Reads the event form's boxes: memberTypeFee_<typeId> = pesos, blank for
// "no option for this type". Returns { [typeId]: centavos | null }.
function parseFeeFields(body) {
  const fees = {};
  Object.keys(body || {}).forEach((key) => {
    const m = /^memberTypeFee_(\d+)$/.exec(key);
    if (!m) return;
    const text = String(body[key] == null ? '' : body[key]).trim();
    fees[m[1]] = text === '' ? null : parsePesos(text, 'Each member type fee');
  });
  return fees;
}

// A number sets that type's fee, null removes it. Types not mentioned are left
// as they are, and ids that are not real member types are ignored.
async function setEventFees(eventId, fees) {
  const ids = Object.keys(fees || {}).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return getEventFees(eventId);
  const real = new Set((await prisma.memberType.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id));

  await prisma.$transaction(ids.filter((id) => real.has(id)).map((typeId) => {
    const value = fees[typeId];
    if (value === null || value === undefined) {
      return prisma.eventFee.deleteMany({ where: { eventId: Number(eventId), memberTypeId: typeId } });
    }
    return prisma.eventFee.upsert({
      where: { eventId_memberTypeId: { eventId: Number(eventId), memberTypeId: typeId } },
      create: { eventId: Number(eventId), memberTypeId: typeId, feeCentavos: value },
      update: { feeCentavos: value },
    });
  }));
  return getEventFees(eventId);
}

// What a registrant can choose from for one event: every switched-on type that
// has a fee for it, then "everyone else" at the event's own fee. An empty list
// means the event has no options and everyone pays the event's own fee.
async function listEventOptions(event) {
  const rows = await prisma.eventFee.findMany({
    where: { eventId: Number(event.id), memberType: { isActive: true } },
    include: { memberType: { select: { id: true, name: true, sortOrder: true } } },
  });
  if (!rows.length) return [];
  rows.sort((a, b) => (a.memberType.sortOrder - b.memberType.sortOrder) || (a.memberType.id - b.memberType.id));
  return [
    ...rows.map((r) => ({ value: String(r.memberType.id), label: r.memberType.name, feeCentavos: r.feeCentavos, memberTypeName: r.memberType.name })),
    { value: STANDARD_OPTION, label: 'Everyone else', feeCentavos: Number(event.feeCentavos) || 0, memberTypeName: null },
  ];
}

// The fee for the option a registrant picked, checked against the event's
// real options. Never trusts an amount from the request.
async function resolveEventChoice(event, choice) {
  const options = await listEventOptions(event);
  if (!options.length) {
    return { feeCentavos: Number(event.feeCentavos) || 0, memberTypeName: null, optionLabel: null };
  }
  const picked = options.find((o) => o.value === String(choice == null ? '' : choice));
  if (!picked) throw new AppError('Choose one of the registration options for this event', 422);
  return { feeCentavos: picked.feeCentavos, memberTypeName: picked.memberTypeName, optionLabel: picked.label };
}

module.exports = {
  MAX_TOTAL,
  VALIDITY_CHOICES,
  STANDARD_OPTION,
  listMemberTypes,
  createMemberType,
  updateMemberType,
  deleteMemberType,
  assertMemberTypeExists,
  choicesFor,
  assertChoosable,
  membershipQuote,
  getEventFees,
  parseFeeFields,
  setEventFees,
  listEventOptions,
  resolveEventChoice,
};
