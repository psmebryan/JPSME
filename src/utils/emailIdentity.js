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
// The common case is one query: the exact address, already activated. Gmail
// addresses otherwise look at every account on the same inbox, because the bug
// left some members with two — the account they made by signing up (stored
// without dots, activated, holding their registrations) and one the import made
// later (stored with dots, never activated). Typing the dotted address must
// reach the account they actually use, not the empty duplicate, so:
//
//   one account on the inbox          that one
//   exactly one of them activated     the activated one
//   none activated                    the exact spelling, if there is one
//   several activated                 the exact spelling, if it is one of them
//   anything else                     not found — guessing between accounts
//                                     could sign somebody into the wrong one
//
// `query` is passed through to the final findUnique (select / include).
async function findUserByEmail(prisma, typed, query = {}) {
  const email = cleanEmail(typed);
  if (!email) return null;

  const exact = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordSetAt: true },
  });
  const canonical = canonicalEmail(email);
  const isGmail = canonical.endsWith('@gmail.com');

  let chosen = null;
  if (exact && (exact.passwordSetAt || !isGmail)) {
    chosen = exact;
  } else if (isGmail) {
    // Gmail addresses only, then compared in JS. Two endings so the
    // googlemail.com spelling is covered too.
    const gmailUsers = await prisma.user.findMany({
      where: { OR: [{ email: { endsWith: '@gmail.com' } }, { email: { endsWith: '@googlemail.com' } }] },
      select: { id: true, email: true, passwordSetAt: true },
    });
    const sameInbox = gmailUsers.filter((u) => canonicalEmail(u.email) === canonical);
    const activated = sameInbox.filter((u) => u.passwordSetAt);
    if (sameInbox.length === 1) chosen = sameInbox[0];
    else if (activated.length === 1) chosen = activated[0];
    else if (activated.length === 0) chosen = exact;
    else chosen = (exact && activated.find((u) => u.id === exact.id)) || null;
  }

  if (!chosen) return null;
  return prisma.user.findUnique({ where: { id: chosen.id }, ...query });
}

module.exports = { cleanEmail, canonicalEmail, findUserByEmail };
