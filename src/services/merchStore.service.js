const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const settingsService = require('./settings.service');
const membershipService = require('./membership.service');
const merch = require('./merch.service');

// Merchandise store, phase 2: the Store page, cart, checkout through PayMongo
// and the 30-minute stock hold (JPSME Merchandise Store Plan v2).
//
//   Store      Off by default (setting merchStoreOpen). While off, only the
//              main admin and a President with Merchandise can see it (to
//              try it on dev); members see nothing.
//   Price      An active membership pays the member price, everyone else the
//              non-member price, decided on the server at every step. A
//              variant whose price is not set yet (TBD) cannot be bought.
//   Cart       Kept on the account. It never stores prices.
//   Checkout   In one serializable transaction: check every line (on sale,
//              price set, in stock, under the limit per buyer), create the
//              order, write a HELD movement per line (stock reserved for 30
//              minutes), empty the cart. Then open PayMongo through the same
//              createCheckout as membership and event fees.
//   One unpaid order at a time: a buyer with an order awaiting payment is sent
//              back to it rather than making a second one.
//   Paid       Only PayMongo's signed notice (or the reconciliation check)
//              marks an order PAID: the hold becomes a SALE (SOLD + RELEASED).
//   Expiry     A job each minute finds orders past their hold, expires the
//              PayMongo link first (so it cannot be paid afterwards), then
//              cancels the order and gives the stock back.
//   Late pay   If money still arrives after the hold was given back: the order
//              goes through if the stock is still there; if not, it is
//              cancelled as "Sold out at payment" and refunded automatically.
//
// Stock:  on hand  = RECEIVED, DAMAGED, COUNT_CORRECTION, SOLD, RETURNED
//         held     = HELD (negative) + RELEASED (positive) of open holds
//         available = on hand + held   (what can still be sold)

const HOLD_MINUTES = 30;
const SETTING_OPEN = 'merchStoreOpen';
const CLOSED_STATUSES = ['CANCELLED', 'REFUNDED'];
const STATUS_LABELS = {
  AWAITING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  READY_FOR_PICKUP: 'Ready for pickup',
  PICKED_UP: 'Picked up',
  ADDRESS_HOLD: 'Address needs fixing',
  UNCLAIMED: 'Not collected',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

const fulfilment = () => require('./merchFulfilment.service'); // eslint-disable-line global-require

// One line on an order's timeline (status changes, with who and why).
function addEvent(db, orderId, status, note = null, actorId = null) {
  return db.merchOrderEvent.create({ data: { orderId, status, note: note ? String(note).slice(0, 300) : null, actorId } });
}

const paymentService = () => require('./payment.service'); // eslint-disable-line global-require
const paymongo = () => require('./paymongo.service'); // eslint-disable-line global-require

// --- store open / who may see it -----------------------------------------------------

async function isStoreOpen() {
  return (await settingsService.getSetting(SETTING_OPEN, 'false')) === 'true';
}

async function setStoreOpen(open) {
  await settingsService.setSetting(SETTING_OPEN, open ? 'true' : 'false');
  return Boolean(open);
}

// The main admin, a President given Merchandise, or a Finance & Logistics
// account with a task group: may see the store while it is closed, to try it.
async function canPreview(user) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (!['PRESIDENT', 'FINANCE_LOGISTICS'].includes(user.role)) return false;
  // eslint-disable-next-line global-require
  return (await require('./adminAccess.service').merchCapsFor(user)).has('catalog.view');
}

// Who sees the Store: everyone when it is open; while not, its own staff
// (canPreview) and, in the soft launch, the testers (the National Board), who
// buy for real. soft: the Store is in soft launch (phase 5, merchLaunch).
async function storeAccess(user) {
  // eslint-disable-next-line global-require
  const launch = require('./merchLaunch.service');
  const mode = await launch.getMode();
  const open = mode === 'OPEN';
  const soft = mode === 'SOFT';
  let preview = false;
  let tester = false;
  if (!open && user) {
    preview = await canPreview(user);
    tester = soft && await launch.isTester(user.id);
  }
  return { open, soft, tester, preview: preview || tester, visible: open || preview || tester };
}

async function assertVisible(user) {
  const access = await storeAccess(user);
  if (!access.visible) throw new AppError('The store is not open yet', 404);
  return access;
}

// --- stock and prices ------------------------------------------------------------------

async function availableFor(variantIds, db = prisma) {
  const ids = [...new Set(variantIds.map(Number))].filter(Boolean);
  const onHand = await merch.onHandFor(ids, db);
  if (!ids.length) return onHand;
  const holds = await db.merchStockMovement.groupBy({
    by: ['variantId'], where: { variantId: { in: ids }, type: { in: ['HELD', 'RELEASED'] } }, _sum: { quantity: true },
  });
  const held = new Map(holds.map((h) => [h.variantId, h._sum.quantity || 0]));
  return new Map(ids.map((id) => [id, (onHand.get(id) || 0) + (held.get(id) || 0)]));
}

const isMember = async (user) => Boolean(user && await membershipService.isActiveMember(user.id));

// The price this buyer pays, or null when it is not set yet.
function priceFor(variant, member) {
  if (member) return variant.memberPriceCentavos === null ? null : { cents: variant.memberPriceCentavos, type: 'MEMBER' };
  return variant.priceCentavos === null ? null : { cents: variant.priceCentavos, type: 'REGULAR' };
}

// How many of a variant this buyer has in orders that still count.
async function alreadyBought(userId, variantId, db = prisma) {
  const r = await db.merchOrderItem.aggregate({
    where: { variantId: Number(variantId), order: { userId: Number(userId), status: { notIn: CLOSED_STATUSES } } },
    _sum: { quantity: true },
  });
  return r._sum.quantity || 0;
}

// --- the Store pages ---------------------------------------------------------------------

function presentStoreVariant(v, member, available) {
  const price = priceFor(v, member);
  return {
    id: v.id, label: v.label, size: v.size, color: v.color, sku: v.sku,
    memberPriceCentavos: v.memberPriceCentavos, priceCentavos: v.priceCentavos,
    yourPrice: price ? price.cents : null, priceType: price ? price.type : null,
    available: Math.max(available, 0), limitPerBuyer: v.limitPerBuyer,
    fewLeft: available > 0 && v.lowStockLevel !== null && available <= v.lowStockLevel,
    buyable: Boolean(price) && available > 0,
  };
}

async function listStoreProducts(user) {
  await assertVisible(user);
  const member = await isMember(user);
  const products = await prisma.merchProduct.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 1 }, variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  const stock = await availableFor(products.flatMap((p) => p.variants.map((v) => v.id)));
  return {
    member,
    products: products.filter((p) => p.variants.length).map((p) => {
      const variants = p.variants.map((v) => presentStoreVariant(v, member, stock.get(v.id) || 0));
      const prices = variants.map((v) => v.yourPrice).filter((c) => c !== null);
      return {
        id: p.id, name: p.name, photo: p.images[0] ? p.images[0].url : null,
        fromPrice: prices.length ? Math.min(...prices) : null,
        soldOut: variants.every((v) => v.available <= 0),
        variantCount: variants.length,
      };
    }),
  };
}

async function getStoreProduct(user, productId) {
  await assertVisible(user);
  const member = await isMember(user);
  const p = await prisma.merchProduct.findFirst({
    where: { id: Number(productId) || 0, isActive: true },
    include: { images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }, variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  if (!p || !p.variants.length) throw new AppError('Product not found', 404);
  const stock = await availableFor(p.variants.map((v) => v.id));
  return {
    member,
    product: {
      id: p.id, name: p.name, description: p.description,
      images: p.images.map((i) => i.url),
      variants: p.variants.map((v) => presentStoreVariant(v, member, stock.get(v.id) || 0)),
    },
  };
}

// --- cart ----------------------------------------------------------------------------------

function assertBuyer(user) {
  if (!user) throw new AppError('Sign in to shop', 401);
  if (user.role === 'ADMIN') throw new AppError('The main admin account cannot buy. Use a member account.', 403);
}

async function loadVariant(variantId, db = prisma) {
  const v = await db.merchVariant.findUnique({ where: { id: Number(variantId) || 0 }, include: { product: { select: { id: true, name: true, isActive: true } } } });
  if (!v || !v.isActive || !v.product.isActive) throw new AppError('That item is not on sale', 404);
  return v;
}

const quantity = (q, max = 100) => {
  const n = Number(q);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new AppError(`Quantity must be a whole number up to ${max}`, 422);
  return n;
};

// Checks a quantity of one variant for this buyer: price set, in stock, under
// their limit. Returns the price, or throws the reason.
async function checkLine(user, v, qty, member, db = prisma, available = null) {
  const price = priceFor(v, member);
  if (!price) throw new AppError(`${v.product.name} (${v.label}) is not priced yet`, 422);
  const left = available === null ? ((await availableFor([v.id], db)).get(v.id) || 0) : available;
  if (qty > left) throw new AppError(left > 0 ? `Only ${left} left of ${v.product.name} (${v.label})` : `${v.product.name} (${v.label}) is sold out`, 409);
  if (v.limitPerBuyer) {
    const had = await alreadyBought(user.id, v.id, db);
    if (had + qty > v.limitPerBuyer) {
      throw new AppError(`Limit ${v.limitPerBuyer} per member for ${v.product.name} (${v.label})${had ? `; you already ordered ${had}` : ''}`, 422);
    }
  }
  return price;
}

async function setCartQuantity(user, variantId, qtyRaw, { add = false } = {}) {
  assertBuyer(user);
  await assertVisible(user);
  const v = await loadVariant(variantId);
  const existing = await prisma.merchCartItem.findUnique({ where: { userId_variantId: { userId: user.id, variantId: v.id } } });
  const qty = add ? (existing ? existing.quantity : 0) + quantity(qtyRaw) : quantity(qtyRaw);
  if (qty === 0) {
    if (existing) await prisma.merchCartItem.delete({ where: { id: existing.id } });
    return getCart(user);
  }
  await checkLine(user, v, qty, await isMember(user));
  await prisma.merchCartItem.upsert({
    where: { userId_variantId: { userId: user.id, variantId: v.id } },
    create: { userId: user.id, variantId: v.id, quantity: qty },
    update: { quantity: qty },
  });
  return getCart(user);
}

async function removeFromCart(user, variantId) {
  assertBuyer(user);
  await prisma.merchCartItem.deleteMany({ where: { userId: user.id, variantId: Number(variantId) || 0 } });
  return getCart(user);
}

// The cart at today's prices for this buyer, each line with any problem that
// would stop checkout.
async function getCart(user) {
  assertBuyer(user);
  const member = await isMember(user);
  const lines = await prisma.merchCartItem.findMany({
    where: { userId: user.id },
    orderBy: { id: 'asc' },
    include: { variant: { include: { product: { select: { id: true, name: true, isActive: true, images: { take: 1, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } } } } },
  });
  const stock = await availableFor(lines.map((l) => l.variantId));
  const items = [];
  for (const l of lines) {
    const v = l.variant;
    const price = priceFor(v, member);
    const available = Math.max(stock.get(v.id) || 0, 0);
    let problem = null;
    if (!v.isActive || !v.product.isActive) problem = 'No longer on sale';
    else if (!price) problem = 'Not priced yet';
    else if (available <= 0) problem = 'Sold out';
    else if (l.quantity > available) problem = `Only ${available} left`;
    else if (v.limitPerBuyer && (await alreadyBought(user.id, v.id)) + l.quantity > v.limitPerBuyer) problem = `Over the limit of ${v.limitPerBuyer} per member`;
    items.push({
      variantId: v.id, productId: v.product.id, productName: v.product.name, label: v.label, sku: v.sku,
      photo: v.product.images[0] ? v.product.images[0].url : null,
      quantity: l.quantity, unitPrice: price ? price.cents : null, priceType: price ? price.type : null,
      lineTotal: price ? price.cents * l.quantity : null, available, problem,
    });
  }
  const subtotal = items.reduce((t, i) => t + (i.lineTotal || 0), 0);
  const channelFee = subtotal > 0 ? await paymentService().calculateGatewaySurcharge(subtotal) : 0;
  return { member, items, subtotal, channelFee, total: subtotal + channelFee, ready: items.length > 0 && items.every((i) => !i.problem) };
}

// What the checkout step offers: saved addresses, open pickup points, the
// zones that deliver, and whether either way is possible at all.
async function checkoutOptions(user) {
  assertBuyer(user);
  const f = fulfilment();
  const [addresses, pickupPoints, zones] = await Promise.all([
    f.listAddresses(user.id), f.listPickupPoints({ openOnly: true }), f.listZones(),
  ]);
  const deliveryOffered = zones.some((z) => z.offered);
  return { addresses, pickupPoints, zones: zones.filter((z) => z.offered), deliveryOffered, pickupOffered: pickupPoints.length > 0 };
}

// The total for a cart with a delivery fee: PayMongo's fee is worked out on
// items + delivery, as PayMongo charges it.
async function quoteTotal(subtotal, deliveryFee) {
  const base = subtotal + deliveryFee;
  const channelFee = base > 0 ? await paymentService().calculateGatewaySurcharge(base) : 0;
  return { subtotal, deliveryFee, channelFee, total: base + channelFee };
}

// Delivery or pickup, checked before any stock is held. Returns what is
// copied onto the order.
async function resolveFulfilment(user, body = {}) {
  const f = fulfilment();
  const way = String(body.fulfilment || '').toUpperCase();
  if (way === 'DELIVERY') {
    if (!(body.confirmAddress === true || body.confirmAddress === 'true')) {
      throw new AppError('Tick "This address is complete and correct" to continue', 422);
    }
    const address = body.addressId ? await f.savedAddressForCheckout(user.id, body.addressId) : await f.validateAddress(body.address || {});
    const quote = await f.deliveryQuote(address.regionCode);
    if (!quote.available) throw new AppError(quote.reason, 422);
    return {
      fulfilment: 'DELIVERY', deliveryFeeCentavos: quote.feeCentavos, zoneName: quote.zoneName,
      shipTo: JSON.stringify({ ...address, lines: f.labelLines(address) }), shipRegionCode: address.regionCode,
      saveAddress: !body.addressId && (body.saveAddress === true || body.saveAddress === 'true') ? address : null,
    };
  }
  if (way === 'PICKUP') {
    const point = await f.openPickupPoint(body.pickupPointId);
    return { fulfilment: 'PICKUP', deliveryFeeCentavos: 0, pickupPointId: point.id, pickupPoint: JSON.stringify(point) };
  }
  throw new AppError('Choose delivery or pickup', 422);
}

// --- checkout ----------------------------------------------------------------------------

const orderNumberFor = (order) => `ORD-${new Date(order.createdAt).getFullYear()}-${String(order.id).padStart(6, '0')}`;

async function findOpenOrder(userId) {
  return prisma.merchOrder.findFirst({ where: { userId: Number(userId), status: 'AWAITING_PAYMENT' }, orderBy: { id: 'desc' } });
}

async function checkout(user, body = {}) {
  assertBuyer(user);
  await assertVisible(user);
  if (!(await settingsService.getPaymentsEnabled())) throw new AppError('Orders are closed for now. Please try again later.', 503);
  const open = await findOpenOrder(user.id);
  if (open) {
    const err = new AppError(`You have an unpaid order (${open.orderNumber}). Pay or cancel it first.`, 409);
    err.data = { orderNumber: open.orderNumber };
    throw err;
  }
  const way = await resolveFulfilment(user, body);
  const buyer = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, firstName: true, lastName: true, email: true, organizationId: true } });
  const member = await isMember(user);

  let order;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      order = await prisma.$transaction(async (tx) => {
        const lines = await tx.merchCartItem.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
        if (!lines.length) throw new AppError('Your cart is empty', 422);
        const stock = await availableFor(lines.map((l) => l.variantId), tx);
        const priced = [];
        for (const l of lines) {
          const v = await loadVariant(l.variantId, tx);
          const price = await checkLine(user, v, l.quantity, member, tx, stock.get(v.id) || 0);
          priced.push({ v, qty: l.quantity, price });
        }
        const subtotal = priced.reduce((t, x) => t + x.price.cents * x.qty, 0);
        const totals = await quoteTotal(subtotal, way.deliveryFeeCentavos);
        const created = await tx.merchOrder.create({
          data: {
            userId: buyer.id,
            buyerName: `${buyer.firstName} ${buyer.lastName}`.trim(),
            buyerEmail: buyer.email,
            organizationId: buyer.organizationId,
            memberPricing: member,
            status: 'AWAITING_PAYMENT',
            subtotalCentavos: subtotal,
            deliveryFeeCentavos: totals.deliveryFee,
            channelFeeCentavos: totals.channelFee,
            totalCentavos: totals.total,
            holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * 60 * 1000),
            fulfilment: way.fulfilment,
            zoneName: way.zoneName || null,
            shipTo: way.shipTo || null,
            shipRegionCode: way.shipRegionCode || null,
            pickupPointId: way.pickupPointId || null,
            pickupPoint: way.pickupPoint || null,
            // The pickup QR: random, shown to the buyer, scanned at handover.
            qrToken: way.fulfilment === 'PICKUP' ? crypto.randomBytes(16).toString('hex') : null,
          },
        });
        await addEvent(tx, created.id, 'AWAITING_PAYMENT', way.fulfilment === 'PICKUP' ? 'Order placed, for pickup' : `Order placed, for delivery (${way.zoneName})`, buyer.id);
        const numbered = await tx.merchOrder.update({ where: { id: created.id }, data: { orderNumber: orderNumberFor(created) } });
        for (const x of priced) {
          await tx.merchOrderItem.create({
            data: {
              orderId: created.id, variantId: x.v.id, productName: x.v.product.name, variantLabel: x.v.label, sku: x.v.sku,
              priceType: x.price.type, unitPriceCentavos: x.price.cents, unitCostCentavos: x.v.costCentavos, quantity: x.qty,
            },
          });
          await tx.merchStockMovement.create({ data: { variantId: x.v.id, type: 'HELD', quantity: -x.qty, orderId: created.id, reason: `Held for ${numbered.orderNumber}` } });
        }
        await tx.merchCartItem.deleteMany({ where: { userId: user.id } });
        return numbered;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (err) {
      if (err.code === 'P2034' && attempt < 3) continue; // eslint-disable-line no-continue
      if (err.code === 'P2034') throw new AppError('The store is busy. Please try again.', 409);
      throw err;
    }
  }

  // "Save this address": kept for next time; a failure here never blocks paying.
  if (way.saveAddress) {
    await fulfilment().saveAddress(user.id, way.saveAddress).catch((err) => console.error('Saving checkout address failed:', err.message));
  }

  try {
    const { checkoutUrl } = await openPayment(order);
    return { order, checkoutUrl };
  } catch (err) {
    // No payment page: give the stock straight back and say why.
    await closeOrder(order.id, { reason: 'Could not open the payment page', paymentStatus: 'CANCELLED', expireAtPayMongo: false });
    throw err;
  }
}

// Opens (or reopens) PayMongo for an order awaiting payment. createCheckout
// keeps one active payment per buyer and reuses it, which is why a buyer has
// one unpaid order at a time.
async function openPayment(order) {
  const ps = paymentService();
  return ps.createMerchCheckout(order, (tx, paymentRow) => tx.merchOrder.update({ where: { id: order.id }, data: { paymentId: paymentRow.id } }));
}

async function ownOrder(user, orderNumber) {
  const order = await prisma.merchOrder.findUnique({
    where: { orderNumber: String(orderNumber || '') },
    include: { items: { orderBy: { id: 'asc' } }, payment: { select: { status: true, gatewayPaymentId: true } }, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { actor: { select: { firstName: true, lastName: true } } } } },
  });
  if (!order || order.userId !== user.id) throw new AppError('Order not found', 404);
  return order;
}

async function payOrder(user, orderNumber) {
  assertBuyer(user);
  const order = await ownOrder(user, orderNumber);
  if (order.status !== 'AWAITING_PAYMENT') throw new AppError('This order is not waiting for payment', 409);
  if (new Date(order.holdExpiresAt).getTime() < Date.now() + 60 * 1000) {
    throw new AppError('The time to pay this order has run out. Its items are going back on sale.', 409);
  }
  if (!(await settingsService.getPaymentsEnabled())) throw new AppError('Orders are closed for now. Please try again later.', 503);
  return { order, ...(await openPayment(order)) };
}

async function cancelOrder(user, orderNumber) {
  assertBuyer(user);
  const order = await ownOrder(user, orderNumber);
  if (order.status !== 'AWAITING_PAYMENT') throw new AppError('Only an unpaid order can be cancelled here', 409);
  const result = await closeOrder(order.id, { reason: 'Cancelled by the buyer', paymentStatus: 'CANCELLED' });
  if (result.paidInstead) throw new AppError('This order was just paid, so it was not cancelled.', 409);
  return ownOrder(user, orderNumber);
}

// Cancels an order still awaiting payment and gives its stock back. PayMongo's
// link is expired FIRST, so it cannot be paid after the stock is released; if
// PayMongo says it was paid already, the payment is confirmed instead (through
// the same reconciliation used everywhere) and nothing is released.
async function closeOrder(orderId, { reason, paymentStatus = 'EXPIRED', expireAtPayMongo = true }) {
  const order = await prisma.merchOrder.findUnique({ where: { id: orderId }, include: { payment: true } });
  if (!order || order.status !== 'AWAITING_PAYMENT') return { skipped: true };
  const payment = order.payment;
  if (expireAtPayMongo && payment && payment.gatewayCheckoutId && ['PENDING', 'PROCESSING', 'FAILED'].includes(payment.status)) {
    try {
      await paymongo().expireCheckoutSession(payment.gatewayCheckoutId);
    } catch (err) {
      // Already paid or expired at PayMongo, or PayMongo unreachable: ask it.
      let session = null;
      try { session = await paymongo().getCheckoutSession(payment.gatewayCheckoutId); } catch (e) { session = null; }
      const paid = session && (session.attributes?.payments || []).some((p) => p?.attributes?.status === 'paid');
      if (paid) {
        await paymentService().reconcilePayment(payment.id, { triggeredBy: 'merch_hold' });
        return { paidInstead: true };
      }
      if (!session) return { retryLater: true }; // cannot be sure the link is dead: keep the hold
    }
  }
  return prisma.$transaction(async (tx) => {
    // Conditional: if the payment landed meanwhile, the order is PAID and this
    // changes nothing.
    const flipped = await tx.merchOrder.updateMany({
      where: { id: orderId, status: 'AWAITING_PAYMENT' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    if (flipped.count !== 1) return { skipped: true };
    await releaseHolds(tx, orderId, reason);
    await addEvent(tx, orderId, 'CANCELLED', reason);
    if (payment && ['PENDING', 'PROCESSING', 'FAILED'].includes(payment.status)) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: paymentStatus } });
    }
    return { cancelled: true };
  });
}

// Gives back whatever this order still holds.
async function releaseHolds(tx, orderId, reason) {
  const held = await tx.merchStockMovement.groupBy({
    by: ['variantId'], where: { orderId, type: { in: ['HELD', 'RELEASED'] } }, _sum: { quantity: true },
  });
  for (const h of held) {
    const open = -(h._sum.quantity || 0);
    if (open > 0) await tx.merchStockMovement.create({ data: { variantId: h.variantId, type: 'RELEASED', quantity: open, orderId, reason } });
  }
}

// The minute job: every order whose hold ran out.
async function sweepExpiredHolds(now = new Date()) {
  const due = await prisma.merchOrder.findMany({
    where: { status: 'AWAITING_PAYMENT', holdExpiresAt: { lt: now } },
    select: { id: true },
    take: 50,
  });
  const outcome = { cancelled: 0, paidInstead: 0, waiting: 0 };
  for (const o of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await closeOrder(o.id, { reason: 'Payment time ran out', paymentStatus: 'EXPIRED' });
      if (r.cancelled) outcome.cancelled += 1;
      else if (r.paidInstead) outcome.paidInstead += 1;
      else if (r.retryLater) outcome.waiting += 1;
    } catch (err) {
      console.error('Merchandise hold sweep: order', o.id, err.message);
    }
  }
  return outcome;
}

// --- payment confirmed (called inside applyPaymentPaid's transaction) ---------------------

// Turns the hold into a sale. If the hold had already been given back (late
// payment), the order goes through only if the stock is still there;
// otherwise it stays cancelled as "Sold out at payment" and the caller
// refunds it.
async function onPaymentPaid(tx, payment) {
  const order = await tx.merchOrder.findUnique({ where: { paymentId: payment.id }, include: { items: true } });
  if (!order) return { anomaly: 'no merchandise order for this payment' };
  const now = new Date();
  const flipped = await tx.merchOrder.updateMany({ where: { id: order.id, status: 'AWAITING_PAYMENT' }, data: { status: 'PAID', paidAt: now } });
  if (flipped.count === 1) {
    for (const i of order.items) {
      await tx.merchStockMovement.create({ data: { variantId: i.variantId, type: 'SOLD', quantity: -i.quantity, orderId: order.id, reason: `Sold, ${order.orderNumber}` } });
    }
    await releaseHolds(tx, order.id, `Hold turned into a sale, ${order.orderNumber}`);
    await addEvent(tx, order.id, 'PAID', 'Paid through PayMongo');
    return { paid: true, orderId: order.id };
  }
  if (order.status !== 'CANCELLED') return { already: order.status, orderId: order.id };

  // Late: the hold was given back. Is the stock still there?
  const stock = await availableFor(order.items.map((i) => i.variantId), tx);
  const need = new Map();
  order.items.forEach((i) => need.set(i.variantId, (need.get(i.variantId) || 0) + i.quantity));
  const enough = [...need].every(([id, q]) => (stock.get(id) || 0) >= q);
  if (enough) {
    await tx.merchOrder.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: now, cancelledAt: null, cancelReason: null } });
    for (const i of order.items) {
      await tx.merchStockMovement.create({ data: { variantId: i.variantId, type: 'SOLD', quantity: -i.quantity, orderId: order.id, reason: `Sold after a late payment, ${order.orderNumber}` } });
    }
    await addEvent(tx, order.id, 'PAID', 'Paid after the time to pay ran out; the items were still in stock');
    return { paid: true, late: true, orderId: order.id };
  }
  await tx.merchOrder.update({ where: { id: order.id }, data: { cancelReason: 'Sold out at payment' } });
  await addEvent(tx, order.id, 'CANCELLED', 'Paid after the time ran out, but sold out by then: refunding in full');
  return { autoRefund: true, orderId: order.id };
}

// A refund for a merchandise payment succeeded: a paid order becomes REFUNDED.
// Returned items are put back on the shelf by Logistics, not here.
async function onRefundSucceeded(tx, payment, refund = null) {
  const order = await tx.merchOrder.findUnique({ where: { paymentId: payment.id }, select: { id: true, status: true } });
  if (!order) return;
  const full = !refund || refund.amount >= payment.amount;
  const peso = (c) => `PHP ${(c / 100).toFixed(2)}`;
  // A full refund: any paid state becomes Refunded (a cancelled "sold out at
  // payment" order stays cancelled, its refund noted). A partial one (some
  // items) leaves the order where it is.
  if (full && !['AWAITING_PAYMENT', 'CANCELLED', 'REFUNDED'].includes(order.status)) {
    await tx.merchOrder.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
  }
  await addEvent(tx, order.id, full ? (order.status === 'CANCELLED' ? 'CANCELLED' : 'REFUNDED') : order.status,
    full ? 'Refund completed by PayMongo' : `Part refunded by PayMongo: ${peso(refund.amount)}`);
  // The request that asked for it is done.
  if (refund) {
    await tx.merchReturn.updateMany({ where: { refundId: refund.id, status: 'REFUND_SENT' }, data: { status: 'COMPLETED', completedAt: new Date() } });
  }
}

// PayMongo could not make the refund: the request says so, for Finance to
// take up with PayMongo (one refund per payment, so it cannot simply be sent
// again from here).
async function onRefundFailed(tx, payment, refund) {
  const order = await tx.merchOrder.findUnique({ where: { paymentId: payment.id }, select: { id: true, status: true } });
  if (!order) return;
  await tx.merchReturn.updateMany({ where: { refundId: refund.id, status: 'REFUND_SENT' }, data: { status: 'REFUND_FAILED' } });
  await addEvent(tx, order.id, order.status, 'PayMongo could not complete the refund: contact PayMongo support');
}

// --- My Orders -------------------------------------------------------------------------------

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

function presentOrder(o) {
  const shipTo = parseJson(o.shipTo);
  return {
    id: o.id,
    orderNumber: o.orderNumber, status: o.status, statusLabel: STATUS_LABELS[o.status] || o.status,
    fulfilment: o.fulfilment, zoneName: o.zoneName,
    shipTo, shipLines: shipTo ? shipTo.lines : null,
    pickupPoint: parseJson(o.pickupPoint),
    courier: o.courier, trackingNumber: o.trackingNumber, qrToken: o.qrToken,
    addressNote: o.addressNote, holdFromStatus: o.holdFromStatus,
    packedAt: o.packedAt, shippedAt: o.shippedAt, deliveredAt: o.deliveredAt, readyAt: o.readyAt, pickedUpAt: o.pickedUpAt,
    buyerName: o.buyerName, buyerEmail: o.buyerEmail,
    events: (o.events || []).map((e) => ({ status: e.status, label: STATUS_LABELS[e.status] || e.status, note: e.note, at: e.createdAt, by: e.actor ? `${e.actor.firstName} ${e.actor.lastName}` : null })),
    deliveryFee: o.deliveryFeeCentavos || 0,
    subtotal: o.subtotalCentavos, channelFee: o.channelFeeCentavos, total: o.totalCentavos,
    memberPricing: o.memberPricing, holdExpiresAt: o.holdExpiresAt, paidAt: o.paidAt,
    cancelledAt: o.cancelledAt, cancelReason: o.cancelReason, createdAt: o.createdAt,
    items: (o.items || []).map((i) => ({
      productName: i.productName, label: i.variantLabel, sku: i.sku, quantity: i.quantity,
      unitPrice: i.unitPriceCentavos, priceType: i.priceType, lineTotal: i.unitPriceCentavos * i.quantity,
    })),
    paymentReference: o.payment ? o.payment.gatewayPaymentId : null,
  };
}

async function listMyOrders(user) {
  const orders = await prisma.merchOrder.findMany({
    where: { userId: user.id }, orderBy: { id: 'desc' }, include: { items: { orderBy: { id: 'asc' } }, payment: { select: { gatewayPaymentId: true } } },
  });
  return orders.map(presentOrder);
}

async function getMyOrder(user, orderNumber) {
  return presentOrder(await ownOrder(user, orderNumber));
}

// Logistics paused this order because its address looked wrong. The buyer
// corrects it (same rules as checkout) and the order goes back to where it
// was. The fee was paid already, so the new address must be in the same
// delivery zone; anything else goes through the organizers.
async function fixAddress(user, orderNumber, body) {
  assertBuyer(user);
  const order = await ownOrder(user, orderNumber);
  if (order.status !== 'ADDRESS_HOLD') throw new AppError('This order\'s address cannot be changed now', 409);
  const f = fulfilment();
  const address = await f.validateAddress(body || {});
  const quote = await f.deliveryQuote(address.regionCode);
  if (!quote.available || quote.zoneName !== order.zoneName) {
    throw new AppError(`This address is outside the ${order.zoneName} delivery zone you paid for. Contact us to change zones.`, 422);
  }
  if (!(body.confirmAddress === true || body.confirmAddress === 'true')) throw new AppError('Tick "This address is complete and correct" to continue', 422);
  await prisma.$transaction(async (tx) => {
    const flipped = await tx.merchOrder.updateMany({
      where: { id: order.id, status: 'ADDRESS_HOLD' },
      data: {
        status: order.holdFromStatus || 'PAID', holdFromStatus: null, addressNote: null,
        shipTo: JSON.stringify({ ...address, lines: f.labelLines(address) }), shipRegionCode: address.regionCode,
      },
    });
    if (flipped.count !== 1) throw new AppError('This order\'s address cannot be changed now', 409);
    await addEvent(tx, order.id, order.holdFromStatus || 'PAID', 'Address corrected by the buyer', user.id);
  });
  return getMyOrder(user, orderNumber);
}

module.exports = {
  HOLD_MINUTES,
  STATUS_LABELS,
  addEvent,
  onRefundFailed,
  presentOrder,
  checkoutOptions,
  quoteTotal,
  fixAddress,
  isStoreOpen,
  setStoreOpen,
  storeAccess,
  availableFor,
  listStoreProducts,
  getStoreProduct,
  getCart,
  setCartQuantity,
  removeFromCart,
  checkout,
  payOrder,
  cancelOrder,
  closeOrder,
  sweepExpiredHolds,
  onPaymentPaid,
  onRefundSucceeded,
  listMyOrders,
  getMyOrder,
};
