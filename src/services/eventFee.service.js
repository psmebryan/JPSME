const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const membershipService = require('./membership.service');

// Event fees, per event (Master List -> Event Fee).
//
//   Each event keeps its own list of registration fee options, e.g.
//   "Student" PHP 300 and "Professional" PHP 800, each with an Active switch.
//   They belong to that event only; there is no shared list of categories.
//   Separate from member types too: what someone pays for an event is the
//   option they register under, not their membership.
//
//   A registrant must pick one of the event's active options; the option and
//   fee are recorded on the registration. An event with no active options
//   charges its single registration fee, as before. Nobody checks that a
//   "Student" really is one; the desk does.
//
//   Each option also says who may pick it (audience): everyone, members only
//   (an active membership) or non-members only, so members can pay less.
//   That one is checked here, against the registrant's membership.

const MAX_NAME = 60;
const MAX_CENTAVOS = 100000000; // PHP 1,000,000, the same cap as the event fee
const AUDIENCES = ['EVERYONE', 'MEMBERS', 'NON_MEMBERS'];
const AUDIENCE_LABELS = { EVERYONE: 'Everyone', MEMBERS: 'Members only', NON_MEMBERS: 'Non-members only' };

// PayMongo's channel fee on an amount, from the rate in Site Settings, the
// same calculation checkout charges with. Required lazily to avoid a cycle.
function channelFeeFor(amountCentavos) {
  // eslint-disable-next-line global-require
  return require('./payment.service').calculateGatewaySurcharge(amountCentavos);
}

function cleanName(name) {
  const value = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!value) throw new AppError('Enter a name for the fee option', 422);
  if (value.length > MAX_NAME) throw new AppError(`Keep the name under ${MAX_NAME} characters`, 422);
  return value;
}

function parseAmount(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') throw new AppError('Enter the amount', 422);
  const pesos = Number(text);
  if (!Number.isFinite(pesos) || pesos < 0 || pesos > MAX_CENTAVOS / 100) {
    throw new AppError('The amount must be between 0 and 1,000,000', 422);
  }
  return Math.round(pesos * 100);
}

function parseAudience(raw) {
  const value = String(raw == null || raw === '' ? 'EVERYONE' : raw).toUpperCase();
  if (!AUDIENCES.includes(value)) throw new AppError('Choose who can pick this option', 422);
  return value;
}

// Whether someone with this membership may pick an option.
function allowed(audience, isMember) {
  if (audience === 'MEMBERS') return isMember;
  if (audience === 'NON_MEMBERS') return !isMember;
  return true;
}

function asBool(value) {
  return value === true || value === 'true' || value === 'on' || value === '1' || value === 1;
}

function duplicateName(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function assertEvent(eventId) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) || 0 }, select: { id: true } });
  if (!event) throw new AppError('Event not found', 404);
  return event;
}

async function present(o) {
  return {
    id: o.id,
    name: o.name,
    feeCentavos: o.feeCentavos,
    channelFeeCentavos: await channelFeeFor(o.feeCentavos),
    isActive: o.isActive,
    audience: o.audience,
    sortOrder: o.sortOrder,
  };
}

// --- the Event Fee master: every event and how many options it has ---------------

async function listEventsWithFees() {
  const events = await prisma.event.findMany({
    // Newest created first, so an event just made is at the top whatever its
    // date. The page can still sort by the event's date.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, title: true, startDate: true, isPublished: true, feeCentavos: true,
      feeOptions: { select: { isActive: true } },
    },
  });
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    startDate: e.startDate,
    isPublished: e.isPublished,
    feeCentavos: e.feeCentavos,
    optionCount: e.feeOptions.length,
    activeOptionCount: e.feeOptions.filter((o) => o.isActive).length,
  }));
}

// --- one event's options -------------------------------------------------------------

async function listOptions(eventId) {
  await assertEvent(eventId);
  const rows = await prisma.eventFeeOption.findMany({
    where: { eventId: Number(eventId) },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  return Promise.all(rows.map(present));
}

async function addOption(eventId, { name, fee, isActive = true, audience }) {
  await assertEvent(eventId);
  const data = {
    name: cleanName(name), feeCentavos: parseAmount(fee), audience: parseAudience(audience),
    isActive: isActive === undefined ? true : asBool(isActive),
  };
  const count = await prisma.eventFeeOption.count({ where: { eventId: Number(eventId) } });
  try {
    return present(await prisma.eventFeeOption.create({ data: { ...data, eventId: Number(eventId), sortOrder: count } }));
  } catch (err) {
    if (duplicateName(err)) throw new AppError('This event already has a fee option with that name', 409);
    throw err;
  }
}

async function findOption(eventId, optionId) {
  const option = await prisma.eventFeeOption.findUnique({ where: { id: Number(optionId) || 0 } });
  if (!option || option.eventId !== Number(eventId)) throw new AppError('Fee option not found', 404);
  return option;
}

// Only the fields sent are changed. Registrations already made keep the fee
// they were recorded with.
async function updateOption(eventId, optionId, { name, fee, isActive, audience, sortOrder }) {
  const option = await findOption(eventId, optionId);
  const data = {};
  if (name !== undefined) data.name = cleanName(name);
  if (fee !== undefined) data.feeCentavos = parseAmount(fee);
  if (isActive !== undefined) data.isActive = asBool(isActive);
  if (audience !== undefined) data.audience = parseAudience(audience);
  if (sortOrder !== undefined && Number.isInteger(Number(sortOrder))) data.sortOrder = Number(sortOrder);
  try {
    return present(await prisma.eventFeeOption.update({ where: { id: option.id }, data }));
  } catch (err) {
    if (duplicateName(err)) throw new AppError('This event already has a fee option with that name', 409);
    throw err;
  }
}

async function removeOption(eventId, optionId) {
  const option = await findOption(eventId, optionId);
  await prisma.eventFeeOption.delete({ where: { id: option.id } });
  return { id: option.id };
}

// --- registering ---------------------------------------------------------------------

// The event's active options. Empty = the event charges its single fee.
// Each says who may pick it; `allowed` is true/false once the viewer's
// membership is known, and null for a restricted option shown to someone
// signed out.
async function listEventOptions(event, { userId } = {}) {
  const rows = await prisma.eventFeeOption.findMany({
    where: { eventId: Number(event.id), isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const isMember = userId && rows.some((r) => r.audience !== 'EVERYONE')
    ? await membershipService.isActiveMember(userId) : null;
  return rows.map((r) => ({
    value: String(r.id),
    label: r.name,
    feeCentavos: r.feeCentavos,
    audience: r.audience,
    audienceLabel: AUDIENCE_LABELS[r.audience] || AUDIENCE_LABELS.EVERYONE,
    allowed: r.audience === 'EVERYONE' ? true : (isMember === null ? null : allowed(r.audience, isMember)),
  }));
}

// The fee for the option a registrant picked, checked against the event's
// real options and the registrant's membership. Never trusts an amount from
// the request.
async function resolveEventChoice(event, choice, userId) {
  const options = await listEventOptions(event, { userId });
  if (!options.length) return { feeCentavos: Number(event.feeCentavos) || 0, feeOptionName: null };
  if (!options.some((o) => o.allowed)) {
    throw new AppError(options.every((o) => o.audience === 'MEMBERS')
      ? 'This event is for PSME members only. Avail a membership to register.'
      : 'None of this event\'s registration options is open to you.', 403);
  }
  const picked = options.find((o) => o.value === String(choice == null ? '' : choice));
  if (!picked) throw new AppError('Choose one of the registration options for this event', 422);
  if (!picked.allowed) {
    throw new AppError(picked.audience === 'MEMBERS'
      ? `"${picked.label}" is for PSME members only. Choose another option.`
      : `"${picked.label}" is for non-members only. Choose another option.`, 422);
  }
  return { feeCentavos: picked.feeCentavos, feeOptionName: picked.label };
}

module.exports = {
  AUDIENCES,
  listEventsWithFees,
  listOptions,
  addOption,
  updateOption,
  removeOption,
  listEventOptions,
  resolveEventChoice,
};
