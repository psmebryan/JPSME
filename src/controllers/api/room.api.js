const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const roomService = require('../../services/roomAttendance.service');

// Rooms and room attendance. Sits alongside checkin.api rather than inside it:
// arriving at the venue and entering a hall are different scans at different
// doors, and folding them into one controller would invite folding them into
// one rule.

// Same shape as the other controllers here: validators declared on a route do
// nothing unless a handler reads the result.
function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// --- configuration ----------------------------------------------------------

const listRooms = asyncHandler(async (req, res) => {
  const rooms = await roomService.listRooms(req.params.id);
  return success(res, { rooms });
});

const createRoom = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const room = await roomService.createRoom({
    eventId: req.params.id,
    name: req.body.name,
    capacity: req.body.capacity,
    location: req.body.location,
    displayOrder: req.body.displayOrder,
    adminUserId: req.session.user.id,
  });
  return success(res, { room }, `${room.name} added.`, 201);
});

const updateRoom = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const room = await roomService.updateRoom({
    eventId: req.params.id,
    roomId: req.params.roomId,
    // Passed through as-is so the service can tell "not sent" from "sent
    // empty" — clearing a capacity and leaving it alone are different edits.
    data: req.body,
    adminUserId: req.session.user.id,
  });
  return success(res, { room }, 'Room updated.');
});

const deleteRoom = asyncHandler(async (req, res) => {
  const result = await roomService.deleteRoom({
    eventId: req.params.id,
    roomId: req.params.roomId,
    adminUserId: req.session.user.id,
  });
  return success(res, result, 'Room deleted.');
});

// --- sessions ---------------------------------------------------------------

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await roomService.listSessions(req.params.id);
  return success(res, { sessions });
});

const createSession = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const session = await roomService.createSession({
    eventId: req.params.id,
    roomId: req.body.roomId || null,
    name: req.body.name,
    startTime: req.body.startTime || null,
    endTime: req.body.endTime || null,
  });
  return success(res, { session }, `${session.name} added.`, 201);
});

const deleteSession = asyncHandler(async (req, res) => {
  const result = await roomService.deleteSession({
    eventId: req.params.id,
    sessionId: req.params.sessionId,
  });
  return success(res, result, 'Session deleted.');
});

// --- the door ---------------------------------------------------------------

// A refused scan is a normal outcome at a door, not an error — a closed room, a
// full room and an unpaid ticket all happen constantly at a live event. They
// come back 200 with ok:false so the screen renders them as a red result rather
// than a network failure. Genuine faults (no access, no such room) still throw.
const scan = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const result = await roomService.roomScan({
    eventId: req.params.id,
    roomId: req.params.roomId,
    rawScan: req.body.qrToken,
    staffUser: req.session.user,
    scannerIdentifier: req.body.scannerIdentifier,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  return success(res, result, result.message);
});

const listInside = asyncHandler(async (req, res) => {
  const inside = await roomService.listInside(req.params.id, req.params.roomId);
  return success(res, { inside, count: inside.length });
});

const overrideState = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const result = await roomService.overrideRoomState({
    eventId: req.params.id,
    roomId: req.params.roomId,
    registrationId: req.body.registrationId,
    state: req.body.state,
    staffUser: req.session.user,
    ipAddress: req.ip,
  });
  return success(res, result, result.state === 'INSIDE' ? 'Marked as inside.' : 'Marked as outside.');
});

const attendanceHistory = asyncHandler(async (req, res) => {
  const history = await roomService.getAttendanceHistory(req.params.registrationId);
  return success(res, { history });
});

module.exports = {
  listRooms,
  createRoom,
  updateRoom,
  deleteRoom,
  listSessions,
  createSession,
  deleteSession,
  scan,
  listInside,
  overrideState,
  attendanceHistory,
};
