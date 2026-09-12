const path = require('path');
const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const authService = require('../../services/auth.service');
const emailVerificationService = require('../../services/emailVerification.service');
const storageService = require('../../services/storage.service');
const logger = require('../../utils/logger');

// How long a correct password stays good as one half of the proof needed to
// finish verification and be signed in.
//
// Deliberately much longer than a code's own three minutes, because it has to
// survive several of them: a code that expires is replaced by pressing Send it
// again, and that must not also mean signing in from the top. Thirty minutes
// covers roughly ten of those cycles, which is far past the point where the
// problem is the email rather than the person.
const PASSWORD_PROOF_TTL_MS = 30 * 60 * 1000;

// Long enough that a double-click doesn't send two emails, short enough that
// somebody whose code genuinely didn't arrive isn't left staring at a counter.
const RESEND_COOLDOWN_MS = 60 * 1000;

// Where a freshly signed-in member lands. Deliberately the same order the
// login page uses (see public/js/auth.js) — a member who verified and one who
// logged in normally have not done anything different.
function landingFor(user) {
  const next = user.postApprovalRedirectUrl;
  // Same-site only, the same guard as everywhere else this value is honored.
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) return next;
  return user.isFirstLogin ? '/profile' : '/';
}

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

  let user;
  try {
    user = await authService.login(email, password, { context });
  } catch (err) {
    // A correct password against an unverified address is not a failed login
    // so much as an unfinished one, and the next step needs a code. Sending it
    // here rather than making them go and ask for it is the whole point: it
    // happens after bcrypt has agreed, so it cannot be aimed at an inbox the
    // sender does not own, which is what lets it skip the captcha that used to
    // stand between somebody and their second code.
    if (err && err.code === 'EMAIL_NOT_VERIFIED') {
      try {
        const pending = await emailVerificationService.prepareVerification(email);
        if (pending) {
          req.session.pendingVerification = {
            userId: pending.userId,
            email: pending.email,
            sentAt: pending.sentAt,
            // What the page counts down to. Read back from the row rather than
            // assumed, so the clock on screen and the one the server checks
            // against are the same clock.
            expiresAt: pending.expiresAt,
            // The password was right. Remembering that — briefly, and only in
            // this session — is what lets the code alone finish the job.
            passwordProvenAt: Date.now(),
          };
        }
      } catch (sendErr) {
        // Swallowed on purpose. The refusal below is the answer to this
        // request; replacing it with a 500 would hide the reason they were
        // turned away and send them nowhere, over a code they can still ask
        // for by hand on the verification page.
        logger.error('login: could not prepare a verification code', { err: sendErr.message });
      }
    }
    throw err;
  }

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

  const publicPath = await storageService.saveUpload(req.file.buffer, {
    folder: 'profile',
    prefix: 'profile',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  const user = await authService.updateProfileImage(req.session.user.id, publicPath);
  req.session.user = user;
  return success(res, { user, profileImage: publicPath }, 'Profile image updated successfully');
});

const resendVerification = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  await emailVerificationService.resendVerification(req.body.email);
  // Same response whether or not the email exists/is already verified, to prevent enumeration.
  //
  // The second sentence gives a real person the one thing the vague first
  // sentence cannot: what to do when no code arrives because there was nothing
  // to send. It leaks nothing — it is said to everybody, so it distinguishes
  // no address from any other. Without it, an already-verified account looks
  // exactly like broken email, which is how this endpoint got reported as a
  // bug when it was working correctly.
  return success(res, null, 'If that email needs verifying, a new code is on its way. Already verified? You can just log in.');
});

// Sends another code to an account the session already knows is waiting on
// one. No address in the request, so there is nothing to enumerate and nobody
// else to mail — the reason this one needs no captcha where the public
// resend below does.
const resendPendingVerification = asyncHandler(async (req, res) => {
  const pending = req.session.pendingVerification;
  if (!pending || !pending.userId) {
    return error(
      res,
      'That took a while — please sign in again and we will send you a new code.',
      403,
      null,
      'NO_PENDING_VERIFICATION'
    );
  }

  const waited = Date.now() - (pending.sentAt || 0);
  if (waited < RESEND_COOLDOWN_MS) {
    const seconds = Math.ceil((RESEND_COOLDOWN_MS - waited) / 1000);
    return error(res, `A code is already on its way. You can ask for another in ${seconds}s.`, 429);
  }

  const outcome = await emailVerificationService.resendForPending(pending.userId);
  if (!outcome.sent) {
    // Said plainly rather than hidden behind a cheerful "sent!". The public
    // resend has to stay vague to avoid confirming an address exists; this one
    // is answering somebody whose account we already identified, so there is
    // nothing left to protect by lying to them.
    return error(res, 'We could not send the email just now. Please try again in a moment.', 502);
  }

  req.session.pendingVerification = { ...pending, sentAt: outcome.sentAt, expiresAt: outcome.expiresAt };
  return success(
    res,
    {
      // A duration, not a timestamp — the same reason the page is rendered
      // with one. A phone whose clock is ten minutes out would otherwise
      // count down to a moment that has already passed, or never arrives.
      expiresInMs: Math.max(0, outcome.expiresAt - Date.now()),
      cooldownMs: RESEND_COOLDOWN_MS,
    },
    'A new code is on its way.'
  );
});

// Confirms an address from the six-digit code that was emailed. Takes the
// email too: that is what makes a short code workable, since a guess has to be
// aimed at one named account rather than sprayed across every account at once.
//
// Every failure inside the service returns the same message, so this endpoint
// cannot be used to find out whether an address is registered.
const verifyEmailCode = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  const verified = await emailVerificationService.verifyEmailCode(req.body.email, req.body.code);

  // Two answers in the other order. Logging in proved the password and then
  // asked for the code; this proved the code and the password is already
  // proven, in this same session, minutes ago. Asking them to go back to the
  // login form and type it a second time adds a step and no security.
  const pending = req.session.pendingVerification;
  const proven = pending
    && pending.userId === verified.id
    && Date.now() - (pending.passwordProvenAt || 0) < PASSWORD_PROOF_TTL_MS;
  delete req.session.pendingVerification;

  // Wrapped because the verification is already committed by this point. A
  // failure here is a failure of the shortcut, and reporting it as a failed
  // verification would send somebody round a loop they have already finished —
  // where the code they hold no longer works, because it was consumed.
  let signedIn = null;
  if (proven) {
    try {
      signedIn = await authService.completeVerifiedLogin(verified.id);
    } catch (loginErr) {
      logger.error('verify-code: verified, but could not sign them in', { err: loginErr.message });
    }
  }

  if (!signedIn) {
    return success(res, { loggedIn: false }, 'Your email is verified. You can log in now.');
  }

  // Same fixation guard as the login route — this is a privilege change.
  return req.session.regenerate((err) => {
    if (err) {
      // The verification itself stands; only the shortcut failed.
      return success(res, { loggedIn: false }, 'Your email is verified. You can log in now.');
    }
    req.session.user = signedIn;
    return success(
      res,
      { loggedIn: true, user: signedIn, redirectTo: landingFor(signedIn) },
      'Email verified — signing you in.'
    );
  });
});

module.exports = {
  register,
  login,
  logout,
  me,
  updateProfile,
  uploadProfileImage,
  resendVerification,
  resendPendingVerification,
  verifyEmailCode,
};