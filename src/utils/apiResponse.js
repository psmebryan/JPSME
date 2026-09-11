/**
 * Standard JSON envelope so every API route (and the AJAX client code) shares one shape.
 */
function success(res, data = null, message = 'OK', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

// `code` is the same tag AppError carries and app.js's handler already emits,
// so a caller can branch on the reason rather than on the wording of a
// sentence. Null on every existing call, which is exactly what the client
// already reads (see api.js: `payload.code || null`).
function error(res, message = 'Something went wrong', statusCode = 400, errors = null, code = null) {
  return res.status(statusCode).json({ success: false, message, errors, code });
}

module.exports = { success, error };
