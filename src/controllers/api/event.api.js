const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const eventService = require('../../services/event.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// feePhp arrives as a decimal peso string (e.g. "150.00") from the admin
// form, same convention as the membership fee in admin.api.js; converted to
// integer centavos here, before the service ever sees it, so the DB and
// payment.service.js never deal with float currency math.
function applyFeeConversion(payload) {
  if (payload.feePhp === undefined) return payload;
  const { feePhp, ...rest } = payload;
  rest.feeCentavos = Math.round(Number(feePhp) * 100);
  return rest;
}

const listPublicEvents = asyncHandler(async (req, res) => {
  const events = await eventService.listActiveEvents();
  return success(res, { events });
});

const listAllEvents = asyncHandler(async (req, res) => {
  const events = await eventService.listAllEvents();
  return success(res, { events });
});

const getEvent = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id);
  return success(res, { event });
});

const createEvent = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  // If a file was uploaded via multer, use its public path
  const payload = applyFeeConversion({ ...req.body });
  if (req.file) {
    payload.imageUrl = `/uploads/events/${req.file.filename}`;
  }
  const event = await eventService.createEvent(payload);
  return success(res, { event }, 'Event created', 201);
});

const updateEvent = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const payload = applyFeeConversion({ ...req.body });
  if (req.file) {
    payload.imageUrl = `/uploads/events/${req.file.filename}`;
  }
  const event = await eventService.updateEvent(req.params.id, payload);
  return success(res, { event }, 'Event updated');
});

const deleteEvent = asyncHandler(async (req, res) => {
  await eventService.deleteEvent(req.params.id);
  return success(res, null, 'Event deleted');
});

module.exports = { listPublicEvents, listAllEvents, getEvent, createEvent, updateEvent, deleteEvent };
