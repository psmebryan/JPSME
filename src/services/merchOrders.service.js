const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const store = require('./merchStore.service');

// Merchandise orders for staff (admin -> Merchandise -> Orders), phase 3a.
//
// Each step is one allowed move from a set of statuses, done as a
// conditional update (only if the order is still where the step expects), so
// two people pressing buttons at once cannot both move it. Every step is
// written to the order's timeline with who did it, and the buyer is emailed
// for the steps that matter to them.
//
//   PAID ─pack─▶ PACKED ─ship─▶ SHIPPED ─deliver─▶ DELIVERED        (delivery)
//                PACKED ─ready─▶ READY_FOR_PICKUP ─pickedUp─▶ PICKED_UP (pickup)
//   READY_FOR_PICKUP ─unclaimed─▶ UNCLAIMED ─reopen─▶ READY_FOR_PICKUP
//   PAID / PACKED (delivery) ─holdAddress─▶ ADDRESS_HOLD ─(buyer fixes, or
//                staff resume)─▶ back where it was

const QR_PREFIX = 'JPSME-ORDER:';
const PAGE_SIZE = 25;
const REMIND_AFTER_DAYS = 7;

const STEPS = {
  pack: { from: ['PAID'], to: 'PACKED', label: 'Packed', stamp: 'packedAt' },
  ship: { from: ['PACKED'], to: 'SHIPPED', label: 'Shipped', stamp: 'shippedAt', only: 'DELIVERY', email: 'SHIPPED' },
  deliver: { from: ['SHIPPED'], to: 'DELIVERED', label: 'Delivered', stamp: 'deliveredAt', only: 'DELIVERY', email: 'DELIVERED' },
  ready: { from: ['PACKED'], to: 'READY_FOR_PICKUP', label: 'Ready for pickup', stamp: 'readyAt', only: 'PICKUP', email: 'READY_FOR_PICKUP' },
  pickedUp: { from: ['READY_FOR_PICKUP', 'UNCLAIMED'], to: 'PICKED_UP', label: 'Picked up', stamp: 'pickedUpAt', only: 'PICKUP' },
  unclaimed: { from: ['READY_FOR_PICKUP'], to: 'UNCLAIMED', label: 'Not collected', only: 'PICKUP', note: true },
  reopen: { from: ['UNCLAIMED'], to: 'READY_FOR_PICKUP', label: 'Ready for pickup again', only: 'PICKUP' },
  holdAddress: { from: ['PAID', 'PACKED'], to: 'ADDRESS_HOLD', label: 'Address needs fixing', only: 'DELIVERY', note: true, email: 'ADDRESS_HOLD' },
  resume: { from: ['ADDRESS_HOLD'], to: null, label: 'Address hold lifted' },
};
const BULK_STEPS = ['pack', 'ready'];

const mail = () => require('./mail.service'); // eslint-disable-line global-require

const ORDER_INCLUDE = {
  items: { orderBy: { id: 'asc' } },
  payment: { select: { status: true, gatewayPaymentId: true, gatewayFeeCentavos: true, amount: true } },
  events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { actor: { select: { firstName: true, lastName: true } } } },
};

async function findOrder(orderNumber) {
  const o = await prisma.merchOrder.findUnique({ where: { orderNumber: String(orderNumber || '') }, include: ORDER_INCLUDE });
  if (!o) throw new AppError('Order not found', 404);
  return o;
}

async function getOrder(orderNumber) {
  return store.presentOrder(await findOrder(orderNumber));
}

const qrPayload = (token) => QR_PREFIX + token;
const qrDataUrl = (token, width = 240) => QRCode.toDataURL(qrPayload(token), { errorCorrectionLevel: 'M', margin: 1, width });

// --- the steps --------------------------------------------------------------------------

const text = (v, max) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

async function applyStep(orderNumber, action, body = {}, actorId = null) {
  const step = STEPS[action];
  if (!step) throw new AppError('Unknown step', 422);
  const order = await findOrder(orderNumber);
  if (step.only && order.fulfilment !== step.only) {
    throw new AppError(`"${step.label}" is only for ${step.only === 'PICKUP' ? 'pickup' : 'delivery'} orders`, 422);
  }
  if (!step.from.includes(order.status)) {
    throw new AppError(`This order is ${store.STATUS_LABELS[order.status] || order.status}, so it cannot be marked "${step.label}"`, 409);
  }
  // The buyer asked to cancel: do not pack it while that is open.
  if (action === 'pack' || action === 'holdAddress') {
    const cancel = await require('./merchReturns.service').openCancellation(order.id); // eslint-disable-line global-require
    if (cancel) throw new AppError(`The buyer asked to cancel this order (${cancel.returnNumber}). Approve or reject that first.`, 409);
  }
  const note = text(body.note, 300);
  if (step.note && !note) throw new AppError(action === 'holdAddress' ? 'Say what looks wrong with the address' : 'Add a short note', 422);
  const data = {};
  let to = step.to;
  if (action === 'ship') {
    data.courier = text(body.courier, 80);
    data.trackingNumber = text(body.trackingNumber, 80);
    if (!data.courier || !data.trackingNumber) throw new AppError('Enter the courier and the tracking number', 422);
  }
  if (action === 'holdAddress') { data.holdFromStatus = order.status; data.addressNote = note; }
  if (action === 'resume') { to = order.holdFromStatus || 'PAID'; data.holdFromStatus = null; data.addressNote = null; }
  if (action === 'pickedUp') data.pickedUpById = actorId;
  if (step.stamp) data[step.stamp] = new Date();

  await prisma.$transaction(async (tx) => {
    const moved = await tx.merchOrder.updateMany({ where: { id: order.id, status: order.status }, data: { ...data, status: to } });
    if (moved.count !== 1) throw new AppError('Someone else just changed this order. Reload and try again.', 409);
    const what = action === 'ship' ? `${data.courier}, tracking ${data.trackingNumber}` : note;
    await store.addEvent(tx, order.id, to, what, actorId);
  });

  const fresh = await getOrder(orderNumber);
  if (step.email) sendStatusEmail(fresh, step.email);
  return fresh;
}

// Packing day: many orders at once. Each one is moved on its own, so one
// that cannot move (already packed, wrong kind) does not stop the rest.
async function applyBulk(action, orderNumbers, actorId) {
  if (!BULK_STEPS.includes(action)) throw new AppError('Only "Packed" and "Ready for pickup" can be done in bulk', 422);
  const list = [...new Set((Array.isArray(orderNumbers) ? orderNumbers : []).map(String))].slice(0, 200);
  if (!list.length) throw new AppError('Select at least one order', 422);
  const done = [];
  const failed = [];
  for (const n of list) {
    try {
      await applyStep(n, action, {}, actorId); // eslint-disable-line no-await-in-loop
      done.push(n);
    } catch (err) {
      failed.push({ orderNumber: n, message: err.message });
    }
  }
  return { done, failed };
}

async function sendStatusEmail(order, kind) {
  try {
    await mail().sendMerchStatusEmail(order, kind);
  } catch (err) {
    console.error('Merchandise status email failed:', order.orderNumber, kind, err.message);
  }
}

// --- pickup handover --------------------------------------------------------------------

// What a scanner (or a typed order number) gives: the order behind it.
async function lookupForHandover(raw) {
  const value = String(raw || '').trim();
  let where = null;
  const token = value.toUpperCase().startsWith(QR_PREFIX) ? value.slice(QR_PREFIX.length).trim().toLowerCase() : value.toLowerCase();
  if (/^[0-9a-f]{32}$/.test(token)) where = { qrToken: token };
  else if (/^ORD-\d{4}-\d{6,}$/i.test(value)) where = { orderNumber: value.toUpperCase() };
  if (!where) throw new AppError('That is not a JPSME order QR or order number', 422);
  const o = await prisma.merchOrder.findUnique({ where, include: ORDER_INCLUDE });
  if (!o) throw new AppError('No order matches that code', 404);
  if (o.fulfilment !== 'PICKUP') throw new AppError(`${o.orderNumber} is a delivery order, not a pickup`, 409);
  return store.presentOrder(o);
}

async function handOver(raw, actorId) {
  const order = await lookupForHandover(raw);
  if (order.status === 'PICKED_UP') throw new AppError(`${order.orderNumber} was already picked up`, 409);
  if (!['READY_FOR_PICKUP', 'UNCLAIMED'].includes(order.status)) {
    throw new AppError(`${order.orderNumber} is ${order.statusLabel}, not ready for pickup yet`, 409);
  }
  return applyStep(order.orderNumber, 'pickedUp', {}, actorId);
}

// --- list, export, print ---------------------------------------------------------------

function parseFilters(query = {}) {
  const status = Object.keys(store.STATUS_LABELS).includes(String(query.status || '')) ? String(query.status) : null;
  const fulfilment = ['DELIVERY', 'PICKUP'].includes(String(query.fulfilment || '')) ? String(query.fulfilment) : null;
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  return {
    status, fulfilment, from: date(query.from), to: date(query.to),
    q: String(query.q || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    page: Math.max(1, Math.min(10000, Number.parseInt(query.page, 10) || 1)),
    // Unpaid orders that never went anywhere are noise for staff unless asked for.
    includeUnpaid: query.status === 'AWAITING_PAYMENT' || query.unpaid === '1',
  };
}

function whereFor(f, { withStatus = true } = {}) {
  const and = [];
  if (withStatus && f.status) and.push({ status: f.status });
  else if (!f.includeUnpaid) and.push({ status: { notIn: ['AWAITING_PAYMENT'] } });
  if (f.fulfilment) and.push({ fulfilment: f.fulfilment });
  const created = {};
  if (f.from) created.gte = new Date(`${f.from}T00:00:00+08:00`);
  if (f.to) created.lt = new Date(new Date(`${f.to}T00:00:00+08:00`).getTime() + 864e5);
  if (Object.keys(created).length) and.push({ createdAt: created });
  f.q.split(' ').filter(Boolean).forEach((w) => and.push({
    OR: [{ orderNumber: { contains: w } }, { buyerName: { contains: w } }, { buyerEmail: { contains: w } }, { trackingNumber: { contains: w } }],
  }));
  return { AND: and };
}

async function listOrders(query) {
  const f = parseFilters(query);
  const where = whereFor(f);
  const [total, rows, grouped] = await Promise.all([
    prisma.merchOrder.count({ where }),
    prisma.merchOrder.findMany({
      where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // oldest first: the packing order
      skip: (f.page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { items: true },
    }),
    prisma.merchOrder.groupBy({ by: ['status'], where: whereFor({ ...f, status: null, includeUnpaid: true }, { withStatus: false }), _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  return {
    filters: f,
    orders: rows.map(store.presentOrder),
    counts,
    total,
    page: f.page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    pageSize: PAGE_SIZE,
  };
}

// The pick list (everything to pull, by variant) and one packing slip per
// order, for the orders given or else every paid, unpacked one.
async function printData(orderNumbers) {
  const list = (Array.isArray(orderNumbers) ? orderNumbers : String(orderNumbers || '').split(',')).map((s) => s.trim()).filter(Boolean).slice(0, 200);
  const orders = await prisma.merchOrder.findMany({
    where: list.length ? { orderNumber: { in: list } } : { status: 'PAID' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: ORDER_INCLUDE,
  });
  const pick = new Map();
  orders.forEach((o) => o.items.forEach((i) => {
    const k = i.sku;
    const row = pick.get(k) || { sku: i.sku, productName: i.productName, label: i.variantLabel, quantity: 0, orders: 0 };
    row.quantity += i.quantity; row.orders += 1;
    pick.set(k, row);
  }));
  const slips = [];
  for (const o of orders) {
    const p = store.presentOrder(o);
    slips.push({ ...p, qr: o.qrToken ? await qrDataUrl(o.qrToken, 160) : null }); // eslint-disable-line no-await-in-loop
  }
  return { pickList: [...pick.values()].sort((a, b) => a.productName.localeCompare(b.productName) || a.label.localeCompare(b.label)), slips };
}

async function exportOrdersExcel(query) {
  const f = parseFilters(query);
  const rows = await prisma.merchOrder.findMany({ where: whereFor(f), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { items: true, payment: { select: { gatewayPaymentId: true } } }, take: 20000 });
  const peso = (c) => (c || 0) / 100;
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('Orders');
  a.columns = [
    { header: 'Order', key: 'orderNumber', width: 18 },
    { header: 'Placed', key: 'createdAt', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Buyer', key: 'buyerName', width: 24 },
    { header: 'Email', key: 'buyerEmail', width: 30 },
    { header: 'Delivery / pickup', key: 'fulfilment', width: 16 },
    { header: 'Zone or pickup point', key: 'where', width: 26 },
    { header: 'Items', key: 'items', width: 40 },
    { header: 'Items total', key: 'subtotal', width: 12, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Delivery fee', key: 'delivery', width: 12, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Channel fee', key: 'channel', width: 12, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Total paid', key: 'total', width: 12, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Courier', key: 'courier', width: 14 },
    { header: 'Tracking', key: 'trackingNumber', width: 20 },
    { header: 'PayMongo reference', key: 'ref', width: 26 },
  ];
  rows.forEach((o) => {
    const point = (() => { try { return JSON.parse(o.pickupPoint || 'null'); } catch (e) { return null; } })();
    a.addRow({
      ...o,
      status: store.STATUS_LABELS[o.status] || o.status,
      fulfilment: o.fulfilment === 'PICKUP' ? 'Pickup' : o.fulfilment === 'DELIVERY' ? 'Delivery' : '',
      where: o.fulfilment === 'PICKUP' ? (point ? point.name : '') : (o.zoneName || ''),
      items: o.items.map((i) => `${i.quantity} x ${i.productName} (${i.variantLabel})`).join('; '),
      subtotal: peso(o.subtotalCentavos), delivery: peso(o.deliveryFeeCentavos), channel: peso(o.channelFeeCentavos), total: peso(o.totalCentavos),
      ref: o.payment ? o.payment.gatewayPaymentId || '' : '',
    });
  });
  a.getRow(1).font = { bold: true };
  a.views = [{ state: 'frozen', ySplit: 1 }];
  if (a.rowCount > 1) a.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: a.columnCount } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- reminders ---------------------------------------------------------------------------

// Ready for pickup for 7 days and not collected: one reminder email.
async function remindUncollected(now = new Date()) {
  const due = await prisma.merchOrder.findMany({
    where: { status: 'READY_FOR_PICKUP', pickupReminderAt: null, readyAt: { lt: new Date(now.getTime() - REMIND_AFTER_DAYS * 864e5) } },
    include: ORDER_INCLUDE, take: 50,
  });
  for (const o of due) {
    const moved = await prisma.merchOrder.updateMany({ where: { id: o.id, pickupReminderAt: null }, data: { pickupReminderAt: now } }); // eslint-disable-line no-await-in-loop
    if (moved.count === 1) {
      await store.addEvent(prisma, o.id, o.status, `Reminder sent: waiting ${REMIND_AFTER_DAYS} days for pickup`); // eslint-disable-line no-await-in-loop
      await sendStatusEmail(store.presentOrder(o), 'PICKUP_REMINDER'); // eslint-disable-line no-await-in-loop
    }
  }
  return due.length;
}

module.exports = {
  QR_PREFIX,
  STEPS,
  getOrder,
  applyStep,
  applyBulk,
  lookupForHandover,
  handOver,
  listOrders,
  printData,
  exportOrdersExcel,
  remindUncollected,
  qrDataUrl,
};
