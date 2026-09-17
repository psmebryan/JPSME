const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const seatingService = require('../../services/seating.service');
const prisma = require('../../config/prisma');

// Assigned seating. Two audiences on the same data:
//
//   an admin building and supervising the plan, who sees names
//   an attendee choosing a seat, who must not
//
// The split is enforced here rather than in the page, because a page that
// forgets is a page that quietly publishes the attendee list.

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// The caller's own registration for this event. Everything an attendee does to
// a seat is scoped to it — the request never names a registration, so it cannot
// name somebody else's.
async function ownRegistration(req) {
  const registration = await prisma.eventRegistration.findUnique({
    where: { userId_eventId: { userId: req.session.user.id, eventId: Number(req.params.id) } },
  });
  if (!registration) throw new (require('../../utils/AppError'))('You are not registered for this event', 403);
  return registration;
}

// --- reading ----------------------------------------------------------------

const adminMap = asyncHandler(async (req, res) => {
  const sections = await seatingService.getSeatMap(req.params.id, { includeNames: true });
  return success(res, { sections });
});

const attendeeMap = asyncHandler(async (req, res) => {
  const registration = await ownRegistration(req);
  const sections = await seatingService.getSeatMap(req.params.id, { forRegistrationId: registration.id });
  const mySeat = await seatingService.getSeatFor(registration.id);
  return success(res, { sections, mySeat, holdMs: seatingService.HOLD_MS });
});

// Seats whose owner has walked out — the list an organiser acts on.
//
// Admin-only: it names people and says where they went, which is exactly what
// the attendee map is careful never to reveal.
const steppedOut = asyncHandler(async (req, res) => {
  const seats = await seatingService.listSteppedOut(req.params.id);
  return success(res, { seats, count: seats.length });
});

// What the desk offers when somebody has no seat yet.
const availableSeats = asyncHandler(async (req, res) => {
  const seats = await seatingService.listAvailableSeats(req.params.id, {
    sectionId: req.query.sectionId || null,
    limit: req.query.limit,
  });
  return success(res, { seats, count: seats.length });
});

// One person as the desk needs to see them: who they are, whether they have
// arrived, and where they are sitting.
const registrationSeat = asyncHandler(async (req, res) => {
  const seat = await seatingService.getSeatFor(req.params.registrationId);
  return success(res, { seat });
});

const seatHistory = asyncHandler(async (req, res) => {
  const history = await seatingService.getSeatHistory(req.params.id, req.params.seatId);
  return success(res, { history });
});

// --- configuration ----------------------------------------------------------

const setEnabled = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const event = await seatingService.setSeatingEnabled({
    eventId: req.params.id,
    enabled: req.body.enabled,
    adminUserId: req.session.user.id,
  });
  return success(res, { seatingEnabled: event.seatingEnabled },
    event.seatingEnabled ? 'Assigned seating is on.' : 'Assigned seating is off.');
});

const createSection = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const section = await seatingService.createSection({
    eventId: req.params.id,
    name: req.body.name,
    roomId: req.body.roomId || null,
    displayOrder: req.body.displayOrder,
    adminUserId: req.session.user.id,
  });
  return success(res, { section }, `${section.name} added.`, 201);
});

const updateSection = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const section = await seatingService.updateSection({
    eventId: req.params.id,
    sectionId: req.params.sectionId,
    data: req.body,
    adminUserId: req.session.user.id,
  });
  return success(res, { section }, 'Section updated.');
});

const deleteSection = asyncHandler(async (req, res) => {
  const result = await seatingService.deleteSection({
    eventId: req.params.id,
    sectionId: req.params.sectionId,
    adminUserId: req.session.user.id,
  });
  return success(res, result, 'Section removed.');
});

const generateSeats = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const result = await seatingService.generateSeats({
    eventId: req.params.id,
    sectionId: req.params.sectionId,
    rows: req.body.rows,
    seatsPerRow: req.body.seatsPerRow,
    startNumber: req.body.startNumber,
    rowLabelStyle: req.body.rowLabelStyle,
    rowLabelStart: req.body.rowLabelStart,
    type: req.body.type,
    adminUserId: req.session.user.id,
  });
  return success(res, result, `${result.created} seats added.`, 201);
});

const setBlocked = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const seat = await seatingService.setSeatBlocked({
    eventId: req.params.id,
    seatId: req.params.seatId,
    blocked: req.body.blocked,
    adminUserId: req.session.user.id,
  });
  return success(res, { seat }, seat.isBlocked ? `${seat.label} blocked.` : `${seat.label} unblocked.`);
});

const deleteSeat = asyncHandler(async (req, res) => {
  const result = await seatingService.deleteSeat({
    eventId: req.params.id,
    seatId: req.params.seatId,
    adminUserId: req.session.user.id,
  });
  return success(res, result, 'Seat removed.');
});

// --- the desk ---------------------------------------------------------------

const assignSeat = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const result = await seatingService.assignSeat({
    eventId: req.params.id,
    seatId: req.params.seatId,
    registrationId: req.body.registrationId,
    actorId: req.session.user.id,
  });
  return success(res, result, `${result.label} assigned.`);
});

const adminRelease = asyncHandler(async (req, res) => {
  const result = await seatingService.releaseSeat({
    eventId: req.params.id,
    seatId: req.params.seatId,
    actorId: req.session.user.id,
  });
  return success(res, result, `${result.label} released.`);
});

// --- the attendee -----------------------------------------------------------

// A refused claim is a normal outcome, not an error — somebody else got there
// first, which happens constantly the moment a map opens. It comes back 200
// with ok:false so the page can say "pick another" rather than showing a
// network failure.
const holdSeat = asyncHandler(async (req, res) => {
  const registration = await ownRegistration(req);
  const result = await seatingService.holdSeat({
    eventId: req.params.id,
    seatId: req.params.seatId,
    registrationId: registration.id,
  });
  return success(res, result, result.message || `Holding ${result.label}.`);
});

const confirmSeat = asyncHandler(async (req, res) => {
  const registration = await ownRegistration(req);
  const result = await seatingService.confirmSeat({
    eventId: req.params.id,
    seatId: req.params.seatId,
    registrationId: registration.id,
  });
  return success(res, result, result.message || `${result.label} is yours.`);
});

const releaseOwnSeat = asyncHandler(async (req, res) => {
  const registration = await ownRegistration(req);
  const result = await seatingService.releaseSeat({
    eventId: req.params.id,
    seatId: req.params.seatId,
    // Passed, so the service constrains the update to this person's own seat —
    // an attendee cannot release somebody else's by guessing an id.
    registrationId: registration.id,
  });
  return success(res, result, `${result.label} released.`);
});

module.exports = {
  availableSeats,
  steppedOut,
  registrationSeat,
  adminMap,
  attendeeMap,
  seatHistory,
  setEnabled,
  createSection,
  updateSection,
  deleteSection,
  generateSeats,
  setBlocked,
  deleteSeat,
  assignSeat,
  adminRelease,
  holdSeat,
  confirmSeat,
  releaseOwnSeat,
};
