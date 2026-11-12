const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const merch = require('./merch.service');
const store = require('./merchStore.service');
const returnsService = require('./merchReturns.service');

// The money side of the store (phase 4): the dashboard, the sales reports,
// the daily reconciliation against PayMongo and the month-end pack.
//
//   Sold        an order whose payment reached PAID (or later REFUNDED), counted
//               on the Philippine day PayMongo took the money (payments.paidAt).
//   Refunds     refunds PayMongo confirmed (refunds.status SUCCEEDED), on the
//               day they were confirmed. Net = charged - PayMongo fees - refunds.
//   Cost        each order line keeps the unit cost from when it was sold
//               (merch_order_items.unitCostCentavos), so a later cost change
//               does not rewrite past profit. A line with no cost yet is
//               counted as "cost missing", never as zero.
//
// Cost and profit figures are built here for everyone and taken out by the
// caller (utils/merchRedact) for anyone without cost.view.

const paymongo = () => require('./paymongo.service'); // eslint-disable-line global-require

// --- Philippine days -----------------------------------------------------------------------

const DAY = 864e5;
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? String(v) : null);
const ym = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : null);
const manilaYmd = (d = new Date()) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const dayStart = (d) => new Date(`${d}T00:00:00+08:00`);
const dayRange = (d) => ({ gte: dayStart(d), lt: new Date(dayStart(d).getTime() + DAY) });
const addDays = (d, n) => manilaYmd(new Date(dayStart(d).getTime() + n * DAY + 3600e3));
function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const first = `${m}-01`;
  const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  return { first, next, range: { gte: dayStart(first), lt: dayStart(next) } };
}
// A DATE column holds the calendar day; Prisma reads and writes it as UTC midnight.
const dbDay = (d) => new Date(`${d}T00:00:00Z`);
const fromDbDay = (v) => new Date(v).toISOString().slice(0, 10);

// The period a report covers: from/to (Philippine days), this month by default.
function parsePeriod(query = {}) {
  const today = manilaYmd();
  let from = ymd(query.from);
  let to = ymd(query.to);
  if (!from && !to) { from = `${today.slice(0, 7)}-01`; to = today; }
  if (!from) from = to;
  if (!to) to = from;
  if (from > to) [from, to] = [to, from];
  return { from, to, range: { gte: dayStart(from), lt: new Date(dayStart(to).getTime() + DAY) } };
}

// --- sales ----------------------------------------------------------------------------------

const SOLD = ['PAID', 'REFUNDED'];

async function salesData(range) {
  const [pays, refunds, rets] = await Promise.all([
    prisma.payment.findMany({
      where: { purpose: 'MERCHANDISE', status: { in: SOLD }, paidAt: range },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, amount: true, gatewayFeeCentavos: true, paidAt: true, gatewayPaymentId: true, status: true,
        merchOrder: { include: { items: { orderBy: { id: 'asc' } } } },
      },
    }),
    prisma.refund.findMany({
      where: { status: 'SUCCEEDED', updatedAt: range, payment: { purpose: 'MERCHANDISE' } },
      orderBy: { updatedAt: 'asc' },
      select: { id: true, amount: true, updatedAt: true, reason: true, payment: { select: { merchOrder: { select: { orderNumber: true, buyerName: true } } } } },
    }),
    prisma.merchReturn.findMany({
      where: { OR: [{ createdAt: range }, { completedAt: range }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        order: { select: { orderNumber: true, buyerName: true } },
        items: { include: { orderItem: { select: { productName: true, variantLabel: true } }, newVariant: { select: { label: true } } } },
      },
    }),
  ]);
  const orders = pays.filter((p) => p.merchOrder).map((p) => ({ ...p.merchOrder, payment: p }));
  const orgIds = [...new Set(orders.map((o) => o.organizationId).filter(Boolean))];
  const orgs = orgIds.length ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [];
  return { orders, refunds, returns: rets, orgName: new Map(orgs.map((o) => [o.id, o.name])) };
}

function summarize({ orders, refunds }) {
  const s = {
    orders: orders.length, units: 0, itemSalesCentavos: 0, deliveryCentavos: 0, channelCentavos: 0,
    chargedCentavos: 0, paymongoFeeCentavos: 0, refundsCentavos: 0, refundCount: refunds.length,
    costCentavos: 0, costMissingUnits: 0, profitCentavos: 0, netCentavos: 0,
  };
  let salesWithCost = 0;
  orders.forEach((o) => {
    s.deliveryCentavos += o.deliveryFeeCentavos || 0;
    s.channelCentavos += o.channelFeeCentavos || 0;
    s.chargedCentavos += o.payment.amount || 0;
    s.paymongoFeeCentavos += o.payment.gatewayFeeCentavos || 0;
    o.items.forEach((i) => {
      s.units += i.quantity;
      s.itemSalesCentavos += i.unitPriceCentavos * i.quantity;
      if (i.unitCostCentavos === null || i.unitCostCentavos === undefined) s.costMissingUnits += i.quantity;
      else { s.costCentavos += i.unitCostCentavos * i.quantity; salesWithCost += i.unitPriceCentavos * i.quantity; }
    });
  });
  s.refundsCentavos = refunds.reduce((t, r) => t + (r.amount || 0), 0);
  s.netCentavos = s.chargedCentavos - s.paymongoFeeCentavos - s.refundsCentavos;
  // Profit on the items whose cost is known; refunds are shown apart.
  s.profitCentavos = salesWithCost - s.costCentavos;
  return s;
}

function byProduct({ orders }) {
  const rows = new Map();
  orders.forEach((o) => o.items.forEach((i) => {
    const r = rows.get(i.sku) || {
      sku: i.sku, productName: i.productName, label: i.variantLabel, units: 0, salesCentavos: 0,
      costCentavos: 0, costMissingUnits: 0, profitCentavos: 0,
    };
    r.units += i.quantity;
    r.salesCentavos += i.unitPriceCentavos * i.quantity;
    if (i.unitCostCentavos === null || i.unitCostCentavos === undefined) r.costMissingUnits += i.quantity;
    else { r.costCentavos += i.unitCostCentavos * i.quantity; r.profitCentavos += (i.unitPriceCentavos - i.unitCostCentavos) * i.quantity; }
    rows.set(i.sku, r);
  }));
  return [...rows.values()].sort((a, b) => b.salesCentavos - a.salesCentavos || a.productName.localeCompare(b.productName));
}

function byOrganization({ orders, orgName }) {
  const rows = new Map();
  orders.forEach((o) => {
    const k = o.organizationId || 0;
    const r = rows.get(k) || { organizationId: o.organizationId || null, organization: o.organizationId ? (orgName.get(o.organizationId) || `Organization ${o.organizationId}`) : 'No organization', orders: 0, buyers: new Set(), units: 0, salesCentavos: 0 };
    r.orders += 1;
    r.buyers.add(o.userId || o.buyerEmail);
    o.items.forEach((i) => { r.units += i.quantity; r.salesCentavos += i.unitPriceCentavos * i.quantity; });
    rows.set(k, r);
  });
  return [...rows.values()].map((r) => ({ ...r, buyers: r.buyers.size })).sort((a, b) => b.salesCentavos - a.salesCentavos);
}

function returnRows({ returns }) {
  return returns.map((r) => ({
    returnNumber: r.returnNumber,
    orderNumber: r.order ? r.order.orderNumber : '',
    buyerName: r.order ? r.order.buyerName : '',
    kind: r.kind === 'EXCHANGE' ? 'Exchange' : 'Refund',
    reason: returnsService.REASONS[r.reason] || r.reason,
    status: returnsService.STATUS_LABELS[r.status] || r.status,
    items: r.items.map((i) => `${i.quantity} x ${i.orderItem.productName} (${i.orderItem.variantLabel})${i.newVariant ? ` -> ${i.newVariant.label}` : ''}`).join('; '),
    refundCentavos: r.kind === 'REFUND' ? r.refundCentavos : null,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  }));
}

async function salesReport(query) {
  const period = parsePeriod(query);
  const data = await salesData(period.range);
  return {
    period: { from: period.from, to: period.to },
    summary: summarize(data),
    products: byProduct(data),
    organizations: byOrganization(data),
    returns: returnRows(data),
  };
}

// --- the dashboard -------------------------------------------------------------------------

const OPEN_RETURN = ['REQUESTED', 'CHECKED', 'NEEDS_SECOND', 'REFUND_SENT', 'NEW_HELD', 'OLD_RECEIVED'];

async function dashboard() {
  const today = manilaYmd();
  const month = monthRange(today.slice(0, 7));
  const [todayData, monthData, grouped, retGrouped, inventory, recent, recon] = await Promise.all([
    salesData(dayRange(today)),
    salesData(month.range),
    prisma.merchOrder.groupBy({ by: ['status'], where: { status: { in: ['PAID', 'PACKED', 'SHIPPED', 'ADDRESS_HOLD', 'READY_FOR_PICKUP'] } }, _count: { _all: true } }),
    prisma.merchReturn.groupBy({ by: ['status'], where: { status: { in: OPEN_RETURN } }, _count: { _all: true } }),
    merch.listInventory({}),
    prisma.merchOrder.findMany({ where: { paidAt: { not: null } }, orderBy: { paidAt: 'desc' }, take: 8, select: { orderNumber: true, buyerName: true, status: true, totalCentavos: true, paidAt: true, fulfilment: true } }),
    reconciliationStatus(),
  ]);
  const orderCounts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const returnCounts = Object.fromEntries(retGrouped.map((g) => [g.status, g._count._all]));
  return {
    today: summarize(todayData),
    month: { label: new Date(dayStart(month.first)).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'long', year: 'numeric' }), ...summarize(monthData) },
    topProducts: byProduct(monthData).slice(0, 5),
    work: {
      toPack: orderCounts.PAID || 0,
      packed: orderCounts.PACKED || 0,
      inTransit: orderCounts.SHIPPED || 0,
      addressHold: orderCounts.ADDRESS_HOLD || 0,
      awaitingPickup: orderCounts.READY_FOR_PICKUP || 0,
      returnsForLogistics: (returnCounts.REQUESTED || 0) + (returnCounts.NEW_HELD || 0) + (returnCounts.OLD_RECEIVED || 0),
      refundsToApprove: returnCounts.CHECKED || 0,
      refundsSecond: returnCounts.NEEDS_SECOND || 0,
      refundsAtPayMongo: returnCounts.REFUND_SENT || 0,
    },
    stock: {
      low: inventory.totals.low,
      soldOut: inventory.totals.soldOut,
      units: inventory.totals.units,
      valueCentavos: inventory.totals.valueCentavos,
      costMissing: inventory.totals.costMissing,
      lowRows: inventory.rows.filter((r) => r.stockState !== 'OK' && r.productActive).slice(0, 6)
        .map((r) => ({ id: r.id, productName: r.productName, label: r.label, sku: r.sku, onHand: r.onHand, stockState: r.stockState })),
    },
    recent: recent.map((o) => ({ ...o, statusLabel: store.STATUS_LABELS[o.status] || o.status })),
    reconciliation: recon,
  };
}

// --- the daily reconciliation ----------------------------------------------------------------

const GAP_LABELS = {
  NOT_AT_PAYMONGO: 'Paid here, but PayMongo does not show it paid',
  NOT_HERE: 'Paid at PayMongo, but not marked paid here',
  AMOUNT: 'The amount differs from PayMongo',
  REFERENCE: 'The PayMongo payment reference differs',
  NO_CHECKOUT: 'Paid here with no PayMongo checkout on record',
  NOT_CHECKED: 'PayMongo could not be reached for this one; run the check again',
};

// Every store payment of one Philippine day checked against PayMongo, one
// checkout session at a time:
//   - paid here that day: PayMongo must show it paid, same amount, same reference
//   - started that day and not paid here: PayMongo must not show it paid
//     (a missed webhook; Reconcile on the Payments page fixes it)
// The result is saved for the day (run again to refresh it). Nothing about a
// payment or order is changed here: this only reports.
async function reconcileDay(day, actorId, { note } = {}) {
  const d = ymd(day);
  if (!d) throw new AppError('Choose a day', 422);
  if (d > manilaYmd()) throw new AppError('That day has not happened yet', 422);
  const range = dayRange(d);
  const pays = await prisma.payment.findMany({
    where: {
      purpose: 'MERCHANDISE',
      OR: [{ status: { in: SOLD }, paidAt: range }, { status: { notIn: SOLD }, createdAt: range }],
    },
    orderBy: { id: 'asc' },
    take: 2000,
    select: { id: true, amount: true, status: true, paidAt: true, gatewayCheckoutId: true, gatewayPaymentId: true, merchOrder: { select: { orderNumber: true } } },
  });
  const gaps = [];
  let siteCount = 0;
  let siteCentavos = 0;
  let feeCentavos = 0;
  for (const p of pays) {
    const sitePaid = SOLD.includes(p.status);
    const ref = (p.merchOrder && p.merchOrder.orderNumber) || `Payment #${p.id}`;
    const gap = (code, extra = {}) => gaps.push({ code, label: GAP_LABELS[code], order: ref, paymentId: p.id, ...extra });
    if (sitePaid) { siteCount += 1; siteCentavos += p.amount; }
    if (!p.gatewayCheckoutId) { if (sitePaid) gap('NO_CHECKOUT'); continue; }
    let session;
    try {
      session = await paymongo().getCheckoutSession(p.gatewayCheckoutId); // eslint-disable-line no-await-in-loop
    } catch (err) {
      gap('NOT_CHECKED');
      continue;
    }
    const paid = ((session && session.attributes && session.attributes.payments) || []).find((x) => x && x.attributes && x.attributes.status === 'paid');
    if (sitePaid && !paid) gap('NOT_AT_PAYMONGO', { siteCentavos: p.amount });
    else if (!sitePaid && paid) gap('NOT_HERE', { paymongoCentavos: paid.attributes.amount });
    else if (sitePaid && paid) {
      feeCentavos += Number(paid.attributes.fee) || 0;
      if (Number(paid.attributes.amount) !== p.amount) gap('AMOUNT', { siteCentavos: p.amount, paymongoCentavos: Number(paid.attributes.amount) });
      else if (p.gatewayPaymentId && paid.id !== p.gatewayPaymentId) gap('REFERENCE', { site: p.gatewayPaymentId, paymongo: paid.id });
    }
  }
  const data = {
    status: gaps.length ? 'GAPS' : 'MATCHED',
    siteCount, siteCentavos, feeCentavos,
    gaps: gaps.length ? JSON.stringify(gaps) : null,
    checkedById: actorId || null,
    checkedAt: new Date(),
    ...(note !== undefined ? { note: String(note || '').trim().slice(0, 500) || null } : {}),
  };
  const row = await prisma.merchReconciliation.upsert({ where: { day: dbDay(d) }, create: { day: dbDay(d), ...data }, update: data });
  return presentRecon(row);
}

// Finance's explanation of a day's gaps (e.g. "PayMongo settled it the next
// day"). The day then shows as Explained; a new check replaces the status but
// keeps the note.
async function explainDay(day, note, actorId) {
  const d = ymd(day);
  if (!d) throw new AppError('Choose a day', 422);
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) throw new AppError('Write what explains the gaps', 422);
  const row = await prisma.merchReconciliation.findUnique({ where: { day: dbDay(d) } });
  if (!row) throw new AppError('Check this day first', 409);
  if (row.status === 'MATCHED') throw new AppError('This day matched; there is nothing to explain', 409);
  const saved = await prisma.merchReconciliation.update({ where: { id: row.id }, data: { status: 'EXPLAINED', note: text, checkedById: actorId || row.checkedById } });
  return presentRecon(saved);
}

const RECON_LABELS = { MATCHED: 'Matched', GAPS: 'Gaps found', EXPLAINED: 'Gaps explained' };

function presentRecon(r, who) {
  if (!r) return null;
  let gaps = [];
  try { gaps = r.gaps ? JSON.parse(r.gaps) : []; } catch (e) { gaps = []; }
  return {
    day: fromDbDay(r.day), status: r.status, statusLabel: RECON_LABELS[r.status] || r.status,
    siteCount: r.siteCount, siteCentavos: r.siteCentavos, feeCentavos: r.feeCentavos,
    gaps, note: r.note, checkedAt: r.checkedAt, checkedBy: who || null,
  };
}

// Paid store payments per Philippine day within a range: { 'YYYY-MM-DD': { count, centavos } }.
async function paidByDay(range) {
  const rows = await prisma.payment.findMany({ where: { purpose: 'MERCHANDISE', status: { in: SOLD }, paidAt: range }, select: { amount: true, paidAt: true } });
  const out = {};
  rows.forEach((p) => {
    const k = manilaYmd(p.paidAt);
    out[k] = out[k] || { count: 0, centavos: 0 };
    out[k].count += 1;
    out[k].centavos += p.amount;
  });
  return out;
}

// One month, day by day up to today: what was paid here and the day's check.
async function reconciliationMonth(month) {
  const m = ym(month) || manilaYmd().slice(0, 7);
  const { first, next, range } = monthRange(m);
  const [paid, rows] = await Promise.all([
    paidByDay(range),
    prisma.merchReconciliation.findMany({
      where: { day: { gte: dbDay(first), lt: dbDay(next) } },
      include: { checkedBy: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  const byDay = new Map(rows.map((r) => [fromDbDay(r.day), r]));
  const today = manilaYmd();
  const days = [];
  for (let d = first; d < next && d <= today; d = addDays(d, 1)) {
    const r = byDay.get(d);
    days.push({
      day: d,
      paidCount: (paid[d] || {}).count || 0,
      paidCentavos: (paid[d] || {}).centavos || 0,
      check: r ? presentRecon(r, r.checkedBy ? `${r.checkedBy.firstName} ${r.checkedBy.lastName}` : null) : null,
    });
  }
  const [y, mo] = m.split('-').map(Number);
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const nextMonth = next.slice(0, 7);
  return {
    month: m,
    label: dayStart(first).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'long', year: 'numeric' }),
    prev,
    next: nextMonth <= today.slice(0, 7) ? nextMonth : null,
    days: days.reverse(),
    totals: {
      daysWithSales: days.filter((x) => x.paidCount).length,
      matched: days.filter((x) => x.check && x.check.status === 'MATCHED').length,
      gaps: days.filter((x) => x.check && x.check.status === 'GAPS').length,
      explained: days.filter((x) => x.check && x.check.status === 'EXPLAINED').length,
      unchecked: days.filter((x) => x.paidCount && !x.check && x.day < today).length,
    },
  };
}

// For the dashboard: the last 60 days.
async function reconciliationStatus() {
  const today = manilaYmd();
  const start = addDays(today, -60);
  const [paid, rows] = await Promise.all([
    paidByDay({ gte: dayStart(start), lt: dayStart(today) }),
    prisma.merchReconciliation.findMany({ where: { day: { gte: dbDay(start) } }, select: { day: true, status: true } }),
  ]);
  const checked = new Map(rows.map((r) => [fromDbDay(r.day), r.status]));
  const unchecked = Object.keys(paid).filter((d) => !checked.has(d)).sort();
  const last = await prisma.merchReconciliation.findFirst({ orderBy: { day: 'desc' }, select: { day: true, status: true } });
  return {
    uncheckedDays: unchecked.length,
    oldestUnchecked: unchecked[0] || null,
    gapDays: rows.filter((r) => r.status === 'GAPS').length,
    lastChecked: last ? { day: fromDbDay(last.day), status: last.status, statusLabel: RECON_LABELS[last.status] } : null,
  };
}

// --- workbooks -----------------------------------------------------------------------------

const PESO = { numFmt: '"₱"#,##0.00' };
const WHEN = { numFmt: 'yyyy-mm-dd hh:mm' };
const p = (c) => (c === null || c === undefined ? null : c / 100);

function addSheet(wb, name, columns, rows, notes) {
  const sheet = wb.addWorksheet(name);
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  rows.forEach((r) => sheet.addRow(r));
  if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (notes && notes.length) { sheet.addRow([]); notes.forEach((n) => sheet.addRow([n])); }
  return sheet;
}

function summaryRows(s, withCost) {
  return [
    ['Orders paid', s.orders],
    ['Units sold', s.units],
    ['Item sales', p(s.itemSalesCentavos)],
    ['Delivery fees collected', p(s.deliveryCentavos)],
    ['Channel fees collected', p(s.channelCentavos)],
    ['Total charged by PayMongo', p(s.chargedCentavos)],
    ['PayMongo fees', p(s.paymongoFeeCentavos)],
    [`Refunds confirmed (${s.refundCount})`, p(s.refundsCentavos)],
    ['Net received', p(s.netCentavos)],
    ...(withCost ? [
      ['Cost of items sold (known cost)', p(s.costCentavos)],
      ['Profit on items (known cost, before refunds)', p(s.profitCentavos)],
      ['Units sold with no cost yet', s.costMissingUnits],
    ] : []),
  ].map(([what, value]) => ({ what, value }));
}

function salesSheets(wb, report, withCost, periodLabel) {
  const sum = addSheet(wb, 'Summary', [{ header: 'Merchandise', key: 'what', width: 44 }, { header: periodLabel, key: 'value', width: 18 }], summaryRows(report.summary, withCost), [
    'Sales are counted on the day PayMongo took the payment; refunds on the day PayMongo confirmed them.',
    'Net received = total charged - PayMongo fees - refunds.',
  ]);
  for (let r = 2; r <= sum.rowCount; r += 1) {
    const label = String(sum.getRow(r).getCell(1).value || '');
    if (!/^(Orders|Units)/.test(label)) sum.getRow(r).getCell(2).numFmt = PESO.numFmt;
  }
  addSheet(wb, 'By product', [
    { header: 'Product', key: 'productName', width: 24 },
    { header: 'Variant', key: 'label', width: 20 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'Units', key: 'units', width: 10 },
    { header: 'Sales', key: 'sales', width: 14, style: PESO },
    ...(withCost ? [
      { header: 'Cost', key: 'cost', width: 14, style: PESO },
      { header: 'Profit', key: 'profit', width: 14, style: PESO },
      { header: 'Units with no cost', key: 'costMissingUnits', width: 18 },
    ] : []),
  ], report.products.map((r) => ({ ...r, sales: p(r.salesCentavos), cost: p(r.costCentavos), profit: p(r.profitCentavos) })));
  addSheet(wb, 'By organization', [
    { header: 'Student organization', key: 'organization', width: 36 },
    { header: 'Orders', key: 'orders', width: 10 },
    { header: 'Buyers', key: 'buyers', width: 10 },
    { header: 'Units', key: 'units', width: 10 },
    { header: 'Item sales', key: 'sales', width: 14, style: PESO },
  ], report.organizations.map((r) => ({ ...r, sales: p(r.salesCentavos) })), ['The organization is the buyer\'s when they ordered.']);
  addSheet(wb, 'Refunds & exchanges', [
    { header: 'Request', key: 'returnNumber', width: 18 },
    { header: 'Order', key: 'orderNumber', width: 18 },
    { header: 'Buyer', key: 'buyerName', width: 24 },
    { header: 'Kind', key: 'kind', width: 10 },
    { header: 'Reason', key: 'reason', width: 22 },
    { header: 'Status', key: 'status', width: 24 },
    { header: 'Items', key: 'items', width: 44 },
    { header: 'Refund', key: 'refund', width: 12, style: PESO },
    { header: 'Asked on', key: 'createdAt', width: 18, style: WHEN },
    { header: 'Completed', key: 'completedAt', width: 18, style: WHEN },
  ], report.returns.map((r) => ({ ...r, refund: p(r.refundCentavos) })));
}

async function exportSales(query, { withCost = false } = {}) {
  const report = await salesReport(query);
  const wb = new ExcelJS.Workbook();
  salesSheets(wb, report, withCost, `${report.period.from} to ${report.period.to}`);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), period: report.period };
}

// The month-end pack for Finance: the month's sales, every paid order (no
// addresses), refunds and exchanges, the reconciliation day by day, the
// stock movements and the stock on hand at the end of the month.
async function monthEndExport(month, { withCost = false } = {}) {
  const m = ym(month);
  if (!m) throw new AppError('Choose a month', 422);
  const { first, next, range } = monthRange(m);
  const lastDay = addDays(next, -1);
  const report = await salesReport({ from: first, to: lastDay });
  const data = await salesData(range);
  const recon = await reconciliationMonth(m);
  const [moves, variants, stockAtEnd] = await Promise.all([
    prisma.merchStockMovement.findMany({
      where: { createdAt: range }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { actor: { select: { firstName: true, lastName: true } }, variant: { select: { sku: true, label: true, product: { select: { name: true } } } } },
    }),
    prisma.merchVariant.findMany({ include: { product: { select: { name: true } } }, orderBy: [{ productId: 'asc' }, { id: 'asc' }] }),
    prisma.merchStockMovement.groupBy({ by: ['variantId'], where: { createdAt: { lt: range.lt }, type: { in: ['RECEIVED', 'DAMAGED', 'COUNT_CORRECTION', 'SOLD', 'RETURNED'] } }, _sum: { quantity: true } }),
  ]);
  const wb = new ExcelJS.Workbook();
  salesSheets(wb, report, withCost, recon.label);

  addSheet(wb, 'Orders', [
    { header: 'Order', key: 'orderNumber', width: 18 },
    { header: 'Paid', key: 'paidAt', width: 18, style: WHEN },
    { header: 'Buyer', key: 'buyerName', width: 24 },
    { header: 'Student organization', key: 'organization', width: 30 },
    { header: 'Delivery / pickup', key: 'fulfilment', width: 14 },
    { header: 'Items', key: 'items', width: 44 },
    { header: 'Items total', key: 'subtotal', width: 12, style: PESO },
    { header: 'Delivery fee', key: 'delivery', width: 12, style: PESO },
    { header: 'Channel fee', key: 'channel', width: 12, style: PESO },
    { header: 'Charged', key: 'charged', width: 12, style: PESO },
    { header: 'PayMongo fee', key: 'fee', width: 12, style: PESO },
    { header: 'Status now', key: 'status', width: 18 },
    { header: 'PayMongo reference', key: 'ref', width: 26 },
  ], data.orders.map((o) => ({
    orderNumber: o.orderNumber, paidAt: o.payment.paidAt, buyerName: o.buyerName,
    organization: o.organizationId ? (data.orgName.get(o.organizationId) || '') : '',
    fulfilment: o.fulfilment === 'PICKUP' ? 'Pickup' : (o.fulfilment === 'DELIVERY' ? 'Delivery' : ''),
    items: o.items.map((i) => `${i.quantity} x ${i.productName} (${i.variantLabel})`).join('; '),
    subtotal: p(o.subtotalCentavos), delivery: p(o.deliveryFeeCentavos), channel: p(o.channelFeeCentavos),
    charged: p(o.payment.amount), fee: p(o.payment.gatewayFeeCentavos),
    status: store.STATUS_LABELS[o.status] || o.status, ref: o.payment.gatewayPaymentId || '',
  })), ['Delivery addresses are left out of this file on purpose (data privacy).']);

  addSheet(wb, 'Refunds paid', [
    { header: 'Confirmed', key: 'at', width: 18, style: WHEN },
    { header: 'Order', key: 'order', width: 18 },
    { header: 'Buyer', key: 'buyer', width: 24 },
    { header: 'Amount', key: 'amount', width: 12, style: PESO },
    { header: 'Reason', key: 'reason', width: 40 },
  ], data.refunds.map((r) => {
    const o = r.payment && r.payment.merchOrder;
    return { at: r.updatedAt, order: o ? o.orderNumber : '', buyer: o ? o.buyerName : '', amount: p(r.amount), reason: r.reason || '' };
  }));

  addSheet(wb, 'Reconciliation', [
    { header: 'Day', key: 'day', width: 12 },
    { header: 'Paid here', key: 'paidCount', width: 10 },
    { header: 'Amount paid here', key: 'paid', width: 16, style: PESO },
    { header: 'Check', key: 'status', width: 16 },
    { header: 'PayMongo fees', key: 'fee', width: 14, style: PESO },
    { header: 'Gaps', key: 'gaps', width: 60 },
    { header: 'Note', key: 'note', width: 40 },
    { header: 'Checked by', key: 'by', width: 22 },
    { header: 'Checked on', key: 'at', width: 18, style: WHEN },
  ], [...recon.days].reverse().map((d) => ({
    day: d.day, paidCount: d.paidCount, paid: p(d.paidCentavos),
    status: d.check ? d.check.statusLabel : (d.paidCount ? 'Not checked' : ''),
    fee: d.check ? p(d.check.feeCentavos) : null,
    gaps: d.check ? d.check.gaps.map((g) => `${g.order}: ${g.label}`).join('; ') : '',
    note: d.check ? d.check.note || '' : '', by: d.check ? d.check.checkedBy || '' : '', at: d.check ? d.check.checkedAt : null,
  })), [`Days with sales: ${recon.totals.daysWithSales}. Matched: ${recon.totals.matched}. Gaps: ${recon.totals.gaps}. Explained: ${recon.totals.explained}. Not checked: ${recon.totals.unchecked}.`]);

  addSheet(wb, 'Stock movements', [
    { header: 'Date', key: 'at', width: 18, style: WHEN },
    { header: 'Product', key: 'product', width: 22 },
    { header: 'Variant', key: 'variant', width: 20 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'Movement', key: 'type', width: 18 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Reason', key: 'reason', width: 36 },
    ...(withCost ? [{ header: 'Unit cost', key: 'unitCost', width: 12, style: PESO }] : []),
    { header: 'By', key: 'by', width: 22 },
  ], moves.map((mv) => ({
    at: mv.createdAt, product: mv.variant.product.name, variant: mv.variant.label, sku: mv.variant.sku,
    type: mv.type, quantity: mv.quantity, reason: mv.reason || '', unitCost: p(mv.unitCostCentavos),
    by: mv.actor ? `${mv.actor.firstName} ${mv.actor.lastName}` : 'System',
  })));

  const onHand = new Map(stockAtEnd.map((g) => [g.variantId, g._sum.quantity || 0]));
  addSheet(wb, 'Stock at month end', [
    { header: 'Product', key: 'product', width: 22 },
    { header: 'Variant', key: 'label', width: 20 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'On hand', key: 'onHand', width: 10 },
    ...(withCost ? [{ header: 'Unit cost (now)', key: 'cost', width: 14, style: PESO }, { header: 'Value at cost', key: 'value', width: 14, style: PESO }] : []),
  ], variants.map((v) => {
    const q = onHand.get(v.id) || 0;
    return { product: v.product.name, label: v.label, sku: v.sku, onHand: q, cost: p(v.costCentavos), value: v.costCentavos === null ? null : (v.costCentavos * Math.max(q, 0)) / 100 };
  }), [`On hand at the end of ${recon.label}, from the stock ledger.${withCost ? ' Value uses each variant\'s current unit cost.' : ''}`]);

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), month: m };
}

module.exports = {
  GAP_LABELS,
  RECON_LABELS,
  manilaYmd,
  parsePeriod,
  salesReport,
  exportSales,
  dashboard,
  reconcileDay,
  explainDay,
  reconciliationMonth,
  reconciliationStatus,
  monthEndExport,
};
