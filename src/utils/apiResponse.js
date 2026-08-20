/**
 * Standard JSON envelope so every API route (and the AJAX client code) shares one shape.
 */
function success(res, data = null, message = 'OK', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

function error(res, message = 'Something went wrong', statusCode = 400, errors = null) {
  return res.status(statusCode).json({ success: false, message, errors });
}

module.exports = { success, error };
