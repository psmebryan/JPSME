// A URL as it may be written to the log: the values of secret-bearing query
// parameters blanked out.
//
// Some links carry a secret in the address itself: a password-reset link
// (/reset-password?uid=..&token=..) and Brevo's webhook (?token=..). Logged
// as-is, anyone who could read the server log could reset the password of
// anyone holding an unused link. Everything else in the address is kept, so
// the log still says which page was asked for.

const SECRET_PARAMS = /^(token|key|api_?key|secret|code|otp|signature|sig|password|pass|auth)$/i;

function redactUrl(url) {
  const value = String(url || '');
  const q = value.indexOf('?');
  if (q === -1) return value.slice(0, 500);
  const hashAt = value.indexOf('#', q);
  const query = value.slice(q + 1, hashAt === -1 ? undefined : hashAt);
  const cleaned = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch (err) { /* keep it raw */ }
    return eq !== -1 && SECRET_PARAMS.test(decoded) ? `${name}=[redacted]` : pair;
  }).join('&');
  return `${value.slice(0, q)}?${cleaned}`.slice(0, 500);
}

module.exports = { redactUrl };
