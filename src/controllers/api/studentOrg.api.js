const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const studentOrgService = require('../../services/studentOrg.service');

// Student Organization Master. Main admin only (router.use(apiAdmin) in
// admin.routes.js). Validation lives in studentOrg.service.

const pick = (b) => ({
  name: b.name,
  provinceId: b.provinceId,
  yearFounded: b.yearFounded,
  president: b.president,
  email: b.email,
  isActive: b.isActive,
});

const list = asyncHandler(async (req, res) => {
  const [organizations, provinces] = await Promise.all([
    studentOrgService.listStudentOrganizations(),
    studentOrgService.listProvinces(),
  ]);
  return success(res, { organizations, provinces });
});

const create = asyncHandler(async (req, res) => {
  const organization = await studentOrgService.createStudentOrganization(pick(req.body));
  return success(res, { organization }, `Added "${organization.name}".`, 201);
});

const update = asyncHandler(async (req, res) => {
  const b = req.body;
  // Only the fields the request carries, so the Active toggle alone does not
  // blank the rest.
  const input = Object.fromEntries(Object.entries(pick(b)).filter(([k]) => Object.prototype.hasOwnProperty.call(b, k)));
  const organization = await studentOrgService.updateStudentOrganization(req.params.id, input);
  return success(res, { organization }, `Saved "${organization.name}"${organization.isActive ? '' : ' (inactive)'}.`);
});

const listOfficers = asyncHandler(async (req, res) => {
  const officers = await studentOrgService.listOfficers(req.params.id);
  return success(res, { officers });
});

const addOfficer = asyncHandler(async (req, res) => {
  const officer = await studentOrgService.addOfficer(req.params.id, req.body);
  return success(res, { officer }, `Added ${officer.name}.`, 201);
});

const updateOfficer = asyncHandler(async (req, res) => {
  const officer = await studentOrgService.updateOfficer(req.params.id, req.params.officerId, req.body);
  return success(res, { officer }, `Saved ${officer.name}.`);
});

const removeOfficer = asyncHandler(async (req, res) => {
  const result = await studentOrgService.removeOfficer(req.params.id, req.params.officerId);
  return success(res, result, 'Officer removed.');
});

module.exports = { list, create, update, listOfficers, addOfficer, updateOfficer, removeOfficer };
