const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const store = require('../../services/merchStore.service');
const fulfilment = require('../../services/merchFulfilment.service');
const returns = require('../../services/merchReturns.service');
const storageService = require('../../services/storage.service');

// The merchandise store for buyers (/api/store). Signed in only (apiAuth);
// every price, stock and limit is decided in merchStore.service, never taken
// from the request: the body carries only which variant and how many.

const me = (req) => req.session.user;

// "Report a problem" (phase 5): for whoever can see the Store before it opens
// to everyone (the soft-launch testers and the store's staff).
const reportProblem = asyncHandler(async (req, res) => {
  const access = await store.storeAccess(me(req));
  if (!access.visible || access.open) return error(res, 'Reporting a problem is for the soft launch', 404);
  // eslint-disable-next-line global-require
  const f = await require('../../services/merchLaunch.service').createFeedback(me(req), req.body || {});
  return success(res, { id: f.id }, 'Thanks! The store team will look at it.', 201);
});

const getCart = asyncHandler(async (req, res) => success(res, { cart: await store.getCart(me(req)) }));

const addToCart = asyncHandler(async (req, res) => {
  const cart = await store.setCartQuantity(me(req), req.body.variantId, req.body.quantity ?? 1, { add: true });
  return success(res, { cart }, 'Added to your cart.');
});

const setQuantity = asyncHandler(async (req, res) => {
  const cart = await store.setCartQuantity(me(req), req.params.variantId, req.body.quantity);
  return success(res, { cart }, 'Cart updated.');
});

const removeFromCart = asyncHandler(async (req, res) => {
  const cart = await store.removeFromCart(me(req), req.params.variantId);
  return success(res, { cart }, 'Removed from your cart.');
});

// An unpaid order already open answers 409 with its number, so the page can
// send the buyer to it.
const checkout = asyncHandler(async (req, res) => {
  try {
    const { order, checkoutUrl } = await store.checkout(me(req), req.body || {});
    return success(res, { orderNumber: order.orderNumber, checkoutUrl }, 'Opening PayMongo…', 201);
  } catch (err) {
    if (err.data && err.data.orderNumber) return res.status(err.statusCode || 409).json({ success: false, message: err.message, data: err.data });
    throw err;
  }
});

const payOrder = asyncHandler(async (req, res) => {
  const { checkoutUrl } = await store.payOrder(me(req), req.params.orderNumber);
  return success(res, { checkoutUrl }, 'Opening PayMongo…');
});

const cancelOrder = asyncHandler(async (req, res) => {
  await store.cancelOrder(me(req), req.params.orderNumber);
  return success(res, null, 'Order cancelled. Its items are back on sale.');
});

const myOrder = asyncHandler(async (req, res) => {
  const order = await store.getMyOrder(me(req), req.params.orderNumber);
  return order ? success(res, { order }) : error(res, 'Order not found', 404);
});

// Delivery and pickup (phase 3a).
const checkoutOptions = asyncHandler(async (req, res) => success(res, await store.checkoutOptions(me(req))));

// The total with delivery to a region, for the checkout page to show before
// paying. The server works it out again at checkout; this is only a preview.
const deliveryQuote = asyncHandler(async (req, res) => {
  const quote = await fulfilment.deliveryQuote(req.query.region);
  const cart = await store.getCart(me(req));
  const totals = await store.quoteTotal(cart.subtotal, quote.available ? quote.feeCentavos : 0);
  return success(res, { quote, totals });
});

const psgcRegions = asyncHandler(async (req, res) => success(res, { regions: await fulfilment.listRegions() }));
const psgcProvinces = asyncHandler(async (req, res) => success(res, await fulfilment.listProvinces(req.query.region)));
const psgcCities = asyncHandler(async (req, res) => success(res, { cities: await fulfilment.listCities(req.query.region, req.query.province) }));
const psgcBarangays = asyncHandler(async (req, res) => success(res, { barangays: await fulfilment.listBarangays(req.query.city) }));

const listAddresses = asyncHandler(async (req, res) => success(res, { addresses: await fulfilment.listAddresses(me(req).id) }));
const addAddress = asyncHandler(async (req, res) => {
  await fulfilment.saveAddress(me(req).id, req.body || {});
  return success(res, { addresses: await fulfilment.listAddresses(me(req).id) }, 'Address saved.', 201);
});
const updateAddress = asyncHandler(async (req, res) => {
  await fulfilment.saveAddress(me(req).id, req.body || {}, req.params.id);
  return success(res, { addresses: await fulfilment.listAddresses(me(req).id) }, 'Address updated.');
});
const deleteAddress = asyncHandler(async (req, res) => {
  await fulfilment.deleteAddress(me(req).id, req.params.id);
  return success(res, { addresses: await fulfilment.listAddresses(me(req).id) }, 'Address removed.');
});

const fixAddress = asyncHandler(async (req, res) => {
  const order = await store.fixAddress(me(req), req.params.orderNumber, req.body || {});
  return success(res, { order }, 'Thank you. Your address is fixed and your order is moving again.');
});

// Refunds and exchanges (phase 3b).
const returnForm = asyncHandler(async (req, res) => success(res, await returns.requestForm(me(req), req.params.orderNumber)));

// A request, with an optional photo (required for damage). The body arrives
// as form fields: items as JSON text.
const requestReturn = asyncHandler(async (req, res) => {
  const file = req.files && req.files.photo && req.files.photo[0];
  if (file && file.detectedExtension === '.svg') return error(res, 'Only PNG, JPEG or WEBP photos are allowed', 400);
  const photoUrl = file ? await storageService.saveUpload(file.buffer, { folder: 'merch-returns', prefix: 'return', extension: file.detectedExtension }) : null;
  let items = req.body.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
  try {
    const ret = await returns.createRequest(me(req), req.params.orderNumber, { ...req.body, items }, { byBuyer: true, photoUrl });
    const msg = ret.reason === 'CANCELLED_BEFORE_PACKING' ? 'Cancellation requested. We will refund you once it is approved.' : `Request ${ret.returnNumber} sent. We will update you on your order page.`;
    return success(res, { request: ret }, msg, 201);
  } catch (err) {
    if (photoUrl) await storageService.remove(photoUrl).catch(() => {});
    throw err;
  }
});

const withdrawReturn = asyncHandler(async (req, res) => {
  const ret = await returns.withdraw(me(req), req.params.returnNumber);
  return success(res, { request: ret }, 'Request withdrawn.');
});

module.exports = {
  reportProblem,
  returnForm, requestReturn, withdrawReturn,
  getCart, addToCart, setQuantity, removeFromCart, checkout, payOrder, cancelOrder, myOrder,
  checkoutOptions, deliveryQuote, psgcRegions, psgcProvinces, psgcCities, psgcBarangays,
  listAddresses, addAddress, updateAddress, deleteAddress, fixAddress,
};
