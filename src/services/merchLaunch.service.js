const prisma = require('../config/prisma');
const config = require('../config');
const AppError = require('../utils/AppError');
const settingsService = require('./settings.service');
const merch = require('./merch.service');

// Phase 5, the soft launch (plan: "Physical stock count, Board orders first,
// fix what they find").
//
//   Store mode     CLOSED      nobody but the store's own staff sees it
//                  SOFT        also the testers listed here (the National
//                              Board), who place real orders with live keys
//                  OPEN        every member
//                  Kept in two settings, merchStoreOpen (as before) and
//                  merchSoftLaunch, so the earlier open/closed switch still works.
//   Testers        accounts allowed in during the soft launch (merch_testers)
//   Feedback       "Report a problem" from the Store while it is not open to
//                  everyone, for staff to fix and mark done (merch_feedback)
//   Stock count    the whole inventory counted at once; the first one is the
//                  opening stock. Paid items still on the shelf (not yet
//                  shipped or handed over) are counted by staff and taken out
//                  here, since the ledger already took them off on payment.
//   Checklist      what should be true before the Store opens to everyone

const SETTING_OPEN = 'merchStoreOpen';
const SETTING_SOFT = 'merchSoftLaunch';
const MODES = {
  CLOSED: 'Closed',
  SOFT: 'Soft launch',
  OPEN: 'Open to members',
};

// Paid orders whose items are still physically here.
const STILL_HERE = ['PAID', 'PACKED', 'ADDRESS_HOLD', 'READY_FOR_PICKUP', 'UNCLAIMED'];

// --- the mode ----------------------------------------------------------------------------

async function getMode() {
  const [open, soft] = await Promise.all([settingsService.getSetting(SETTING_OPEN, 'false'), settingsService.getSetting(SETTING_SOFT, 'false')]);
  if (open === 'true') return 'OPEN';
  return soft === 'true' ? 'SOFT' : 'CLOSED';
}

async function setMode(mode) {
  const m = String(mode || '').toUpperCase();
  if (!MODES[m]) throw new AppError('Choose Closed, Soft launch or Open', 422);
  await settingsService.setSetting(SETTING_OPEN, m === 'OPEN' ? 'true' : 'false');
  await settingsService.setSetting(SETTING_SOFT, m === 'SOFT' ? 'true' : 'false');
  return m;
}

// --- testers ---------------------------------------------------------------------------

async function isTester(userId) {
  if (!userId) return false;
  return Boolean(await prisma.merchTester.findUnique({ where: { userId: Number(userId) }, select: { userId: true } }));
}

async function listTesters() {
  const rows = await prisma.merchTester.findMany({
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } } },
  });
  const ids = rows.map((r) => r.userId);
  const paid = ids.length ? await prisma.merchOrder.groupBy({ by: ['userId'], where: { userId: { in: ids }, paidAt: { not: null } }, _count: { _all: true } }) : [];
  const orders = new Map(paid.map((p) => [p.userId, p._count._all]));
  return rows.map((r) => ({
    userId: r.userId, name: `${r.user.firstName} ${r.user.lastName}`, email: r.user.email, role: r.user.role,
    addedAt: r.createdAt, paidOrders: orders.get(r.userId) || 0,
  }));
}

async function addTester(email, actorId) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new AppError('Enter the email of their account', 422);
  const user = await prisma.user.findFirst({ where: { email: e }, select: { id: true, status: true, role: true, firstName: true, lastName: true } });
  if (!user) throw new AppError('No account has that email', 404);
  if (user.role === 'ADMIN') throw new AppError('A main admin account cannot buy. Add their member account instead.', 422);
  if (user.status !== 'APPROVED') throw new AppError('That account is not approved yet', 422);
  await prisma.merchTester.upsert({ where: { userId: user.id }, create: { userId: user.id, addedById: actorId || null }, update: {} });
  return { userId: user.id, name: `${user.firstName} ${user.lastName}` };
}

async function removeTester(userId) {
  const r = await prisma.merchTester.deleteMany({ where: { userId: Number(userId) || 0 } });
  if (!r.count) throw new AppError('Not on the list', 404);
}

// --- feedback ----------------------------------------------------------------------------

const clean = (v, max) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

async function createFeedback(user, { message, page, orderNumber } = {}) {
  const text = clean(message, 1000);
  if (!text || text.length < 5) throw new AppError('Tell us what went wrong (a few words at least)', 422);
  // One open report a minute per person is plenty; stops a stuck button
  // filling the list.
  const recent = await prisma.merchFeedback.findFirst({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 60e3) } }, select: { id: true } });
  if (recent) throw new AppError('Thanks, we got your last report. Wait a minute before sending another.', 429);
  const order = /^ORD-\d{4}-\d{6,}$/.test(String(orderNumber || '')) ? String(orderNumber) : null;
  const where = clean(page, 200);
  return prisma.merchFeedback.create({
    data: { userId: user.id, message: text, page: where && where.startsWith('/') ? where : null, orderNumber: order },
  });
}

async function listFeedback({ status } = {}) {
  const s = ['OPEN', 'DONE'].includes(String(status || '').toUpperCase()) ? String(status).toUpperCase() : null;
  const [rows, counts] = await Promise.all([
    prisma.merchFeedback.findMany({
      where: s ? { status: s } : {},
      orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
      take: 300,
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    }),
    prisma.merchFeedback.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const resolverIds = [...new Set(rows.map((r) => r.resolvedById).filter(Boolean))];
  const resolvers = resolverIds.length ? await prisma.user.findMany({ where: { id: { in: resolverIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const who = new Map(resolvers.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  return {
    status: s,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    items: rows.map((r) => ({
      id: r.id, message: r.message, page: r.page, orderNumber: r.orderNumber, status: r.status, note: r.note,
      from: r.user ? `${r.user.firstName} ${r.user.lastName}` : 'Deleted account', email: r.user ? r.user.email : null,
      createdAt: r.createdAt, resolvedAt: r.resolvedAt, resolvedBy: r.resolvedById ? who.get(r.resolvedById) || null : null,
    })),
  };
}

async function setFeedbackStatus(id, { done, note }, actorId) {
  const row = await prisma.merchFeedback.findUnique({ where: { id: Number(id) || 0 } });
  if (!row) throw new AppError('Report not found', 404);
  const isDone = done === true || done === 'true';
  return prisma.merchFeedback.update({
    where: { id: row.id },
    data: isDone
      ? { status: 'DONE', note: clean(note, 300), resolvedById: actorId || null, resolvedAt: new Date() }
      : { status: 'OPEN', resolvedById: null, resolvedAt: null },
  });
}

// --- the stock count ---------------------------------------------------------------------

// Per variant: paid items not yet shipped or handed over (still on the shelf).
async function stillHere(variantIds) {
  if (!variantIds.length) return new Map();
  const rows = await prisma.merchOrderItem.groupBy({
    by: ['variantId'],
    where: { variantId: { in: variantIds }, order: { status: { in: STILL_HERE } } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.variantId, r._sum.quantity || 0]));
}

async function countSheet() {
  const variants = await prisma.merchVariant.findMany({
    include: { product: { select: { id: true, name: true, isActive: true, sortOrder: true } } },
    orderBy: [{ product: { sortOrder: 'asc' } }, { productId: 'asc' }, { id: 'asc' }],
  });
  const ids = variants.map((v) => v.id);
  const [onHand, here, lastCounts] = await Promise.all([
    merch.onHandFor(ids),
    stillHere(ids),
    ids.length ? prisma.merchStockMovement.groupBy({ by: ['variantId'], where: { variantId: { in: ids }, type: 'COUNT_CORRECTION' }, _max: { createdAt: true } }) : [],
  ]);
  const counted = new Map(lastCounts.map((c) => [c.variantId, c._max.createdAt]));
  const rows = variants.map((v) => {
    const oh = onHand.get(v.id) || 0;
    const h = here.get(v.id) || 0;
    return {
      id: v.id, productId: v.productId, productName: v.product.name, label: v.label, sku: v.sku,
      active: v.isActive && v.product.isActive,
      onHand: oh, stillHere: h, expectedOnShelf: oh + h, lastCountAt: counted.get(v.id) || null,
    };
  });
  return { rows, neverCounted: rows.filter((r) => r.active && !r.lastCountAt).length };
}

// counts: [{ variantId, counted }] where counted is everything on the shelf,
// paid-but-not-yet-gone items included. Each variant is recorded on its own
// (merch.recordStock, action count), so one bad row does not undo the rest.
async function saveCount(counts, reason, actorId) {
  const list = (Array.isArray(counts) ? counts : [])
    .filter((c) => c && String(c.counted ?? '').trim() !== '')
    .slice(0, 2000);
  if (!list.length) throw new AppError('Enter at least one count', 422);
  const why = clean(reason, 300) || 'Stock count';
  const ids = list.map((c) => Number(c.variantId)).filter((n) => Number.isInteger(n) && n > 0);
  const here = await stillHere(ids);
  const done = [];
  const failed = [];
  for (const c of list) {
    const variantId = Number(c.variantId);
    const shelf = Number(c.counted);
    try {
      if (!Number.isInteger(shelf) || shelf < 0) throw new AppError('Enter a whole number, 0 or more', 422);
      const h = here.get(variantId) || 0;
      if (shelf < h) throw new AppError(`At least ${h} should be on the shelf for paid orders not yet sent; count again`, 422);
      const r = await merch.recordStock(variantId, { action: 'count', counted: String(shelf - h), reason: why }, actorId); // eslint-disable-line no-await-in-loop
      done.push({ variantId, change: r.movement.quantity, onHand: r.onHand });
    } catch (err) {
      failed.push({ variantId, message: err.message });
    }
  }
  return {
    done: done.length,
    matched: done.filter((d) => d.change === 0).length,
    corrected: done.filter((d) => d.change !== 0).length,
    failed,
  };
}

// --- the go-live checklist -----------------------------------------------------------------

function paymongoMode() {
  const key = String((config.payment && config.payment.paymongoSecretKey) || '');
  if (!key) return 'missing';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

// Each item: ok (true / false), level ('must' blocks nothing but is shown in
// red; 'should' in amber), and a link to where it is fixed.
async function readiness() {
  const [products, zones, points, psgc, grants, paymentsOn, limit, sheet, feedbackOpen, softOrders, mode] = await Promise.all([
    prisma.merchProduct.findMany({ where: { isActive: true }, include: { images: { select: { id: true } }, variants: { where: { isActive: true } } } }),
    prisma.merchDeliveryZone.findMany({ where: { isActive: true, feeCentavos: { not: null } }, select: { id: true } }),
    prisma.merchPickupPoint.count({ where: { isActive: true, OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] } }),
    prisma.psgcArea.count({ where: { level: 'Reg' } }),
    prisma.adminGrant.findMany({ where: { user: { role: 'FINANCE_LOGISTICS' } }, select: { modules: true } }),
    settingsService.getPaymentsEnabled(),
    settingsService.getSetting('merchRefundApprovalLimit', ''),
    countSheet(),
    prisma.merchFeedback.count({ where: { status: 'OPEN' } }),
    prisma.merchOrder.count({ where: { paidAt: { not: null }, user: { merchTester: { isNot: null } } } }),
    getMode(),
  ]);
  const variants = products.flatMap((p) => p.variants);
  const noPrice = variants.filter((v) => v.memberPriceCentavos === null || v.priceCentavos === null).length;
  const noCost = variants.filter((v) => v.costCentavos === null).length;
  const noPhoto = products.filter((p) => !p.images.length).length;
  const ticks = grants.flatMap((g) => { try { return JSON.parse(g.modules); } catch (e) { return []; } });
  const pm = paymongoMode();
  const items = [
    { key: 'products', level: 'must', ok: variants.length > 0, text: 'At least one product on sale with a variant', detail: `${products.length} product(s), ${variants.length} variant(s) on sale`, href: '/admin/merch/products' },
    { key: 'prices', level: 'must', ok: variants.length > 0 && noPrice === 0, text: 'Every variant on sale has both prices', detail: noPrice ? `${noPrice} variant(s) still TBD` : 'All set', href: '/admin/merch/products' },
    { key: 'photos', level: 'should', ok: products.length > 0 && noPhoto === 0, text: 'Every product on sale has a photo', detail: noPhoto ? `${noPhoto} product(s) without a photo` : 'All set', href: '/admin/merch/products' },
    { key: 'costs', level: 'should', ok: variants.length > 0 && noCost === 0, text: 'Unit cost set for every variant (for profit)', detail: noCost ? `${noCost} variant(s) without a cost` : 'All set', href: '/admin/merch/products' },
    { key: 'count', level: 'must', ok: sheet.rows.some((r) => r.active) && sheet.neverCounted === 0, text: 'Physical stock count done (the opening stock)', detail: sheet.neverCounted ? `${sheet.neverCounted} variant(s) never counted` : 'Every variant counted', href: '/admin/merch/count' },
    { key: 'delivery', level: 'must', ok: zones.length > 0 || points > 0, text: 'A way to get orders to buyers', detail: `${zones.length} delivery zone(s) with a fee, ${points} pickup point(s)`, href: '/admin/merch/fulfilment' },
    { key: 'psgc', level: zones.length ? 'must' : 'should', ok: psgc > 0, text: 'Address list (PSA PSGC) imported', detail: psgc ? `${psgc} regions` : 'Not imported', href: '/admin/merch/fulfilment' },
    { key: 'payments', level: 'must', ok: paymentsOn, text: 'Online payments switched on', detail: paymentsOn ? 'On' : 'Off in Site Settings', href: '/admin/settings' },
    { key: 'paymongo', level: 'must', ok: pm === 'live', text: 'PayMongo live keys on this server', detail: { live: 'Live keys', test: 'Test keys: no real money moves', missing: 'No key set', unknown: 'Key not recognised' }[pm], href: null },
    { key: 'finance', level: 'should', ok: ticks.includes('merchFinance'), text: 'Someone has Finance tasks', detail: ticks.includes('merchFinance') ? 'Yes' : 'Only the main admin for now', href: '/admin/settings' },
    { key: 'logistics', level: 'should', ok: ticks.includes('merchLogistics'), text: 'Someone has Logistics tasks', detail: ticks.includes('merchLogistics') ? 'Yes' : 'Only the main admin for now', href: '/admin/settings' },
    { key: 'limit', level: 'should', ok: limit !== '' && limit !== null, text: 'Refund approval limit set', detail: limit ? `₱${(Number(limit) / 100).toLocaleString('en-PH')}` : 'Every refund needs one approval only', href: '/admin/merch/fulfilment' },
    { key: 'board', level: 'must', ok: softOrders > 0, text: 'The Board has placed real orders in the soft launch', detail: `${softOrders} paid order(s) by testers`, href: null },
    { key: 'feedback', level: 'must', ok: feedbackOpen === 0, text: 'Every reported problem fixed', detail: feedbackOpen ? `${feedbackOpen} still open` : 'None open', href: '/admin/merch/feedback' },
  ];
  return {
    mode,
    modeLabel: MODES[mode],
    items,
    mustLeft: items.filter((i) => i.level === 'must' && !i.ok).length,
    shouldLeft: items.filter((i) => i.level === 'should' && !i.ok).length,
    feedbackOpen,
  };
}

module.exports = {
  MODES,
  STILL_HERE,
  getMode,
  setMode,
  isTester,
  listTesters,
  addTester,
  removeTester,
  createFeedback,
  listFeedback,
  setFeedbackStatus,
  countSheet,
  saveCount,
  paymongoMode,
  readiness,
};
