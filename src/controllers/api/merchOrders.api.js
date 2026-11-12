const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const orders = require('../../services/merchOrders.service');
const fulfilment = require('../../services/merchFulfilment.service');

// Merchandise orders and delivery settings for staff (/api/admin/merch).
// Behind router.use(apiAdmin) and merchCan: steps and handover need
// orders.fulfil (Logistics, the main admin), settings need settings.edit.
// Rules live in merchOrders / merchFulfilment.service.

const actor = (req) => req.session.user.id;

const step = asyncHandler(async (req, res) => {
  const order = await orders.applyStep(req.params.orderNumber, req.params.action, req.body || {}, actor(req));
  return success(res, { order }, `${order.orderNumber}: ${order.statusLabel}.`);
});

const bulk = asyncHandler(async (req, res) => {
  const result = await orders.applyBulk(req.body.action, req.body.orderNumbers, actor(req));
  return success(res, result, `${result.done.length} order(s) updated${result.failed.length ? `; ${result.failed.length} could not be` : ''}.`);
});

const handoverLookup = asyncHandler(async (req, res) => success(res, { order: await orders.lookupForHandover(req.body.code) }));
const handover = asyncHandler(async (req, res) => {
  const order = await orders.handOver(req.body.code, actor(req));
  return success(res, { order }, `${order.orderNumber} handed over to ${order.buyerName}.`);
});

const updateZone = asyncHandler(async (req, res) => {
  const zone = await fulfilment.updateZone(req.params.id, req.body || {});
  return success(res, { zone }, `Saved ${zone.name}.`);
});
const setRegionZone = asyncHandler(async (req, res) => {
  await fulfilment.setRegionZone(req.body.regionCode, req.body.zoneId);
  return success(res, { zones: await fulfilment.listZones() }, 'Region moved.');
});
const addPickupPoint = asyncHandler(async (req, res) => success(res, { point: await fulfilment.addPickupPoint(req.body || {}) }, 'Pickup point added.', 201));
const updatePickupPoint = asyncHandler(async (req, res) => success(res, { point: await fulfilment.updatePickupPoint(req.params.id, req.body || {}) }, 'Pickup point saved.'));

// The PSA workbook, uploaded. Replaces the whole PSGC list.
const importPsgc = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'Choose the PSA Publication Datafile (.xlsx)', 400);
  const summary = await fulfilment.importPsgc(req.file.buffer, { source: req.file.originalname, actorId: actor(req) });
  return success(res, { summary }, `Imported ${summary.regions} regions, ${summary.provinces} provinces, ${summary.cities} cities and municipalities, ${summary.barangays} barangays.`);
});

module.exports = { step, bulk, handoverLookup, handover, updateZone, setRegionZone, addPickupPoint, updatePickupPoint, importPsgc };
