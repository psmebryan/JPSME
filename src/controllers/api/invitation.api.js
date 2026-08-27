const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const invitationService = require('../../services/invitation.service');
const sheetsSyncService = require('../../services/sheetsSync.service');

const listInvitations = asyncHandler(async (req, res) => {
  const invitations = await invitationService.listInvitationsForEvent(req.params.id);
  return success(res, { invitations });
});

const createInvitations = asyncHandler(async (req, res) => {
  const invitees = Array.isArray(req.body.invitees) ? req.body.invitees : [];
  if (!invitees.length) return error(res, 'At least one invitee is required', 422);
  if (invitees.length > 200) return error(res, 'Please send invitations in batches of 200 or fewer', 422);

  const invitations = await invitationService.createInvitations(req.params.id, invitees);
  return success(res, { invitations }, 'Invitations sent', 201);
});

const resendInvitation = asyncHandler(async (req, res) => {
  const invitation = await invitationService.resendInvitation(req.params.invitationId);
  return success(res, { invitation }, 'Invitation resent');
});

const exportInvitationsExcel = asyncHandler(async (req, res) => {
  const buffer = await invitationService.exportInvitationsExcel(req.params.id);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="event-${req.params.id}-invitations.xlsx"`);
  res.send(buffer);
});

const exportAllInvitationsExcel = asyncHandler(async (req, res) => {
  const buffer = await invitationService.exportInvitationsExcel(null);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="all-invitations.xlsx"');
  res.send(buffer);
});

// Pulls rows from the admin-maintained "Contacts to Invite" tab in the live
// Google Sheet (see sheetsSync.service.js's fetchContactsToInvite) so a bulk
// list of non-member contacts can be added to the pending invite list in one
// click instead of typed in one at a time via External Contact.
const fetchContactsToInvite = asyncHandler(async (req, res) => {
  if (!sheetsSyncService.isConfigured()) {
    return error(res, 'Google Sheets is not configured for this app yet.', 503);
  }
  const contacts = await sheetsSyncService.fetchContactsToInvite();
  return success(res, { contacts }, contacts.length ? `Fetched ${contacts.length} contact(s)` : 'The "Contacts to Invite" sheet is empty (or was just created — add rows there and try again).');
});

// Public, unauthenticated — a visitor who isn't a member (and so has nothing
// to log in with) self-requests an invitation to this event. Reuses the exact
// same admin-invite pipeline (dedup, send, tracking) so this is just a second
// entry point onto EventInvitation, not a parallel system — see
// invitation.service.js's createInvitations doc comment.
const requestInvitation = asyncHandler(async (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) return error(res, 'Validation failed', 422, result.array());

  const { fullName, email, school, chapter, company } = req.body;
  const [invitation] = await invitationService.createInvitations(req.params.id, [
    { fullName, email, school: school || null, chapter: chapter || null, company: company || null, source: 'SELF_REQUESTED' },
  ]);
  return success(res, { invitation }, 'Your invitation is on its way — check your email.', 201);
});

// Public, unauthenticated — a guest (no account) invitee's Attending/Not
// Attending answer, recorded straight off the token in their invite link.
const submitRsvp = asyncHandler(async (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) return error(res, 'Validation failed', 422, result.array());

  const invitation = await invitationService.recordRsvp(req.params.token, req.params.id, req.body.status);
  return success(res, { invitation }, 'RSVP recorded');
});

module.exports = { listInvitations, createInvitations, resendInvitation, requestInvitation, submitRsvp, exportInvitationsExcel, exportAllInvitationsExcel, fetchContactsToInvite };
