const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const eventFeeService = require('../../services/eventFee.service');

// One event's registration fee options (Master List -> Event Fee). Main admin
// only (router.use(apiAdmin) in admin.routes.js). Validation is in
// eventFee.service: a name of 1-60 characters, unique within the event, and an
// amount from 0 to 1,000,000.

const list = asyncHandler(async (req, res) => {
  const options = await eventFeeService.listOptions(req.params.eventId);
  return success(res, { options });
});

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  const option = await eventFeeService.addOption(req.params.eventId, { name: b.name, fee: b.fee, isActive: b.isActive, audience: b.audience });
  return success(res, { option }, `Added "${option.name}".`, 201);
});

const update = asyncHandler(async (req, res) => {
  const b = req.body;
  const option = await eventFeeService.updateOption(req.params.eventId, req.params.optionId, {
    name: b.name, fee: b.fee, isActive: b.isActive, audience: b.audience, sortOrder: b.sortOrder,
  });
  return success(res, { option }, `Saved "${option.name}"${option.isActive ? '' : ' (off)'}.`);
});

const remove = asyncHandler(async (req, res) => {
  const result = await eventFeeService.removeOption(req.params.eventId, req.params.optionId);
  return success(res, result, 'Fee option removed.');
});

module.exports = { list, create, update, remove };
