const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const dataExportService = require('../../services/dataExport.service');
const dataImportService = require('../../services/dataImport.service');
const importTemplateService = require('../../services/importTemplate.service');
const mergoActivationService = require('../../services/mergoActivation.service');
const logger = require('../../utils/logger');
const config = require('../../config');

// MAIN_ADMIN only — enforced at the route layer. The export contains every
// member's contact details and the full payment ledger, so it is not something
// a scoped organization admin may pull.
const exportWorkbook = asyncHandler(async (req, res) => {
  const buffer = await dataExportService.buildWorkbook();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="jpsme-data-${stamp}.xlsx"`);
  res.send(Buffer.from(buffer));
});

// The blank sheet somebody fills in to add members.
//
// Not the export: that is the whole database, including every member's contact
// details and the payment ledger, which is a lot to hand a chapter officer who
// wants to add twelve names.
const importTemplate = asyncHandler(async (req, res) => {
  const buffer = await importTemplateService.buildTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="jpsme-member-import-template.xlsx"');
  res.send(Buffer.from(buffer));
});

// Reports what an import would change, without writing anything. The admin UI
// always runs this first so the result can be read before committing.
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'Choose an .xlsx workbook to import', 400);
  const plan = await dataImportService.analyze(req.file.buffer);
  // Carried so the preview can say what will happen to new accounts.
  return success(res, { ...plan, activationChannel: config.activationEmailChannel });
});

const runImport = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'Choose an .xlsx workbook to import', 400);
  const result = await dataImportService.applyImport(req.file.buffer);
  const { applied } = result;
  const createdUserIds = applied.createdUserIds || [];
  let mergoPreparation = null;

  result.activationChannel = config.activationEmailChannel;

  // With the Mergo channel, new member accounts go straight to the managed
  // campaign sheet. This only prepares their activation rows; Mergo sends when
  // the campaign is launched, unless its "For each new row" schedule is enabled.
  //
  // With the site channel (the default) nobody is emailed here: the admin
  // presses "Send activation links" when ready, and the site sends them.
  if (createdUserIds.length && config.activationEmailChannel === 'mergo') {
    const outcomes = [];
    const campaignIds = new Set();
    for (let offset = 0; offset < createdUserIds.length; offset += 500) {
      const batch = createdUserIds.slice(offset, offset + 500);
      try {
        // eslint-disable-next-line no-await-in-loop
        const prepared = await mergoActivationService.prepareSelected(batch, { actorId: req.session.user.id });
        if (prepared.ok) {
          outcomes.push(...prepared.outcomes);
          if (prepared.campaignId) campaignIds.add(prepared.campaignId);
        } else {
          outcomes.push(...batch.map((userId) => ({ userId, ok: false, reason: prepared.error })));
        }
      } catch (err) {
        logger.error('import: Mergo preparation failed after member accounts were created', { reason: err.message });
        outcomes.push(...batch.map((userId) => ({ userId, ok: false, reason: 'PREPARATION_FAILED' })));
      }
    }
    mergoPreparation = {
      outcomes,
      campaignIds: [...campaignIds],
      prepared: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
    };
    result.mergoPreparation = mergoPreparation;
  }

  const importMessage = `Imported: ${applied.created} organization(s) created, ${applied.updated} updated, ${applied.membersUpdated} member(s) updated.`;
  const siteMessage = createdUserIds.length && config.activationEmailChannel === 'site'
    ? ` ${createdUserIds.length} new member(s) created. Nobody has been emailed yet — press "Send activation links" when you are ready.`
    : '';
  const mergoMessage = mergoPreparation
    ? ` ${mergoPreparation.prepared} new member(s) added to Mergo${mergoPreparation.failed ? `; ${mergoPreparation.failed} need attention` : ''}.`
    : '';
  return success(
    res,
    result,
    importMessage + siteMessage + mergoMessage
  );
});

module.exports = { exportWorkbook, importTemplate, previewImport, runImport };
