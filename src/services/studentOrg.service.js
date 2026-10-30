const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const organizationService = require('./organization.service');

// Student Organization Master: the student units (schools) in the
// organization tree, with their province and region, president, email, year
// founded and officers. The tree itself (creating, moving, deactivating) is
// organization.service's job; this only shapes the list and adds the
// leadership fields. A main admin uses it; members pick these same
// organizations at registration.

const MAX_TEXT = 150;
const MAX_POSITION = 100;
const MAX_TERM = 20;

function cleanText(value, label, max, { required = false } = {}) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new AppError(`${label} is required`, 422);
    return null;
  }
  if (text.length > max) throw new AppError(`${label} must be ${max} characters or fewer`, 422);
  return text;
}

function cleanEmail(value) {
  const text = cleanText(value, 'Email', 191);
  if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new AppError('Enter a valid email address', 422);
  return text ? text.toLowerCase() : null;
}

function cleanYear(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const year = Number(text);
  const max = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < 1900 || year > max) throw new AppError(`Year founded must be between 1900 and ${max}`, 422);
  return year;
}

// The province and region above a student unit, read from its parents. A unit
// can sit straight under a region, in which case it has no province.
function placeOf(org) {
  const parent = org.parent || null;
  if (!parent) return { province: null, region: null };
  if (parent.type === 'PROVINCE') {
    const grand = parent.parent;
    return { province: parent, region: grand && grand.type === 'REGION' ? grand : null };
  }
  if (parent.type === 'REGION') return { province: null, region: parent };
  return { province: null, region: null };
}

function present(org) {
  const { province, region } = placeOf(org);
  return {
    id: org.id,
    name: org.name,
    email: org.email,
    yearFounded: org.yearFounded,
    president: org.president,
    isActive: org.isActive,
    provinceId: province ? province.id : null,
    province: province ? province.name : null,
    region: region ? region.name : null,
    officerCount: org._count ? org._count.officers : 0,
    memberCount: org._count ? org._count.users : 0,
  };
}

const INCLUDE = {
  parent: { select: { id: true, name: true, type: true, parent: { select: { id: true, name: true, type: true } } } },
  _count: { select: { officers: true, users: true } },
};

async function listStudentOrganizations() {
  const orgs = await prisma.organization.findMany({
    where: { type: 'STUDENT_UNIT' },
    orderBy: { name: 'asc' },
    include: INCLUDE,
  });
  return orgs.map(present);
}

// The provinces a student organization can belong to, labelled with their
// region, for the Add/Edit form.
async function listProvinces() {
  const provinces = await prisma.organization.findMany({
    where: { type: 'PROVINCE' },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, isActive: true, parent: { select: { name: true, type: true } } },
  });
  return provinces.map((p) => ({
    id: p.id,
    name: p.name,
    isActive: p.isActive,
    region: p.parent && p.parent.type === 'REGION' ? p.parent.name : null,
  }));
}

async function getStudentOrganization(id) {
  const org = await prisma.organization.findUnique({ where: { id: Number(id) || 0 }, include: INCLUDE });
  if (!org || org.type !== 'STUDENT_UNIT') throw new AppError('Student organization not found', 404);
  return org;
}

async function assertProvince(provinceId) {
  const province = await prisma.organization.findUnique({ where: { id: Number(provinceId) || 0 } });
  if (!province || province.type !== 'PROVINCE') throw new AppError('Choose the province this organization belongs to', 422);
  return province;
}

async function createStudentOrganization(input) {
  const name = cleanText(input.name, 'Name', MAX_TEXT, { required: true });
  const province = await assertProvince(input.provinceId);
  const created = await organizationService.createOrganization({
    name,
    type: 'STUDENT_UNIT',
    parentId: province.id,
    email: cleanEmail(input.email),
    yearFounded: cleanYear(input.yearFounded),
    isActive: input.isActive === undefined ? true : Boolean(input.isActive === true || input.isActive === 'true' || input.isActive === 'on'),
  });
  await prisma.organization.update({
    where: { id: created.id },
    data: { president: cleanText(input.president, 'President', MAX_TEXT) },
  });
  return present(await getStudentOrganization(created.id));
}

// Only the fields sent are changed. A new province moves the organization
// (and keeps the tree's paths right) through organization.service.
async function updateStudentOrganization(id, input) {
  const org = await getStudentOrganization(id);
  const data = {};
  if (input.name !== undefined) data.name = cleanText(input.name, 'Name', MAX_TEXT, { required: true });
  if (input.email !== undefined) data.email = cleanEmail(input.email);
  if (input.yearFounded !== undefined) data.yearFounded = cleanYear(input.yearFounded);
  if (Object.keys(data).length) await organizationService.updateOrganization(org.id, data);
  if (input.president !== undefined) {
    await prisma.organization.update({ where: { id: org.id }, data: { president: cleanText(input.president, 'President', MAX_TEXT) } });
  }
  if (input.provinceId !== undefined && Number(input.provinceId) !== Number(org.parentId)) {
    const province = await assertProvince(input.provinceId);
    await organizationService.moveOrganization(org.id, province.id);
  }
  if (input.isActive !== undefined) {
    await organizationService.setOrganizationActive(org.id, input.isActive === true || input.isActive === 'true' || input.isActive === 'on');
  }
  return present(await getStudentOrganization(org.id));
}

// --- officers ---------------------------------------------------------------------

function cleanOfficer(input) {
  return {
    name: cleanText(input.name, 'Officer name', MAX_TEXT, { required: true }),
    position: cleanText(input.position, 'Position', MAX_POSITION, { required: true }),
    termYear: cleanText(input.termYear, 'Term', MAX_TERM),
  };
}

async function listOfficers(organizationId) {
  await getStudentOrganization(organizationId);
  return prisma.organizationOfficer.findMany({
    where: { organizationId: Number(organizationId) },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, position: true, termYear: true },
  });
}

async function addOfficer(organizationId, input) {
  await getStudentOrganization(organizationId);
  const data = cleanOfficer(input);
  const count = await prisma.organizationOfficer.count({ where: { organizationId: Number(organizationId) } });
  return prisma.organizationOfficer.create({
    data: { ...data, organizationId: Number(organizationId), sortOrder: count },
    select: { id: true, name: true, position: true, termYear: true },
  });
}

async function findOfficer(organizationId, officerId) {
  const officer = await prisma.organizationOfficer.findUnique({ where: { id: Number(officerId) || 0 } });
  if (!officer || officer.organizationId !== Number(organizationId)) throw new AppError('Officer not found', 404);
  return officer;
}

async function updateOfficer(organizationId, officerId, input) {
  const officer = await findOfficer(organizationId, officerId);
  return prisma.organizationOfficer.update({
    where: { id: officer.id },
    data: cleanOfficer(input),
    select: { id: true, name: true, position: true, termYear: true },
  });
}

async function removeOfficer(organizationId, officerId) {
  const officer = await findOfficer(organizationId, officerId);
  await prisma.organizationOfficer.delete({ where: { id: officer.id } });
  return { id: officer.id };
}

module.exports = {
  listStudentOrganizations,
  listProvinces,
  createStudentOrganization,
  updateStudentOrganization,
  listOfficers,
  addOfficer,
  updateOfficer,
  removeOfficer,
};
