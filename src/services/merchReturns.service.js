const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const settingsService = require('./settings.service');
const store = require('./merchStore.service');

// Merchandise refunds and exchanges, phase 3b (JPSME Merchandise Store Plan v2,
// "Fulfilment, refunds and exchanges"). Logistics moves the goods, Finance
// moves the money; a request passes through both.
//
//   REFUND    REQUESTED -check-> CHECKED -approve-> REFUND_SENT -(PayMongo)-> COMPLETED
//             above the approval limit: CHECKED -approve-> NEEDS_SECOND -approve-> REFUND_SENT
//             Logistics records what came back and what can be sold again
//             (those go back on the shelf). Nobody approves their own request,
//             and the second approver is someone else again, the main admin or
//             a President.
//   EXCHANGE  REQUESTED -accept (new size held)-> NEW_HELD -old item received->
//             OLD_RECEIVED -new item sent or handed over-> COMPLETED.
//             Same price only: no money moves.
//   Either can be REJECTED (with a reason) or, by the buyer before it is
//   approved, WITHDRAWN.
//
// When a buyer may ask: a paid order not yet packed can be cancelled (a refund
// request, no item comes back, packing is blocked while it is open); a
// shipped order can be reported lost in transit; a delivered or picked-up one
// can be refunded or exchanged within the return window (Delivery & Pickup
// settings). One open request per order. PayMongo allows one refund per
// payment, so an order is refunded once, fully or for some items.

const REASONS = {
  WRONG_SIZE: 'Wrong size',
  CHANGE_OF_MIND: 'Changed my mind',
  DAMAGED: 'Damaged or defective',
  LOST_IN_TRANSIT: 'Lost in transit',
  CANCELLED_BEFORE_PACKING: 'Cancelled before packing',
  OTHER: 'Other',
};
const STATUS_LABELS = {
  REQUESTED: 'Waiting for Logistics',
  CHECKED: 'Waiting for approval',
  NEEDS_SECOND: 'Waiting for second approval',
  REFUND_SENT: 'Refund sent to PayMongo',
  REFUND_FAILED: 'Refund failed at PayMongo',
  NEW_HELD: 'New item held',
  OLD_RECEIVED: 'Old item received',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
const CLOSED = ['COMPLETED', 'REJECTED', 'WITHDRAWN', 'REFUND_FAILED'];
const SETTING_LIMIT = 'merchRefundApprovalLimit';
const SETTING_WINDOW = 'merchReturnWindowDays';

const mail = () => require('./mail.service'); // eslint-disable-line global-require
const payments = () => require('./payment.service'); // eslint-disable-line global-require

// --- settings -----------------------------------------------------------------------

async function getSettings() {
  const [limit, windowDays] = await Promise.all([settingsService.getSetting(SETTING_LIMIT, ''), settingsService.getSetting(SETTING_WINDOW, '7')]);
  return {
    approvalLimitCentavos: limit === '' || limit === null ? null : Number(limit),
    windowDays: windowDays === '' || windowDays === null ? null : Number(windowDays),
  };
}

async function setSettings({ approvalLimit, windowDays }) {
  if (approvalLimit !== undefined) {
    const raw = String(approvalLimit || '').trim().replace(/^(₱|php)\s*/i, '').replace(/[,\s]/g, '');
    if (raw && !/^\d+(\.\d{1,2})?$/.test(raw)) throw new AppError('Enter the approval limit as a number of pesos, or leave it empty', 422);
    await settingsService.setSetting(SETTING_LIMIT, raw ? String(Math.round(Number(raw) * 100)) : '');
  }
  if (windowDays !== undefined) {
    const raw = String(windowDays || '').trim();
    if (raw && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 365)) throw new AppError('The return window is 1 to 365 days, or empty for no limit', 422);
    await settingsService.setSetting(SETTING_WINDOW, raw);
  }
  return getSettings();
}

// --- loading and presenting ----------------------------------------------------------------

const INCLUDE = {
  items: { orderBy: { id: 'asc' }, include: { orderItem: true, newVariant: { select: { id: true, label: true, sku: true } } } },
  order: { include: { items: { orderBy: { id: 'asc' } }, payment: { select: { id: true, amount: true, status: true } } } },
};

async function peopleNames(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
}

async function present(r) {
  const names = await peopleNames([r.requestedById, r.checkedById, r.approvedById, r.secondApprovedById]);
  return {
    id: r.id, returnNumber: r.returnNumber, kind: r.kind, kindLabel: r.kind === 'EXCHANGE' ? 'Exchange' : 'Refund',
    status: r.status, statusLabel: STATUS_LABELS[r.status] || r.status, open: !CLOSED.includes(r.status),
    reason: r.reason, reasonLabel: REASONS[r.reason] || r.reason, details: r.details, photoUrl: r.photoUrl,
    byBuyer: r.byBuyer, noItemBack: r.noItemBack,
    requestedBy: names.get(r.requestedById) || null, requestedById: r.requestedById,
    checkedBy: names.get(r.checkedById) || null, checkedAt: r.checkedAt, checkNote: r.checkNote,
    suggestedCentavos: r.suggestedCentavos, refundCentavos: r.refundCentavos,
    approvedBy: names.get(r.approvedById) || null, approvedById: r.approvedById, approvedAt: r.approvedAt,
    secondApprovedBy: names.get(r.secondApprovedById) || null, secondApprovedAt: r.secondApprovedAt,
    rejectReason: r.rejectReason, courier: r.courier, trackingNumber: r.trackingNumber,
    completedAt: r.completedAt, createdAt: r.createdAt,
    orderNumber: r.order ? r.order.orderNumber : null,
    buyerName: r.order ? r.order.buyerName : null,
    paidCentavos: r.order && r.order.payment ? r.order.payment.amount : null,
    items: r.items.map((i) => ({
      id: i.id, orderItemId: i.orderItemId, quantity: i.quantity,
      productName: i.orderItem.productName, label: i.orderItem.variantLabel, sku: i.orderItem.sku, unitPrice: i.orderItem.unitPriceCentavos,
      newVariant: i.newVariant, receivedQty: i.receivedQty, resaleableQty: i.resaleableQty,
    })),
  };
}

async function load(returnNumber) {
  const r = await prisma.merchReturn.findUnique({ where: { returnNumber: String(returnNumber || '') }, include: INCLUDE });
  if (!r) throw new AppError('Request not found', 404);
  return r;
}

async function getReturn(returnNumber) {
  return present(await load(returnNumber));
}

async function listForOrder(orderId) {
  const rows = await prisma.merchReturn.findMany({ where: { orderId }, orderBy: { id: 'desc' }, include: INCLUDE });
  return Promise.all(rows.map(present));
}

// --- what a buyer may ask for ----------------------------------------------------------

// How many of each order line are still the buyer's: bought, minus what an
// earlier finished request already took back.
async function remainingQuantities(order) {
  const done = await prisma.merchReturnItem.groupBy({
    by: ['orderItemId'],
    where: { orderItemId: { in: order.items.map((i) => i.id) }, return: { status: { in: ['COMPLETED', 'REFUND_SENT', 'NEEDS_SECOND', 'CHECKED', 'REQUESTED', 'NEW_HELD', 'OLD_RECEIVED'] }, kind: 'REFUND' } },
    _sum: { quantity: true },
  });
  const used = new Map(done.map((d) => [d.orderItemId, d._sum.quantity || 0]));
  return new Map(order.items.map((i) => [i.id, i.quantity - (used.get(i.id) || 0)]));
}

async function options(order, { ignoreWindow = false } = {}) {
  const open = await prisma.merchReturn.findFirst({ where: { orderId: order.id, status: { notIn: CLOSED } }, select: { returnNumber: true } });
  const refunded = order.paymentId ? await prisma.refund.findUnique({ where: { paymentId: order.paymentId }, select: { id: true } }) : null;
  const settings = await getSettings();
  const out = { cancel: false, refund: false, exchange: false, lostInTransit: false, openRequest: open ? open.returnNumber : null, why: null, windowDays: settings.windowDays };
  if (open) { out.why = `A request is already open (${open.returnNumber})`; return out; }
  if (order.status === 'PAID') { out.cancel = !refunded; return out; }
  if (order.status === 'SHIPPED') { out.lostInTransit = !refunded; return out; }
  if (['DELIVERED', 'PICKED_UP'].includes(order.status)) {
    const since = order.deliveredAt || order.pickedUpAt;
    const inWindow = ignoreWindow || settings.windowDays === null || !since || Date.now() - new Date(since).getTime() <= settings.windowDays * 864e5;
    if (!inWindow) { out.why = `Requests are taken within ${settings.windowDays} days of receiving the order`; return out; }
    out.refund = !refunded;
    out.exchange = true;
    if (refunded) out.why = 'This order was refunded once already; PayMongo allows one refund per payment';
  }
  return out;
}

// --- making a request ----------------------------------------------------------------------

const text = (v, max) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const numberFor = (r) => `RET-${new Date(r.createdAt).getFullYear()}-${String(r.id).padStart(6, '0')}`;

// actor: { id, role } of whoever asks. byBuyer: the buyer themselves (only on
// their own order); otherwise staff raising it for them.
async function createRequest(actor, orderNumber, body = {}, { byBuyer = true, photoUrl = null } = {}) {
  const order = await prisma.merchOrder.findUnique({ where: { orderNumber: String(orderNumber || '') }, include: { items: { orderBy: { id: 'asc' } } } });
  if (!order || (byBuyer && order.userId !== actor.id)) throw new AppError('Order not found', 404);
  // Staff raising it for the buyer are not bound by the buyer's return window.
  const can = await options(order, { ignoreWindow: !byBuyer });
  const kind = String(body.kind || '').toUpperCase();
  let reason = String(body.reason || '').toUpperCase();
  if (kind === 'CANCEL') reason = 'CANCELLED_BEFORE_PACKING';
  if (!REASONS[reason]) throw new AppError('Choose a reason', 422);

  let finalKind = kind === 'EXCHANGE' ? 'EXCHANGE' : 'REFUND';
  if (reason === 'CANCELLED_BEFORE_PACKING' && !can.cancel) throw new AppError(can.why || 'This order can no longer be cancelled: it is already packed or on its way', 409);
  if (reason === 'LOST_IN_TRANSIT' && !can.lostInTransit) throw new AppError(can.why || 'Lost in transit can be reported once the order has shipped', 409);
  if (!['CANCELLED_BEFORE_PACKING', 'LOST_IN_TRANSIT'].includes(reason)) {
    if (finalKind === 'REFUND' && !can.refund) throw new AppError(can.why || 'A refund can be asked for once you have received the order', 409);
    if (finalKind === 'EXCHANGE' && !can.exchange) throw new AppError(can.why || 'An exchange can be asked for once you have received the order', 409);
  }
  if (['CANCELLED_BEFORE_PACKING', 'LOST_IN_TRANSIT'].includes(reason)) finalKind = 'REFUND';
  const details = text(body.details, 1000);
  if (reason === 'DAMAGED' && byBuyer && !photoUrl) throw new AppError('Add a photo of the damage', 422);
  if (reason === 'OTHER' && !details) throw new AppError('Tell us what happened', 422);

  // Which items. Cancelling or a lost parcel: all of what is left.
  const left = await remainingQuantities(order);
  let lines;
  if (['CANCELLED_BEFORE_PACKING', 'LOST_IN_TRANSIT'].includes(reason) || (!byBuyer && body.allItems)) {
    lines = order.items.map((i) => ({ item: i, quantity: left.get(i.id) })).filter((l) => l.quantity > 0);
  } else {
    const wanted = Array.isArray(body.items) ? body.items : [];
    lines = [];
    for (const w of wanted) {
      const item = order.items.find((i) => i.id === Number(w.orderItemId));
      const q = Number(w.quantity);
      if (!item || !Number.isInteger(q) || q < 1) continue;
      if (q > (left.get(item.id) || 0)) throw new AppError(`Only ${left.get(item.id) || 0} of ${item.productName} (${item.variantLabel}) can be included`, 422);
      lines.push({ item, quantity: q, newVariantId: w.newVariantId });
    }
  }
  if (!lines.length) throw new AppError('Choose at least one item', 422);

  // An exchange: a different size or colour of the same product, on sale, at
  // the same price this buyer paid.
  if (finalKind === 'EXCHANGE') {
    for (const l of lines) {
      const v = await prisma.merchVariant.findUnique({ where: { id: Number(l.newVariantId) || 0 }, include: { product: { select: { id: true } } } }); // eslint-disable-line no-await-in-loop
      const original = await prisma.merchVariant.findUnique({ where: { id: l.item.variantId }, select: { productId: true } }); // eslint-disable-line no-await-in-loop
      if (!v || !v.isActive || v.productId !== original.productId || v.id === l.item.variantId) {
        throw new AppError(`Choose another size or colour of ${l.item.productName} to exchange for`, 422);
      }
      const price = l.item.priceType === 'MEMBER' ? v.memberPriceCentavos : v.priceCentavos;
      if (price !== l.item.unitPriceCentavos) {
        throw new AppError(`${v.label} costs a different amount, so it cannot be a straight exchange. Ask for a refund and order it instead.`, 422);
      }
      l.newVariantId = v.id;
    }
  }

  // What would be refunded: the items' value; everything that was paid when the
  // whole order is coming back (cancelled, lost).
  const all = lines.length === order.items.filter((i) => (left.get(i.id) || 0) > 0).length
    && lines.every((l) => l.quantity === left.get(l.item.id));
  const itemsValue = lines.reduce((t, l) => t + l.item.unitPriceCentavos * l.quantity, 0);
  const suggested = finalKind === 'REFUND' ? (all && ['CANCELLED_BEFORE_PACKING', 'LOST_IN_TRANSIT'].includes(reason) ? order.totalCentavos : itemsValue) : null;
  const noItemBack = ['CANCELLED_BEFORE_PACKING', 'LOST_IN_TRANSIT'].includes(reason);

  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.merchReturn.create({
      data: {
        orderId: order.id, kind: finalKind, reason, details, photoUrl,
        // Cancelling before packing has nothing for Logistics to check.
        status: reason === 'CANCELLED_BEFORE_PACKING' ? 'CHECKED' : 'REQUESTED',
        requestedById: actor.id, byBuyer, noItemBack, suggestedCentavos: suggested,
        ...(reason === 'CANCELLED_BEFORE_PACKING' ? { checkedAt: new Date(), checkNote: 'Not packed yet: nothing to send back' } : {}),
        items: { create: lines.map((l) => ({ orderItemId: l.item.id, quantity: l.quantity, newVariantId: l.newVariantId || null })) },
      },
    });
    const numbered = await tx.merchReturn.update({ where: { id: r.id }, data: { returnNumber: numberFor(r) } });
    await store.addEvent(tx, order.id, order.status, `${finalKind === 'EXCHANGE' ? 'Exchange' : 'Refund'} requested (${numbered.returnNumber}): ${REASONS[reason]}${byBuyer ? '' : ', raised by staff'}`, actor.id);
    return numbered;
  });
  return getReturn(created.returnNumber);
}

async function withdraw(user, returnNumber) {
  const r = await load(returnNumber);
  if (r.order.userId !== user.id) throw new AppError('Request not found', 404);
  if (!['REQUESTED', 'CHECKED'].includes(r.status)) throw new AppError('This request is already being handled and cannot be withdrawn', 409);
  const moved = await prisma.merchReturn.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'WITHDRAWN', completedAt: new Date() } });
  if (moved.count !== 1) throw new AppError('This request just changed. Reload and try again.', 409);
  await store.addEvent(prisma, r.orderId, r.order.status, `${r.returnNumber} withdrawn by the buyer`, user.id);
  return getReturn(returnNumber);
}

// --- staff steps -----------------------------------------------------------------------------

// Moves a request only if it is still where the step expects: two people
// pressing at once cannot both move it.
async function move(tx, r, from, data) {
  const moved = await tx.merchReturn.updateMany({ where: { id: r.id, status: { in: from } }, data });
  if (moved.count !== 1) throw new AppError('This request just changed. Reload and try again.', 409);
}

// Logistics: what came back, and what can be sold again (that goes back on the
// shelf now). A lost parcel: nothing came back, with a note.
async function check(returnNumber, body = {}, actorId) {
  const r = await load(returnNumber);
  if (r.kind !== 'REFUND' || r.status !== 'REQUESTED') throw new AppError('This request is not waiting for Logistics', 409);
  const note = text(body.note, 300);
  const counts = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [Number(i.id), i]));
  const rows = r.items.map((i) => {
    const c = counts.get(i.id) || {};
    const received = r.noItemBack ? 0 : Number(c.receivedQty ?? i.quantity);
    const resaleable = r.noItemBack ? 0 : Number(c.resaleableQty ?? 0);
    if (!Number.isInteger(received) || received < 0 || received > i.quantity) throw new AppError(`Received must be 0 to ${i.quantity} for ${i.orderItem.productName}`, 422);
    if (!Number.isInteger(resaleable) || resaleable < 0 || resaleable > received) throw new AppError(`Can be resold must be 0 to ${received} for ${i.orderItem.productName}`, 422);
    return { i, received, resaleable };
  });
  if (r.noItemBack && !note) throw new AppError('Add a note, e.g. what the courier said', 422);
  await prisma.$transaction(async (tx) => {
    await move(tx, r, ['REQUESTED'], { status: 'CHECKED', checkedById: actorId, checkedAt: new Date(), checkNote: note });
    for (const x of rows) {
      await tx.merchReturnItem.update({ where: { id: x.i.id }, data: { receivedQty: x.received, resaleableQty: x.resaleable } });
      if (x.resaleable > 0) {
        await tx.merchStockMovement.create({ data: { variantId: x.i.orderItem.variantId, type: 'RETURNED', quantity: x.resaleable, returnId: r.id, actorId, reason: `Returned, ${r.returnNumber}` } });
      }
    }
    await store.addEvent(tx, r.orderId, r.order.status, `${r.returnNumber}: Logistics checked${note ? `, ${note}` : ''}`, actorId);
  });
  return getReturn(returnNumber);
}

function pesos(value, max) {
  const raw = String(value == null ? '' : value).trim().replace(/^(₱|php)\s*/i, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new AppError('Enter the refund amount in pesos', 422);
  const c = Math.round(Number(raw) * 100);
  if (c <= 0 || c > max) throw new AppError(`The refund must be more than zero and at most ${(max / 100).toFixed(2)} (what was paid)`, 422);
  return c;
}

// Finance approves the amount. Above the approval limit a second, different
// person (the main admin or a President) approves too. Then PayMongo is asked
// for the refund.
async function approve(returnNumber, body = {}, actor) {
  const r = await load(returnNumber);
  if (r.kind !== 'REFUND' || !['CHECKED', 'NEEDS_SECOND'].includes(r.status)) throw new AppError('This request is not waiting for approval', 409);
  if (r.requestedById && r.requestedById === actor.id) throw new AppError('You raised this request, so someone else has to approve it', 403);
  const paid = r.order.payment ? r.order.payment.amount : 0;
  const { approvalLimitCentavos: limit } = await getSettings();

  if (r.status === 'NEEDS_SECOND') {
    if (actor.id === r.approvedById) throw new AppError('You gave the first approval; the second must come from someone else', 403);
    // actor.caps (from the admin routes) says who may give the second
    // approval; without it, the roles that can.
    const second = actor.caps ? actor.caps.has('refund.second') : ['ADMIN', 'PRESIDENT'].includes(actor.role);
    if (!second) throw new AppError('Above the approval limit, the main admin or the National President approves', 403);
    await prisma.$transaction((tx) => move(tx, r, ['NEEDS_SECOND'], { secondApprovedById: actor.id, secondApprovedAt: new Date() }));
    return sendRefund(returnNumber, actor.id);
  }

  const amount = pesos(body.amount ?? (r.suggestedCentavos / 100), paid);
  const needsSecond = limit !== null && amount > limit;
  await prisma.$transaction(async (tx) => {
    await move(tx, r, ['CHECKED'], { refundCentavos: amount, approvedById: actor.id, approvedAt: new Date(), status: needsSecond ? 'NEEDS_SECOND' : 'CHECKED' });
    await store.addEvent(tx, r.orderId, r.order.status, `${r.returnNumber}: refund of PHP ${(amount / 100).toFixed(2)} approved${needsSecond ? ', waiting for a second approval' : ''}`, actor.id);
  });
  if (needsSecond) return getReturn(returnNumber);
  return sendRefund(returnNumber, actor.id);
}

async function sendRefund(returnNumber, actorId) {
  const r = await load(returnNumber);
  // Claim it first, so a double press cannot ask PayMongo twice.
  await prisma.$transaction((tx) => move(tx, r, ['CHECKED', 'NEEDS_SECOND'], { status: 'REFUND_SENT' }));
  let refund;
  try {
    refund = await payments().requestRefund({
      paymentId: r.order.paymentId, adminUserId: actorId, amountCentavos: r.refundCentavos,
      reason: r.reason === 'DAMAGED' ? 'others' : 'requested_by_customer', notes: `${r.returnNumber}: ${REASONS[r.reason]}`,
    });
  } catch (err) {
    // PayMongo said no: back to where it was, to try again or reject.
    await prisma.merchReturn.update({ where: { id: r.id }, data: { status: r.status } });
    throw err;
  }
  await prisma.$transaction(async (tx) => {
    await tx.merchReturn.update({ where: { id: r.id }, data: { refundId: refund.id } });
    // A cancellation: the items never left, so they go back on the shelf, and
    // the order is cancelled so nobody packs it.
    if (r.reason === 'CANCELLED_BEFORE_PACKING') {
      for (const i of r.items) {
        await tx.merchStockMovement.create({ data: { variantId: i.orderItem.variantId, type: 'RETURNED', quantity: i.quantity, returnId: r.id, actorId, reason: `Not packed, back on the shelf, ${r.returnNumber}` } });
      }
      await tx.merchOrder.updateMany({ where: { id: r.orderId, status: 'PAID' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Cancelled by the buyer before packing' } });
    }
    await store.addEvent(tx, r.orderId, r.reason === 'CANCELLED_BEFORE_PACKING' ? 'CANCELLED' : r.order.status, `${r.returnNumber}: refund of PHP ${(r.refundCentavos / 100).toFixed(2)} sent to PayMongo`, actorId);
  });
  const done = await getReturn(returnNumber);
  notify(done, 'REFUND_SENT');
  return done;
}

async function reject(returnNumber, body = {}, actorId) {
  const r = await load(returnNumber);
  if (!['REQUESTED', 'CHECKED', 'NEEDS_SECOND', 'NEW_HELD'].includes(r.status)) throw new AppError('This request can no longer be rejected', 409);
  const why = text(body.reason, 300);
  if (!why) throw new AppError('Say why it is rejected; the buyer is told', 422);
  await prisma.$transaction(async (tx) => {
    await move(tx, r, [r.status], { status: 'REJECTED', rejectReason: why, completedAt: new Date() });
    if (r.status === 'NEW_HELD') await releaseExchangeHold(tx, r, 'Exchange rejected');
    await store.addEvent(tx, r.orderId, r.order.status, `${r.returnNumber} rejected: ${why}`, actorId);
  });
  const done = await getReturn(returnNumber);
  notify(done, 'REJECTED');
  return done;
}

// --- exchanges -------------------------------------------------------------------------------

async function releaseExchangeHold(tx, r, reason) {
  const held = await tx.merchStockMovement.groupBy({ by: ['variantId'], where: { returnId: r.id, type: { in: ['HELD', 'RELEASED'] } }, _sum: { quantity: true } });
  for (const h of held) {
    const open = -(h._sum.quantity || 0);
    if (open > 0) await tx.merchStockMovement.create({ data: { variantId: h.variantId, type: 'RELEASED', quantity: open, returnId: r.id, reason: `${reason}, ${r.returnNumber}` } });
  }
}

// Logistics accepts: the new sizes are held for this buyer.
async function acceptExchange(returnNumber, actorId) {
  const r = await load(returnNumber);
  if (r.kind !== 'EXCHANGE' || r.status !== 'REQUESTED') throw new AppError('This exchange is not waiting to be accepted', 409);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => { // eslint-disable-line no-await-in-loop
        const stock = await store.availableFor(r.items.map((i) => i.newVariantId), tx);
        for (const i of r.items) {
          if ((stock.get(i.newVariantId) || 0) < i.quantity) throw new AppError(`${i.newVariant.label} is out of stock, so this exchange cannot go ahead now`, 409);
        }
        await move(tx, r, ['REQUESTED'], { status: 'NEW_HELD', checkedById: actorId, checkedAt: new Date() });
        for (const i of r.items) {
          await tx.merchStockMovement.create({ data: { variantId: i.newVariantId, type: 'HELD', quantity: -i.quantity, returnId: r.id, actorId, reason: `Held for exchange ${r.returnNumber}` } });
        }
        await store.addEvent(tx, r.orderId, r.order.status, `${r.returnNumber}: exchange accepted, new item held`, actorId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (err) {
      if (err.code === 'P2034' && attempt < 3) continue; // eslint-disable-line no-continue
      throw err;
    }
  }
  return getReturn(returnNumber);
}

async function receiveOld(returnNumber, body = {}, actorId) {
  const r = await load(returnNumber);
  if (r.kind !== 'EXCHANGE' || r.status !== 'NEW_HELD') throw new AppError('This exchange is not waiting for the old item', 409);
  const counts = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [Number(i.id), i]));
  await prisma.$transaction(async (tx) => {
    await move(tx, r, ['NEW_HELD'], { status: 'OLD_RECEIVED', checkNote: text(body.note, 300) });
    for (const i of r.items) {
      const c = counts.get(i.id) || {};
      const resaleable = Number(c.resaleableQty ?? i.quantity);
      if (!Number.isInteger(resaleable) || resaleable < 0 || resaleable > i.quantity) throw new AppError(`Can be resold must be 0 to ${i.quantity}`, 422);
      await tx.merchReturnItem.update({ where: { id: i.id }, data: { receivedQty: i.quantity, resaleableQty: resaleable } });
      if (resaleable > 0) await tx.merchStockMovement.create({ data: { variantId: i.orderItem.variantId, type: 'RETURNED', quantity: resaleable, returnId: r.id, actorId, reason: `Returned in exchange, ${r.returnNumber}` } });
    }
    await store.addEvent(tx, r.orderId, r.order.status, `${r.returnNumber}: old item received`, actorId);
  });
  return getReturn(returnNumber);
}

// The new item goes out: by courier (tracking) for a delivery order, or handed
// over at pickup. The hold becomes a sale.
async function sendNew(returnNumber, body = {}, actorId) {
  const r = await load(returnNumber);
  if (r.kind !== 'EXCHANGE' || r.status !== 'OLD_RECEIVED') throw new AppError('This exchange is not ready to send the new item', 409);
  const courier = text(body.courier, 80);
  const trackingNumber = text(body.trackingNumber, 80);
  if (r.order.fulfilment === 'DELIVERY' && (!courier || !trackingNumber)) throw new AppError('Enter the courier and tracking number for the new item', 422);
  await prisma.$transaction(async (tx) => {
    await move(tx, r, ['OLD_RECEIVED'], { status: 'COMPLETED', completedAt: new Date(), courier, trackingNumber });
    for (const i of r.items) {
      await tx.merchStockMovement.create({ data: { variantId: i.newVariantId, type: 'SOLD', quantity: -i.quantity, returnId: r.id, actorId, reason: `Exchange sent, ${r.returnNumber}` } });
    }
    await releaseExchangeHold(tx, r, 'Hold turned into the exchange');
    await store.addEvent(tx, r.orderId, r.order.status, `${r.returnNumber}: new item ${courier ? `shipped, ${courier} ${trackingNumber}` : 'handed over'}`, actorId);
  });
  const done = await getReturn(returnNumber);
  notify(done, 'EXCHANGE_SENT');
  return done;
}

function notify(ret, kind) {
  prisma.merchOrder.findUnique({ where: { orderNumber: ret.orderNumber }, select: { buyerName: true, buyerEmail: true, orderNumber: true } })
    .then((order) => order && mail().sendMerchReturnEmail(order, ret, kind))
    .catch((err) => console.error('Merchandise return email failed:', ret.returnNumber, err.message));
}

// --- the staff list --------------------------------------------------------------------------

const GROUPS = {
  logistics: { label: 'Waiting for Logistics', where: { status: { in: ['REQUESTED', 'NEW_HELD'] } } },
  approval: { label: 'Waiting for approval', where: { status: 'CHECKED' } },
  second: { label: 'Second approval', where: { status: 'NEEDS_SECOND' } },
  exchange: { label: 'Exchange to send', where: { status: 'OLD_RECEIVED' } },
  sent: { label: 'Refund sent', where: { status: 'REFUND_SENT' } },
  failed: { label: 'Refund failed', where: { status: 'REFUND_FAILED' } },
  closed: { label: 'Closed', where: { status: { in: ['COMPLETED', 'REJECTED', 'WITHDRAWN'] } } },
};

async function listReturns(query = {}) {
  const group = GROUPS[query.group] ? query.group : null;
  const where = group ? GROUPS[group].where : { status: { notIn: ['COMPLETED', 'REJECTED', 'WITHDRAWN'] } };
  const [rows, counts] = await Promise.all([
    prisma.merchReturn.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200, include: INCLUDE }),
    Promise.all(Object.entries(GROUPS).map(async ([k, g]) => [k, await prisma.merchReturn.count({ where: g.where })])),
  ]);
  return { group, groups: GROUPS, counts: Object.fromEntries(counts), returns: await Promise.all(rows.map(present)) };
}

// What the buyer can ask for on this order, and for an exchange the sizes
// each line can be swapped for: same product, on sale, same price as paid, in
// stock.
async function requestForm(user, orderNumber) {
  const order = await prisma.merchOrder.findUnique({ where: { orderNumber: String(orderNumber || '') }, include: { items: { orderBy: { id: 'asc' } } } });
  if (!order || order.userId !== user.id) throw new AppError('Order not found', 404);
  const can = await options(order);
  const left = await remainingQuantities(order);
  const variants = await prisma.merchVariant.findMany({
    where: { isActive: true, productId: { in: (await prisma.merchVariant.findMany({ where: { id: { in: order.items.map((i) => i.variantId) } }, select: { productId: true } })).map((v) => v.productId) } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const stock = await store.availableFor(variants.map((v) => v.id));
  const items = order.items.map((i) => {
    const original = variants.find((v) => v.id === i.variantId);
    const productId = original ? original.productId : null;
    const swaps = variants.filter((v) => v.productId === productId && v.id !== i.variantId
      && (i.priceType === 'MEMBER' ? v.memberPriceCentavos : v.priceCentavos) === i.unitPriceCentavos
      && (stock.get(v.id) || 0) > 0).map((v) => ({ id: v.id, label: v.label }));
    return { id: i.id, productName: i.productName, label: i.variantLabel, quantity: left.get(i.id) || 0, unitPrice: i.unitPriceCentavos, swaps };
  }).filter((i) => i.quantity > 0);
  return { options: can, items, reasons: REASONS };
}

// Packing is refused while the buyer has asked to cancel.
async function openCancellation(orderId) {
  return prisma.merchReturn.findFirst({ where: { orderId, reason: 'CANCELLED_BEFORE_PACKING', status: { notIn: CLOSED } }, select: { returnNumber: true } });
}

module.exports = {
  REASONS,
  STATUS_LABELS,
  getSettings,
  setSettings,
  options,
  requestForm,
  createRequest,
  withdraw,
  check,
  approve,
  reject,
  acceptExchange,
  receiveOld,
  sendNew,
  getReturn,
  listForOrder,
  listReturns,
  openCancellation,
  remainingQuantities,
};
