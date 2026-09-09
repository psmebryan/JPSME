const bcrypt = require('bcryptjs');

// Creates or promotes the ADMIN account, from environment variables.
//
// Nothing in the running application can grant ADMIN — user.service.js refuses
// it outright, and the admin UI has no field for it. That is deliberate: the
// role can read every member's personal details, every payment, and export the
// lot, so it must not be reachable through a form that a session hijack or a
// mistaken click could drive. The trade-off is that a managed host with no
// shell has no way to create the first admin at all.
//
// So this exists, gated the same way RUN_MIGRATIONS_ON_BOOT is: it does nothing
// unless someone who can set environment variables says otherwise. That is a
// higher bar than any in-app path, since it needs the hosting account rather
// than a browser session.
//
// Turn the flag off once the account exists. Left on, every restart re-applies
// the same credentials — which also means a password rotated later would be
// silently reverted on the next deploy.

function envFlag(name) {
  const raw = process.env[name];
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().replace(/^["']|["']$/g, '').toLowerCase());
}

// Names are stored uppercase throughout (auth.service.js, user.service.js), so
// an account seeded here has to match or it sorts oddly in the admin list and
// reads differently from every account created by registration.
const normalizeName = (value) => String(value || '').trim().toUpperCase();

async function seedAdminIfRequested(prisma, log = console) {
  if (!envFlag('SEED_ADMIN_ON_BOOT')) return null;

  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    // Refused rather than defaulted. Inventing an address here would create an
    // admin account nobody asked for and nobody is watching.
    log.error(
      'SEED_ADMIN_ON_BOOT is set but SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are not both present — no admin was created.'
    );
    return null;
  }

  if (String(password).length < 8) {
    log.error('SEED_ADMIN_PASSWORD is shorter than 8 characters — refusing to create an admin with it.');
    return null;
  }

  const hashed = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });

  // Names are optional: promoting an existing member should keep the name they
  // registered with, not overwrite it with a placeholder. They are only used
  // when there is no account yet and something has to be written.
  const firstName = normalizeName(process.env.SEED_ADMIN_FIRST_NAME) || 'SITE';
  const lastName = normalizeName(process.env.SEED_ADMIN_LAST_NAME) || 'ADMIN';
  const middleInitial = normalizeName(process.env.SEED_ADMIN_MIDDLE_INITIAL).slice(0, 2) || null;

  const admin = existing
    ? await prisma.user.update({
      where: { email },
      data: {
        role: 'ADMIN',
        status: 'APPROVED',
        emailVerifiedAt: new Date(),
        password: hashed,
      },
    })
    : await prisma.user.create({
      data: {
        firstName,
        middleInitial,
        lastName,
        email,
        password: hashed,
        role: 'ADMIN',
        status: 'APPROVED',
        // Set, so the account is usable immediately. The alternative is an
        // admin who cannot log in until an email provider cooperates — which
        // is exactly the situation this function exists to rescue.
        emailVerifiedAt: new Date(),
        // Left null on purpose: a national admin is not a member of one
        // student unit, and attaching them to one would scope reports and
        // listings that are meant to span everything.
        organizationId: null,
      },
    });

  // The password is never logged, here or anywhere. Whoever set the variable
  // already knows it, and a deploy log is not a place to publish one.
  log.log(
    existing
      ? `Admin ready: ${admin.email} (existing account promoted from ${existing.role}, password reset)`
      : `Admin ready: ${admin.email} (new account created)`
  );
  log.log('  Set SEED_ADMIN_ON_BOOT to "false" now — leaving it on re-applies these credentials on every restart.');

  return admin;
}

module.exports = { seedAdminIfRequested };
