const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const authService = require('../../services/auth.service');
const emailVerificationService = require('../../services/emailVerification.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

const register = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  const user = await authService.registerUser(req.body);
  return success(
    res,
    { user },
    'Registration submitted. Check your email to verify your address; an admin will also need to approve your account.',
    201
  );
});

const login = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  const { email, password, context } = req.body;
  const user = await authService.login(email, password, { context });

  // Regenerate the session on privilege change to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return error(res, 'Login failed, please try again', 500);
    req.session.user = user;
    return success(res, { user }, 'Logged in successfully');
  });
});

const logout = asyncHandler(async (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('jpsme.sid');
    return success(res, null, 'Logged out');
  });
});

const me = asyncHandler(async (req, res) => {
  const user = await authService.getById(req.session.user.id);
  return success(res, { user });
});

const updateProfile = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  const user = await authService.updateProfile(req.session.user.id, req.body);
  req.session.user = user;
  return success(res, { user }, 'Profile updated successfully');
});

const uploadProfileImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    return error(res, 'No profile image uploaded', 400);
  }

  const publicPath = `/uploads/profile/${req.file.filename}`;
  const user = await authService.updateProfileImage(req.session.user.id, publicPath);
  req.session.user = user;
  return success(res, { user, profileImage: publicPath }, 'Profile image updated successfully');
});

const resendVerification = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  await emailVerificationService.resendVerification(req.body.email);
  // Same response whether or not the email exists/is already verified, to prevent enumeration.
  return success(res, null, 'If that email exists and needs verification, a new link has been sent.');
});

module.exports = { register, login, logout, me, updateProfile, uploadProfileImage, resendVerification };