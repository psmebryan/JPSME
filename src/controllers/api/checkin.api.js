const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const checkinService = require('../../services/checkin.service');

// Same shape as admin.api.js's checkValidation: validators declared on the
// route are inert unless something actually reads the result, so every handler
// with validators attached calls this first.
function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// The scanner page posts a string and renders whatever comes back. Every
// question that decides admission — does this code exist, is it for this door,
// is it paid, has it already been used — is answered in checkin.service, and
// nothing in the request can influence the answer except the scanned value and
// which event's door it was scanned at.

// A refused scan is a normal, expected outcome at a door, not an error: wrong
// event, already checked in and unpaid all happen constantly at a live entrance.
// They come back 200 with ok:false so the scanner page renders them as a red
// result rather than a network failure. Genuine faults — no access, no such
// event — still throw and become 4xx.
const scan = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const result = await checkinService.checkInByScan({
    eventId: req.params.id,
    rawScan: req.body.qrToken,
    staffUser: req.session.user,
    scannerIdentifier: req.body.scannerIdentifier,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  return success(res, result, result.message);
});

const manualCheckIn = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const result = await checkinService.checkInManually({
    eventId: req.params.id,
    registrationId: req.body.registrationId,
    staffUser: req.session.user,
    scannerIdentifier: req.body.scannerIdentifier,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  return success(res, result, result.message);
});

const searchRegistrations = asyncHandler(async (req, res) => {
  await checkinService.assertCanCheckIn(req.session.user, req.params.id);
  const results = await checkinService.searchRegistrations(req.params.id, req.query.q);
  return success(res, { results });
});

const stats = asyncHandler(async (req, res) => {
  await checkinService.assertCanCheckIn(req.session.user, req.params.id);
  const [counts, recent] = await Promise.all([
    checkinService.getEventCheckInStats(req.params.id),
    checkinService.getRecentCheckIns(req.params.id),
  ]);
  return success(res, { stats: counts, recent });
});

// --- access management (main admin only; enforced by apiAdmin on the route) --

const listStaff = asyncHandler(async (req, res) => {
  const staff = await checkinService.listCheckInStaff(req.params.id);
  return success(res, { staff });
});

const grantStaff = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const grant = await checkinService.grantCheckInAccess({
    eventId: req.params.id,
    userId: req.body.userId,
    adminUserId: req.session.user.id,
    ipAddress: req.ip,
  });
  return success(res, { grant }, 'Check-in access granted', 201);
});

const revokeStaff = asyncHandler(async (req, res) => {
  await checkinService.revokeCheckInAccess({
    eventId: req.params.id,
    userId: req.params.userId,
    adminUserId: req.session.user.id,
    ipAddress: req.ip,
  });
  return success(res, null, 'Check-in access revoked');
});

module.exports = { scan, manualCheckIn, searchRegistrations, stats, listStaff, grantStaff, revokeStaff };
