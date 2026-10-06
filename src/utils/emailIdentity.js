// Finding an account by the address somebody typed.
//
// WHY THIS EXISTS
//
// The auth forms used express-validator's normalizeEmail() with its defaults,
// which for Gmail REMOVES DOTS AND +TAGS: "juan.dela.cruz@gmail.com" became
// "juandelacruz@gmail.com" before anything looked it up. Accounts created by
// signing up were stored in that shortened form, so they matched. Accounts
// created by the member import were stored as typed, dots and all, so their
// owners got "Invalid email or password" with the right password, and
// "forgot password" quietly found nobody and sent nothing.
//
// Gmail delivers both spellings to the same inbox, so they are the same person.
// The forms now only trim and lowercase, and lookups go through findUserByEmail,
// which accepts either spelling: the exact address first, then the Gmail
// equivalent of what was typed.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Trim and lowercase. What the forms store and look up now.
function cleanEmail(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

// The inbox an address delivers to. For Gmail that ignores dots and anything
// after "+"; every other provider is left alone, because elsewhere a dot or a
// +tag can be part of a different mailbox.
function canonicalEmail(value) {
  const email = cleanEmail(value);
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return email;
  return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
}

// The account for a typed address, or null.
//
// Exact match first, so an address that is stored exactly as typed never
// depends on the fallback. Then, for Gmail only, every stored Gmail address
// whose inbox is the same. Exactly one such account is required: if two
// accounts share an inbox, guessing between them could sign somebody into the
// wrong one, so it is treated as not found.
//
// `query` is passed through to findUnique (select / include).
async function findUserByEmail(prisma, typed, query = {}) {
  const email = cleanEmail(typed);
  if (!email) return null;

  const exact = await prisma.user.findUnique({ where: { email }, ...query });
  if (exact) return exact;

  const canonical = canonicalEmail(email);
  if (!canonical.endsWith('@gmail.com')) return null;

  // Gmail addresses only, then compared in JS. Two LIKEs rather than one
  // pattern so the googlemail.com spelling is covered too.
  const candidates = await prisma.user.findMany({
    where: { OR: [{ email: { endsWith: '@gmail.com' } }, { email: { endsWith: '@googlemail.com' } }] },
    select: { id: true, email: true },
  });
  const matches = candidates.filter((u) => canonicalEmail(u.email) === canonical);
  if (matches.length !== 1) return null;

  return prisma.user.findUnique({ where: { id: matches[0].id }, ...query });
}

module.exports = { cleanEmail, canonicalEmail, findUserByEmail };
