// Shared helpers for admin-authored {{token}} templates (certificate text,
// email subject/body) — used by certificate.service.js and mail.service.js.

// Substitutes {{token}} placeholders (e.g. {{fullName}}) with actual values.
function substituteTokens(text, fields) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => (
    fields[key] !== undefined && fields[key] !== null ? String(fields[key]) : ''
  ));
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fullName(user) {
  const mi = user.middleInitial ? ` ${user.middleInitial}.` : '';
  return `${user.firstName}${mi} ${user.lastName}`;
}

module.exports = { substituteTokens, formatDate, fullName };
