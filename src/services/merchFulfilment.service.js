const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const settingsService = require('./settings.service');

// Merchandise store, phase 3a: where an order goes (JPSME Merchandise Store
// Plan v2, "Fulfilment").
//
//   PSGC        the PSA's official list of regions, provinces, cities /
//               municipalities and barangays, imported from the PSA's
//               "Publication Datafile" workbook. Rows are read in the order
//               the PSA publishes them, each attached to the region, province
//               and city above it: that is how the PSA lays it out. It places
//               an independent city such as the City of Cebu (listed right
//               after Cebu province, though its code differs) under Cebu,
//               Metro Manila's cities directly under NCR (no province), and
//               Manila's barangays under the City of Manila with their
//               sub-municipality (Tondo I/II, ...) kept as a label.
//   Zones       the delivery fee follows the address's region; a zone with no
//               fee is not offered.
//   Pickup      points the main admin sets up (office, chapter, event).
//   Address     every rule from the plan, checked on the server for a new
//               address, a saved one, and an address being fixed.

const LEVELS = ['Reg', 'Prov', 'City', 'Mun', 'SubMun', 'Bgy'];
const ADDRESS_TYPES = { HOME: 'Home', DORM: 'Dorm', SCHOOL: 'School', OFFICE: 'Office' };
const SETTING_IMPORT = 'psgcImport';

// --- PSGC import -------------------------------------------------------------------

function cellText(cell) {
  const v = cell && cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return String(v.result ?? '');
    if (v.text) return String(v.text);
  }
  return String(v);
}

// Reads the PSA workbook (a Buffer). Finds the PSGC sheet and its columns by
// their headings, so a PSA layout change of column order still reads.
async function parsePsgcWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw new AppError('That file could not be read as an Excel workbook', 400);
  }
  const sheet = wb.worksheets.find((s) => /^psgc$/i.test(s.name.trim())) || wb.worksheets.find((s) => /psgc/i.test(s.name));
  if (!sheet) throw new AppError('No "PSGC" sheet in this workbook. Use the PSA "Publication Datafile".', 422);

  let headerRow = null;
  const col = {};
  for (let r = 1; r <= 10 && !headerRow; r += 1) {
    const row = sheet.getRow(r);
    row.eachCell((cell, c) => {
      const t = cellText(cell).replace(/\s+/g, ' ').trim().toLowerCase();
      if (/psgc/.test(t) && !col.code) col.code = c;
      else if (t === 'name' && !col.name) col.name = c;
      else if (/geographic level/.test(t)) col.level = c;
      else if (/city class/.test(t)) col.cityClass = c;
    });
    if (col.code && col.name && col.level) headerRow = r;
  }
  if (!headerRow) throw new AppError('Could not find the "10-digit PSGC", "Name" and "Geographic Level" columns', 422);

  const rows = [];
  let region = null;
  let province = null;
  let city = null;
  let subMun = null;
  sheet.eachRow((row, n) => {
    if (n <= headerRow) return;
    const code = cellText(row.getCell(col.code)).replace(/\D/g, '').padStart(10, '0');
    const level = cellText(row.getCell(col.level)).trim();
    const name = cellText(row.getCell(col.name)).replace(/\s+/g, ' ').trim();
    if (!/^\d{10}$/.test(code) || code === '0000000000' || !LEVELS.includes(level) || !name) return;
    const cityClass = col.cityClass ? cellText(row.getCell(col.cityClass)).trim() || null : null;
    if (level === 'Reg') {
      region = code; province = null; city = null; subMun = null;
      rows.push({ code, name, level, regionCode: code, provinceCode: null, cityCode: null, subMunicipality: null, cityClass: null });
    } else if (!region) {
      // A row before any region: not something an address can be in.
    } else if (level === 'Prov') {
      province = code; city = null; subMun = null;
      rows.push({ code, name, level, regionCode: region, provinceCode: code, cityCode: null, subMunicipality: null, cityClass: null });
    } else if (level === 'City' || level === 'Mun') {
      city = code; subMun = null;
      rows.push({ code, name, level, regionCode: region, provinceCode: province, cityCode: code, subMunicipality: null, cityClass });
    } else if (level === 'SubMun') {
      subMun = name;
      rows.push({ code, name, level, regionCode: region, provinceCode: province, cityCode: city, subMunicipality: name, cityClass: null });
    } else if (level === 'Bgy' && city) {
      rows.push({ code, name, level, regionCode: region, provinceCode: province, cityCode: city, subMunicipality: subMun, cityClass: null });
    }
  });
  const count = (lv) => rows.filter((r) => r.level === lv).length;
  if (count('Reg') < 10 || count('Bgy') < 1000) {
    throw new AppError(`This does not look like the full PSGC list (${count('Reg')} regions, ${count('Bgy')} barangays)`, 422);
  }
  return rows;
}

// Replaces the whole list in one transaction: the dropdowns never see half an
// import. Saved addresses keep working: they store codes, and the PSA keeps
// codes stable between releases.
async function importPsgc(buffer, { source = 'PSA Publication Datafile', actorId = null } = {}) {
  const rows = await parsePsgcWorkbook(buffer);
  await prisma.$transaction(async (tx) => {
    await tx.psgcArea.deleteMany({});
    for (let i = 0; i < rows.length; i += 2000) {
      await tx.psgcArea.createMany({ data: rows.slice(i, i + 2000) });
    }
  }, { timeout: 120000 });
  const summary = {
    at: new Date().toISOString(),
    source: String(source).slice(0, 200),
    actorId,
    regions: rows.filter((r) => r.level === 'Reg').length,
    provinces: rows.filter((r) => r.level === 'Prov').length,
    cities: rows.filter((r) => r.level === 'City' || r.level === 'Mun').length,
    barangays: rows.filter((r) => r.level === 'Bgy').length,
  };
  await settingsService.setSetting(SETTING_IMPORT, JSON.stringify(summary));
  return summary;
}

async function lastPsgcImport() {
  try { return JSON.parse(await settingsService.getSetting(SETTING_IMPORT, 'null')); } catch (e) { return null; }
}

// --- PSGC lookups (the dropdowns) ----------------------------------------------------

const asCode = (v) => (/^\d{10}$/.test(String(v || '')) ? String(v) : null);
const byName = (a, b) => a.name.localeCompare(b.name, 'en');

async function listRegions() {
  const rows = await prisma.psgcArea.findMany({ where: { level: 'Reg' }, select: { code: true, name: true }, orderBy: { code: 'asc' } });
  return rows;
}

// Provinces of a region, plus whether the region has cities with no province
// (Metro Manila), offered as one "no province" choice.
async function listProvinces(regionCode) {
  const region = asCode(regionCode);
  if (!region) return { provinces: [], directCities: false };
  const [provinces, direct] = await Promise.all([
    prisma.psgcArea.findMany({ where: { level: 'Prov', regionCode: region }, select: { code: true, name: true } }),
    prisma.psgcArea.count({ where: { level: { in: ['City', 'Mun'] }, regionCode: region, provinceCode: null } }),
  ]);
  return { provinces: provinces.sort(byName), directCities: direct > 0 };
}

// Cities and municipalities of a province, or of a region's no-province part.
async function listCities(regionCode, provinceCode) {
  const region = asCode(regionCode);
  if (!region) return [];
  const province = provinceCode ? asCode(provinceCode) : null;
  const rows = await prisma.psgcArea.findMany({
    where: { level: { in: ['City', 'Mun'] }, regionCode: region, provinceCode: province },
    select: { code: true, name: true, level: true },
  });
  return rows.sort(byName);
}

async function listBarangays(cityCode) {
  const city = asCode(cityCode);
  if (!city) return [];
  const rows = await prisma.psgcArea.findMany({ where: { level: 'Bgy', cityCode: city }, select: { code: true, name: true, subMunicipality: true } });
  return rows.map((r) => ({ code: r.code, name: r.subMunicipality ? `${r.name} (${r.subMunicipality})` : r.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

// --- zones ---------------------------------------------------------------------------

async function listZones() {
  const [zones, regions] = await Promise.all([
    prisma.merchDeliveryZone.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { regions: true } }),
    listRegions(),
  ]);
  const regionName = new Map(regions.map((r) => [r.code, r.name]));
  return zones.map((z) => ({
    id: z.id, name: z.name, feeCentavos: z.feeCentavos, isActive: z.isActive,
    regions: z.regions.map((r) => ({ code: r.regionCode, name: regionName.get(r.regionCode) || r.regionCode })),
    offered: z.isActive && z.feeCentavos !== null,
  }));
}

function money(value, label) {
  const raw = String(value == null ? '' : value).trim().replace(/^(₱|php)\s*/i, '').replace(/[,\s]/g, '');
  if (raw === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) > 100000) throw new AppError(`Enter the ${label} as a number, e.g. 150`, 422);
  return Math.round(Number(raw) * 100);
}

async function updateZone(id, { fee, isActive }) {
  const zone = await prisma.merchDeliveryZone.findUnique({ where: { id: Number(id) || 0 } });
  if (!zone) throw new AppError('Zone not found', 404);
  const data = {};
  if (fee !== undefined) data.feeCentavos = money(fee, 'delivery fee');
  if (isActive !== undefined) data.isActive = isActive === true || isActive === 'true';
  return prisma.merchDeliveryZone.update({ where: { id: zone.id }, data });
}

async function setRegionZone(regionCode, zoneId) {
  const code = asCode(regionCode);
  const zone = await prisma.merchDeliveryZone.findUnique({ where: { id: Number(zoneId) || 0 } });
  if (!code || !zone) throw new AppError('Choose a region and a zone', 422);
  return prisma.merchZoneRegion.upsert({ where: { regionCode: code }, create: { regionCode: code, zoneId: zone.id }, update: { zoneId: zone.id } });
}

// The fee for delivering to a region, or why it cannot be delivered there.
async function deliveryQuote(regionCode) {
  const code = asCode(regionCode);
  const link = code ? await prisma.merchZoneRegion.findUnique({ where: { regionCode: code }, include: { zone: true } }) : null;
  if (!link) return { available: false, reason: 'We do not deliver to this region yet.' };
  const z = link.zone;
  if (!z.isActive || z.feeCentavos === null) return { available: false, zoneName: z.name, reason: `Delivery to ${z.name} is not available yet. Choose pickup instead.` };
  return { available: true, zoneName: z.name, feeCentavos: z.feeCentavos };
}

// --- pickup points ---------------------------------------------------------------------

const text = (v, { label, max, required = false }) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) { if (required) throw new AppError(`Enter the ${label}`, 422); return null; }
  if (s.length > max) throw new AppError(`Keep the ${label} under ${max} characters`, 422);
  return s;
};

function presentPoint(p) {
  return { id: p.id, name: p.name, address: p.address, hours: p.hours, eventId: p.eventId, endsAt: p.endsAt, isActive: p.isActive };
}

async function listPickupPoints({ openOnly = false } = {}) {
  const now = new Date();
  const rows = await prisma.merchPickupPoint.findMany({
    where: openOnly ? { isActive: true, OR: [{ endsAt: null }, { endsAt: { gt: now } }] } : {},
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  return rows.map(presentPoint);
}

function pointFields(body, creating) {
  const data = {};
  if (creating || body.name !== undefined) data.name = text(body.name, { label: 'pickup point name', max: 120, required: true });
  if (creating || body.address !== undefined) data.address = text(body.address, { label: 'address', max: 300, required: true });
  if (body.hours !== undefined) data.hours = text(body.hours, { label: 'hours', max: 200 });
  if (body.endsAt !== undefined) {
    const d = String(body.endsAt || '').trim();
    if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))) throw new AppError('Enter the last day as a date', 422);
    data.endsAt = d ? new Date(`${d}T23:59:59+08:00`) : null;
  }
  if (body.eventId !== undefined) data.eventId = /^[1-9]\d*$/.test(String(body.eventId || '')) ? Number(body.eventId) : null;
  if (body.isActive !== undefined) data.isActive = body.isActive === true || body.isActive === 'true';
  return data;
}

async function addPickupPoint(body) {
  const count = await prisma.merchPickupPoint.count();
  return presentPoint(await prisma.merchPickupPoint.create({ data: { ...pointFields(body, true), sortOrder: count } }));
}

async function updatePickupPoint(id, body) {
  const p = await prisma.merchPickupPoint.findUnique({ where: { id: Number(id) || 0 } });
  if (!p) throw new AppError('Pickup point not found', 404);
  return presentPoint(await prisma.merchPickupPoint.update({ where: { id: p.id }, data: pointFields(body, false) }));
}

async function openPickupPoint(id) {
  const [p] = (await listPickupPoints({ openOnly: true })).filter((x) => x.id === Number(id));
  if (!p) throw new AppError('Choose one of the pickup points', 422);
  return p;
}

// --- addresses ---------------------------------------------------------------------------

// Philippine mobile: 09XXXXXXXXX (11 digits), +639XXXXXXXXX or 639XXXXXXXXX.
// Stored as +639XXXXXXXXX.
function mobile(value, label, required) {
  const raw = String(value == null ? '' : value).replace(/[\s-()]/g, '');
  if (!raw) { if (required) throw new AppError(`Enter the ${label}`, 422); return null; }
  const m = raw.match(/^(?:\+?63|0)(9\d{9})$/);
  if (!m) throw new AppError(`The ${label} must be a Philippine mobile number, 11 digits starting 09`, 422);
  return `+63${m[1]}`;
}

// Checks a whole address the way the plan sets out, including that region,
// province, city and barangay belong together. Returns the clean address with
// the place names, ready to save or to copy onto an order.
async function validateAddress(body) {
  const recipientName = text(body.recipientName, { label: 'recipient\'s full name', max: 150, required: true });
  if (recipientName.split(' ').length < 2) throw new AppError('Enter the recipient\'s first and last name', 422);
  const houseNo = text(body.houseNo, { label: 'house, unit or lot and block no.', max: 100, required: true });
  if (/^(n\/?a|none|-+|\.+)$/i.test(houseNo)) throw new AppError('Enter a real house, unit or lot and block no. ("N/A" is not accepted)', 422);
  const zip = String(body.zip == null ? '' : body.zip).trim();
  if (!/^\d{4}$/.test(zip)) throw new AppError('Enter the 4-digit ZIP code', 422);
  const addressType = String(body.addressType || '').toUpperCase();
  if (!ADDRESS_TYPES[addressType]) throw new AppError('Choose the address type: home, dorm, school or office', 422);

  const codes = ['regionCode', 'cityCode', 'barangayCode'].map((k) => asCode(body[k]));
  if (codes.some((c) => !c)) throw new AppError('Choose the region, city or municipality, and barangay', 422);
  const [regionCode, cityCode, barangayCode] = codes;
  const provinceCode = body.provinceCode ? asCode(body.provinceCode) : null;
  const areas = await prisma.psgcArea.findMany({ where: { code: { in: [regionCode, cityCode, barangayCode, provinceCode].filter(Boolean) } } });
  const get = (c) => areas.find((a) => a.code === c);
  const region = get(regionCode); const city = get(cityCode); const bgy = get(barangayCode);
  const province = provinceCode ? get(provinceCode) : null;
  if (!region || region.level !== 'Reg') throw new AppError('Choose the region from the list', 422);
  if (!city || !['City', 'Mun'].includes(city.level) || city.regionCode !== region.code || (city.provinceCode || null) !== (provinceCode || null)) {
    throw new AppError('The city or municipality does not belong to that region and province. Choose again from the list.', 422);
  }
  if (provinceCode && (!province || province.level !== 'Prov' || province.regionCode !== region.code)) throw new AppError('Choose the province from the list', 422);
  if (!bgy || bgy.level !== 'Bgy' || bgy.cityCode !== city.code) throw new AppError('The barangay does not belong to that city or municipality. Choose again from the list.', 422);

  return {
    recipientName,
    mobile: mobile(body.mobile, 'mobile number', true),
    altMobile: mobile(body.altMobile, 'alternate contact number', false),
    houseNo,
    building: text(body.building, { label: 'building or compound name', max: 120 }),
    street: text(body.street, { label: 'street (or purok/sitio)', max: 150, required: true }),
    subdivision: text(body.subdivision, { label: 'subdivision, village or zone', max: 120 }),
    regionCode, provinceCode, cityCode, barangayCode,
    zip,
    landmark: text(body.landmark, { label: 'landmark', max: 200, required: true }),
    notes: text(body.notes, { label: 'delivery notes', max: 300 }),
    addressType,
    names: {
      region: region.name,
      province: province ? province.name : null,
      city: city.name,
      barangay: bgy.subMunicipality ? `${bgy.name} (${bgy.subMunicipality})` : bgy.name,
    },
  };
}

// The address as a courier label reads it.
function labelLines(a) {
  const n = a.names || {};
  return [
    a.recipientName,
    [a.mobile, a.altMobile].filter(Boolean).join(' / '),
    [a.houseNo, a.building, a.street].filter(Boolean).join(', '),
    [a.subdivision, `Brgy. ${n.barangay}`].filter(Boolean).join(', '),
    [n.city, n.province, a.zip].filter(Boolean).join(', '),
    n.region,
    `Landmark: ${a.landmark}`,
    a.notes ? `Notes: ${a.notes}` : null,
  ].filter(Boolean);
}

const ADDRESS_FIELDS = ['recipientName', 'mobile', 'altMobile', 'houseNo', 'building', 'street', 'subdivision', 'regionCode', 'provinceCode', 'cityCode', 'barangayCode', 'zip', 'landmark', 'notes', 'addressType'];
const toRow = (a) => Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, a[k]]));

async function withNames(rows) {
  const codes = [...new Set(rows.flatMap((r) => [r.regionCode, r.provinceCode, r.cityCode, r.barangayCode]).filter(Boolean))];
  const areas = codes.length ? await prisma.psgcArea.findMany({ where: { code: { in: codes } } }) : [];
  const m = new Map(areas.map((a) => [a.code, a]));
  return rows.map((r) => {
    const bgy = m.get(r.barangayCode);
    const names = {
      region: (m.get(r.regionCode) || {}).name, province: r.provinceCode ? (m.get(r.provinceCode) || {}).name : null,
      city: (m.get(r.cityCode) || {}).name, barangay: bgy ? (bgy.subMunicipality ? `${bgy.name} (${bgy.subMunicipality})` : bgy.name) : null,
    };
    const a = { ...r, names, typeLabel: ADDRESS_TYPES[r.addressType] || r.addressType };
    return { ...a, lines: labelLines(a) };
  });
}

async function listAddresses(userId) {
  const rows = await prisma.merchAddress.findMany({ where: { userId: Number(userId) }, orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] });
  return withNames(rows);
}

async function ownAddress(userId, id) {
  const a = await prisma.merchAddress.findUnique({ where: { id: Number(id) || 0 } });
  if (!a || a.userId !== Number(userId)) throw new AppError('Address not found', 404);
  return a;
}

async function saveAddress(userId, body, id = null) {
  const clean = await validateAddress(body);
  const makeDefault = body.isDefault === true || body.isDefault === 'true';
  return prisma.$transaction(async (tx) => {
    const count = await tx.merchAddress.count({ where: { userId: Number(userId) } });
    if (!id && count >= 10) throw new AppError('Up to 10 saved addresses. Remove one first.', 422);
    if (makeDefault || count === 0) await tx.merchAddress.updateMany({ where: { userId: Number(userId) }, data: { isDefault: false } });
    if (id) {
      await ownAddress(userId, id);
      return tx.merchAddress.update({ where: { id: Number(id) }, data: { ...toRow(clean), ...(makeDefault ? { isDefault: true } : {}) } });
    }
    return tx.merchAddress.create({ data: { ...toRow(clean), userId: Number(userId), isDefault: makeDefault || count === 0 } });
  });
}

async function deleteAddress(userId, id) {
  const a = await ownAddress(userId, id);
  await prisma.merchAddress.delete({ where: { id: a.id } });
  if (a.isDefault) {
    const next = await prisma.merchAddress.findFirst({ where: { userId: Number(userId) }, orderBy: { id: 'asc' } });
    if (next) await prisma.merchAddress.update({ where: { id: next.id }, data: { isDefault: true } });
  }
}

// A saved address, re-checked against today's rules and PSGC list.
async function savedAddressForCheckout(userId, id) {
  const a = await ownAddress(userId, id);
  return validateAddress(a);
}

module.exports = {
  ADDRESS_TYPES,
  parsePsgcWorkbook,
  importPsgc,
  lastPsgcImport,
  listRegions,
  listProvinces,
  listCities,
  listBarangays,
  listZones,
  updateZone,
  setRegionZone,
  deliveryQuote,
  listPickupPoints,
  addPickupPoint,
  updatePickupPoint,
  openPickupPoint,
  validateAddress,
  labelLines,
  listAddresses,
  saveAddress,
  deleteAddress,
  savedAddressForCheckout,
};
