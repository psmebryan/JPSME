const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const broadcastService = require('../../services/broadcastEmail.service');

function parseAudience(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || (parsed.scope !== 'all' && parsed.scope !== 'selected')) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

const listBroadcasts = asyncHandler(async (req, res) => {
  const broadcasts = await broadcastService.listBroadcasts();
  return success(res, { broadcasts });
});

const getBroadcast = asyncHandler(async (req, res) => {
  const broadcast = await broadcastService.getBroadcast(req.params.id);
  return success(res, { broadcast });
});

const getAudienceCount = asyncHandler(async (req, res) => {
  const audience = parseAudience(req.query.audience);
  if (!audience) return error(res, 'Invalid audience filter', 422);
  const count = await broadcastService.previewAudienceCount(audience);
  return success(res, { count });
});

const createBroadcast = asyncHandler(async (req, res) => {
  const { subject, bodyHtml } = req.body;
  const audience = parseAudience(req.body.audience);
  if (!audience) return error(res, 'Invalid audience filter', 422);
  if (!subject || !String(subject).trim()) return error(res, 'Subject is required', 422);
  if (!bodyHtml || !String(bodyHtml).trim()) return error(res, 'Body is required', 422);

  const attachmentPath = req.file ? `/uploads/email-attachments/${req.file.filename}` : null;

  const broadcast = await broadcastService.createBroadcast({
    subject: String(subject).trim(),
    bodyHtml,
    attachmentPath,
    audience,
    createdBy: req.session.user.id,
  });

  return success(res, { broadcast }, `Broadcast started — sending to ${broadcast.totalRecipients} recipient(s)`, 201);
});

module.exports = { listBroadcasts, getBroadcast, getAudienceCount, createBroadcast };
