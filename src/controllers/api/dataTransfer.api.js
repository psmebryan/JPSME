const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const dataExportService = require('../../services/dataExport.service');
const dataImportService = require('../../services/dataImport.service');

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

// Reports what an import would change, without writing anything. The admin UI
// always runs this first so the result can be read before committing.
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'Choose an .xlsx workbook to import', 400);
  const plan = await dataImportService.analyze(req.file.buffer);
  return success(res, plan);
});

const runImport = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'Choose an .xlsx workbook to import', 400);
  const result = await dataImportService.applyImport(req.file.buffer);
  const { applied } = result;
  return success(
    res,
    result,
    `Imported: ${applied.created} organization(s) created, ${applied.updated} updated, ${applied.membersUpdated} member(s) updated.`
  );
});

module.exports = { exportWorkbook, previewImport, runImport };
