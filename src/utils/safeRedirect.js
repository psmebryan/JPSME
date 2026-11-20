// Where the site may send someone after signing in or registering (?next=).
//
// Only a path on this site. "Starts with / but not //" is not enough: browsers
// read a backslash as a slash and drop tabs and newlines, so "/\evil.com" or
// "/<tab>/evil.com" lands on evil.com, which would make a link to our own login
// page a way to send a member somewhere else right after they signed in.
// public/js/auth.js applies the same rule in the browser.

function safeRedirectPath(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // Backslashes, whitespace and control characters anywhere.
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  // The last word: resolved against this site, it must still be this site.
  try {
    const base = 'https://jpsme.invalid';
    if (new URL(value, base).origin !== base) return null;
  } catch (err) {
    return null;
  }
  return value;
}

module.exports = { safeRedirectPath };
