const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const memberTypeService = require('../../services/memberType.service');

// The Master List's member types. Main admin only (router.use(apiAdmin) in
// admin.routes.js). The service does the validation: a name of 1-60
// characters, unique, an amount from 0 to 1,000,000, validity 1 to 99 years or lifetime.
// The channel fee is PayMongo's rate from Site Settings, not set here.

const list = asyncHandler(async (req, res) => {
  const memberTypes = await memberTypeService.listMemberTypes();
  return success(res, { memberTypes });
});

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  const memberType = await memberTypeService.createMemberType({
    name: b.name, membershipFee: b.membershipFee, isActive: b.isActive,
    renewable: b.renewable, validityYears: b.validityYears,
  });
  return success(res, { memberType }, `Added "${memberType.name}".`, 201);
});

const update = asyncHandler(async (req, res) => {
  const b = req.body;
  const memberType = await memberTypeService.updateMemberType(req.params.id, {
    name: b.name, membershipFee: b.membershipFee, isActive: b.isActive, sortOrder: b.sortOrder,
    renewable: b.renewable, validityYears: b.validityYears,
  });
  return success(res, { memberType }, `Saved "${memberType.name}"${memberType.isActive ? '' : ' (switched off)'}.`);
});

const remove = asyncHandler(async (req, res) => {
  const result = await memberTypeService.deleteMemberType(req.params.id);
  return success(res, result,
    `Removed. ${result.membersCleared} member(s) now have no type and will choose one when they next avail membership.`);
});

module.exports = { list, create, update, remove };
