const config = require('../config');

// Turns a whole feature's routes into a 404 while its switch is off, so a
// hidden feature is not merely unlinked but unreachable by typing the URL.
// A 404 rather than a 403: "this does not exist here" is the truth for this
// release, and says nothing about what could be switched on.
function requireSeatingFeature(req, res, next) {
  if (config.seatingFeature) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'Not found', errors: null, code: null });
  }
  return res.status(404).render('404', { title: 'Not Found', layout: 'layout' });
}

module.exports = { requireSeatingFeature };
