const prisma = require('../config/prisma');
const settingsService = require('./settings.service');
const {
  MODULES, KEYS, DEFAULT_PRESIDENT_MODULES, FINANCE_LOGISTICS_GRANTS, modulesForPath,
} = require('../config/adminModules');

// What each kind of admin may open, and inside the merchandise store, what
// each may do. See config/adminModules for the modules and their paths.
//
//   ADMIN              everything
//   PRESIDENT          the modules ticked in Site Settings -> National
//                      President access (one list for the role)
//   FINANCE_LOGISTICS  the ticks saved on that account (Site Settings ->
//                      Finance & Logistics): Finance tasks, Logistics tasks,
//                      Payments (view only), Reports
//   others             the existing chapter-admin and member rules
//
// Both limited roles pass an admin guard only for a path in a module they
// have (default deny). Inside the store, merchCapsFor decides each action and
// each field, following the plan's table: the server enforces it, the pages
// only hide what would be refused.

const SETTING_KEY = 'presidentModules';
const LIMITED_ROLES = ['PRESIDENT', 'FINANCE_LOGISTICS'];
const GRANT_KEYS = FINANCE_LOGISTICS_GRANTS.map((g) => g.key);

async function getPresidentModules() {
  const raw = await settingsService.getSetting(SETTING_KEY, null);
  if (raw === null || raw === undefined) return [...DEFAULT_PRESIDENT_MODULES];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((k) => KEYS.includes(k)) : [...DEFAULT_PRESIDENT_MODULES];
  } catch (err) {
    return [...DEFAULT_PRESIDENT_MODULES];
  }
}

// Unknown keys are dropped, so only real modules can ever be granted.
async function setPresidentModules(keys) {
  const list = Array.from(new Set((Array.isArray(keys) ? keys : []).map(String))).filter((k) => KEYS.includes(k));
  await settingsService.setSetting(SETTING_KEY, JSON.stringify(list));
  return list;
}

// --- Finance & Logistics: ticks per account ------------------------------------------

async function getGrant(userId) {
  const g = await prisma.adminGrant.findUnique({ where: { userId: Number(userId) || 0 } });
  if (!g) return [];
  try { return JSON.parse(g.modules).filter((k) => GRANT_KEYS.includes(k)); } catch (e) { return []; }
}

async function setGrant(userId, keys, actorId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) || 0 }, select: { id: true, role: true } });
  if (!user || user.role !== 'FINANCE_LOGISTICS') {
    const AppError = require('../utils/AppError'); // eslint-disable-line global-require
    throw new AppError('That account is not a Finance & Logistics account', 404);
  }
  const list = Array.from(new Set((Array.isArray(keys) ? keys : []).map(String))).filter((k) => GRANT_KEYS.includes(k));
  await prisma.adminGrant.upsert({
    where: { userId: user.id },
    create: { userId: user.id, modules: JSON.stringify(list), updatedById: actorId || null },
    update: { modules: JSON.stringify(list), updatedById: actorId || null },
  });
  return list;
}

// Every Finance & Logistics account with its ticks, for Site Settings.
async function listFinanceLogistics() {
  const users = await prisma.user.findMany({
    where: { role: 'FINANCE_LOGISTICS' }, orderBy: { lastName: 'asc' },
    select: { id: true, firstName: true, lastName: true, email: true, adminGrant: true, lastLoginAt: true },
  });
  return users.map((u) => {
    let grants = [];
    try { grants = u.adminGrant ? JSON.parse(u.adminGrant.modules) : []; } catch (e) { grants = []; }
    return { id: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email, grants, lastLoginAt: u.lastLoginAt };
  });
}

// The module keys a Finance & Logistics account's ticks open.
function modulesFromGrant(grant) {
  return [...new Set(FINANCE_LOGISTICS_GRANTS.filter((g) => grant.includes(g.key)).map((g) => g.opens))];
}

// --- what a person may open -------------------------------------------------------------

async function modulesFor(user) {
  if (!user) return [];
  if (user.role === 'ADMIN') return [...KEYS];
  if (user.role === 'PRESIDENT') return getPresidentModules();
  if (user.role === 'FINANCE_LOGISTICS') return modulesFromGrant(await getGrant(user.id));
  return [];
}

// Whether a President or a Finance & Logistics account may open this path.
// A path in no module is refused. Payments is view only for Finance &
// Logistics: anything but reading it is refused.
async function limitedCanOpen(user, path, method = 'GET') {
  if (!user || !LIMITED_ROLES.includes(user.role)) return false;
  const needs = modulesForPath(path);
  if (!needs) return false;
  const granted = await modulesFor(user);
  if (!needs.some((k) => granted.includes(k))) return false;
  if (user.role === 'FINANCE_LOGISTICS' && needs.includes('payments') && !['GET', 'HEAD'].includes(String(method).toUpperCase())) return false;
  return true;
}

// Kept for the President-only callers.
async function presidentCanOpen(path) {
  return limitedCanOpen({ role: 'PRESIDENT' }, path, 'GET');
}

// Where a limited admin lands when a page is not theirs.
async function homeFor(user) {
  const mods = await modulesFor(user);
  if (user && user.role === 'FINANCE_LOGISTICS' && mods.includes('merchandise')) return '/admin/merch/dashboard';
  if (mods.includes('dashboard')) return '/admin/dashboard?denied=1';
  const first = MODULES.find((m) => mods.includes(m.key) && m.home);
  return first ? first.home : '/';
}

// ADMIN, or a PRESIDENT: national (not chapter) reach inside the modules they
// may open.
function isNationalAdmin(user) {
  return Boolean(user && (user.role === 'ADMIN' || user.role === 'PRESIDENT'));
}

// --- inside the merchandise store ---------------------------------------------------------

// Each capability is one kind of action or field. From the plan's table
// ("Who manages it"); the main admin has all of them.
const MERCH_CAPS = [
  'catalog.view', 'catalog.edit', 'cost.view', 'stock.view', 'stock.edit',
  'orders.view', 'orders.fulfil', 'addresses.view',
  'returns.view', 'returns.goods', 'refund.approve', 'refund.second',
  'settings.edit', 'reconcile.view', 'reconcile.edit', 'reports.view', 'dashboard.view',
  // The refund approval limit and the return window: only the main admin, so
  // nobody sets the limit on their own approvals.
  'policy.edit',
];
const FINANCE_CAPS = ['catalog.view', 'cost.view', 'stock.view', 'orders.view', 'returns.view', 'refund.approve', 'reconcile.view', 'reconcile.edit', 'reports.view', 'dashboard.view'];
const LOGISTICS_CAPS = ['catalog.view', 'stock.view', 'stock.edit', 'orders.view', 'orders.fulfil', 'addresses.view', 'returns.view', 'returns.goods', 'settings.edit', 'reports.view', 'dashboard.view'];
// A President given Merchandise: products and prices, settings, view orders,
// stock and reconciliation, reports, and the second refund approval; costs
// only with the extra tick. Not packing, shipping or handling returns.
const PRESIDENT_CAPS = ['catalog.view', 'catalog.edit', 'stock.view', 'orders.view', 'returns.view', 'refund.second', 'settings.edit', 'reconcile.view', 'reports.view', 'dashboard.view'];

async function merchCapsFor(user) {
  if (!user) return new Set();
  if (user.role === 'ADMIN') return new Set(MERCH_CAPS);
  if (user.role === 'PRESIDENT') {
    const mods = await getPresidentModules();
    if (!mods.includes('merchandise')) return new Set();
    return new Set([...PRESIDENT_CAPS, ...(mods.includes('merchCosts') ? ['cost.view'] : [])]);
  }
  if (user.role === 'FINANCE_LOGISTICS') {
    const grant = await getGrant(user.id);
    return new Set([...(grant.includes('merchFinance') ? FINANCE_CAPS : []), ...(grant.includes('merchLogistics') ? LOGISTICS_CAPS : [])]);
  }
  return new Set();
}

module.exports = {
  MODULES,
  LIMITED_ROLES,
  FINANCE_LOGISTICS_GRANTS,
  MERCH_CAPS,
  getPresidentModules,
  setPresidentModules,
  getGrant,
  setGrant,
  listFinanceLogistics,
  modulesFor,
  limitedCanOpen,
  presidentCanOpen,
  homeFor,
  isNationalAdmin,
  merchCapsFor,
};
