const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const merch = require('../../services/merch.service');
const storageService = require('../../services/storage.service');
const redact = require('../../utils/merchRedact');

// Merchandise admin API (/api/admin/merch). Behind router.use(apiAdmin) in
// admin.routes.js: the main admin, or a National President given the
// Merchandise module (config/adminModules), or a Finance & Logistics account;
// merchCan (admin.routes) sets req.merchCaps. Validation is in merch.service.
//
// Costs: without cost.view, every response has the cost figures taken out
// (utils/merchRedact), and a cost sent in is ignored, so a person who cannot
// see the cost cannot change it either.

const actor = (req) => req.session.user.id;
const out = (req, value) => redact.costs(req.merchCaps, value);
const input = (req, fields) => {
  const body = { ...(req.body || {}) };
  if (!(req.merchCaps && req.merchCaps.has('cost.view'))) fields.forEach((k) => { delete body[k]; });
  return body;
};
const removeFiles = (urls) => Promise.all(urls.map((u) => storageService.remove(u).catch((err) => {
  console.error('Failed to remove a merchandise photo:', err.message || err);
})));

const listProducts = asyncHandler(async (req, res) => success(res, out(req, { products: await merch.listProducts() })));
const getProduct = asyncHandler(async (req, res) => success(res, out(req, { product: await merch.getProduct(req.params.id) })));

const createProduct = asyncHandler(async (req, res) => {
  const product = await merch.createProduct(req.body);
  return success(res, out(req, { product }), `Added "${product.name}".`, 201);
});

const updateProduct = asyncHandler(async (req, res) => {
  const product = await merch.updateProduct(req.params.id, req.body);
  return success(res, out(req, { product }), `Saved "${product.name}".`);
});

const deleteProduct = asyncHandler(async (req, res) => {
  const result = await merch.deleteProduct(req.params.id);
  await removeFiles(result.files);
  return success(res, { id: result.id }, 'Product removed.');
});

// Photos arrive as "photos" (several), each checked by its bytes first
// (verifyImageSignatures) and stored under the type it really is.
const addPhotos = asyncHandler(async (req, res) => {
  const files = (req.files && req.files.photos) || [];
  if (!files.length) return error(res, 'Choose at least one photo', 400);
  if (files.some((f) => f.detectedExtension === '.svg')) return error(res, 'Only PNG, JPEG or WEBP photos are allowed', 400);
  const urls = [];
  for (const file of files) {
    urls.push(await storageService.saveUpload(file.buffer, { folder: 'merch', prefix: 'merch', extension: file.detectedExtension }));
  }
  try {
    const product = await merch.addPhotos(req.params.id, urls);
    return success(res, out(req, { product }), `${urls.length} photo${urls.length === 1 ? '' : 's'} added.`, 201);
  } catch (err) {
    await removeFiles(urls);
    throw err;
  }
});

const removePhoto = asyncHandler(async (req, res) => {
  const result = await merch.removePhoto(req.params.id, req.params.imageId);
  await removeFiles([result.file]);
  return success(res, out(req, { product: result.product }), 'Photo removed.');
});

const addVariant = asyncHandler(async (req, res) => {
  const variant = await merch.addVariant(req.params.id, input(req, ['cost']), actor(req));
  return success(res, out(req, { variant }), `Added "${variant.label}" (${variant.sku}).`, 201);
});

const updateVariant = asyncHandler(async (req, res) => {
  const variant = await merch.updateVariant(req.params.id, req.params.variantId, input(req, ['cost']), actor(req));
  return success(res, out(req, { variant }), `Saved "${variant.label}".`);
});

const deleteVariant = asyncHandler(async (req, res) => {
  const result = await merch.deleteVariant(req.params.id, req.params.variantId);
  return success(res, result, 'Variant removed.');
});

const priceHistory = asyncHandler(async (req, res) => success(res, out(req, { history: await merch.priceHistory(req.params.variantId) })));
const movements = asyncHandler(async (req, res) => success(res, out(req, await merch.listMovements(req.params.variantId))));

const recordStock = asyncHandler(async (req, res) => {
  const result = await merch.recordStock(req.params.variantId, input(req, ['unitCost']), actor(req));
  const q = result.movement.quantity;
  const what = { RECEIVED: `Received ${q}`, DAMAGED: `Wrote off ${-q}`, COUNT_CORRECTION: q === 0 ? 'Count matches' : `Count corrected by ${q > 0 ? '+' : ''}${q}` }[result.movement.type];
  return success(res, out(req, result), `${what}. On hand: ${result.onHand}.`, 201);
});

// The Store switch: off until launch. While off, only the main admin and a
// President with Merchandise can see the Store.
const setStoreOpen = asyncHandler(async (req, res) => {
  const open = await require('../../services/merchStore.service').setStoreOpen(req.body.open === true || req.body.open === 'true'); // eslint-disable-line global-require
  return success(res, { open }, open ? 'The Store is open to members.' : 'The Store is closed to members.');
});

module.exports = {
  setStoreOpen,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  addPhotos, removePhoto, addVariant, updateVariant, deleteVariant,
  priceHistory, movements, recordStock,
};
