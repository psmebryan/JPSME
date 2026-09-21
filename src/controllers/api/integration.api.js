// The endpoints another system calls to scan this event's tickets.
//
// Everything here runs behind integrationAuth, so req.integrationKey is always
// present and always carries its own event. No handler reads an event id from
// the request — there is nothing to get wrong and nothing to substitute.
//
// The response shape is the same envelope the rest of the API uses
// ({ success, message, data }), so a caller that already speaks to this server
// does not need a second parser for this corner of it.

const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const checkinService = require('../../services/checkin.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// Where the scan came from, for the door log. Truncated rather than rejected:
// an over-long station name is not worth refusing somebody entry over.
function stationOf(req) {
  const raw = req.body.scannerIdentifier || req.body.station || null;
  return raw ? String(raw).trim().slice(0, 64) : null;
}

// Which event this key opens.
//
// Exists so an integrator can prove their configuration is right BEFORE the
// morning of the event, rather than discovering at the door that the key they
// pasted belongs to last year's convention. Costs one round trip and prevents
// the worst possible time to find out.
const whoami = asyncHandler(async (req, res) => {
  const key = req.integrationKey;
  return success(res, {
    event: {
      id: key.event.id,
      title: key.event.title,
      startDate: key.event.startDate,
      endDate: key.event.endDate,
    },
    key: { keyId: key.keyId, label: key.label },
  }, 'Integration key is valid');
});

// Identify without admitting.
//
// For a system that needs to know who is at the door — to print a badge, show a
// name, light a lane — without claiming they arrived. Writes nothing: no
// admission and no row in the door log.
const lookup = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;

  const result = await checkinService.lookupByIntegration({
    integrationKey: req.integrationKey,
    rawScan: req.body.qrToken,
  });
  return success(res, result, result.message || 'Found');
});

// Admit.
//
// A refused scan is a normal outcome at a door, not an error — wrong event,
// already checked in, unpaid and cancelled all happen constantly at a live
// entrance. They come back 200 with ok:false and a `result` code, so the
// calling system can show a red screen rather than treat it as the network
// being down. Genuine faults (bad key, no such event) are still 4xx.
//
// The `result` codes a caller should handle:
//   SUCCESS             admitted just now
//   ALREADY_CHECKED_IN  a valid ticket that was already used
//   INVALID_QR          not a JPSME ticket, or not a real one
//   WRONG_EVENT         a real ticket, for a different event
//   CANCELLED           the registration was cancelled
//   UNPAID              payment not confirmed
//   NOT_REGISTERED      the registration is not in a state that admits
//   REJECTED            the account behind it was rejected
const checkin = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;

  const result = await checkinService.checkInByIntegration({
    integrationKey: req.integrationKey,
    rawScan: req.body.qrToken,
    scannerIdentifier: stationOf(req),
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  return success(res, result, result.message || 'Checked in');
});


// The roster for this key's event.
//
// Paginated, filterable, and carrying no qrToken — see the service for why that
// one field is absent and has to stay absent.
const registrations = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;

  // `checkedIn` arrives as a query string, so "false" is a non-empty string and
  // therefore truthy. Compared against the literals instead, with anything else
  // meaning "no filter" rather than silently meaning "only checked in".
  const raw = req.query.checkedIn;
  const checkedIn = raw === 'true' ? true : (raw === 'false' ? false : null);

  const result = await checkinService.listRegistrationsForIntegration({
    integrationKey: req.integrationKey,
    page: req.query.page,
    pageSize: req.query.pageSize,
    q: req.query.q,
    status: req.query.status,
    checkedIn,
  });
  return success(res, result);
});

// Admit somebody who cannot present a scannable code.
const manualCheckin = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;

  if (!req.body.registrationId && !req.body.registrationNumber) {
    return error(res, 'Send either registrationId or registrationNumber', 422);
  }

  const result = await checkinService.checkInManuallyByIntegration({
    integrationKey: req.integrationKey,
    registrationId: req.body.registrationId || null,
    registrationNumber: req.body.registrationNumber || null,
    scannerIdentifier: stationOf(req),
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  return success(res, result, result.message || 'Checked in');
});

module.exports = { whoami, lookup, checkin, registrations, manualCheckin };
