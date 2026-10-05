#!/usr/bin/env node
/**
 * Builds the spreadsheet Mergo merges from, one row per member who has never
 * activated their account, each carrying their own activation link.
 *
 *   node scripts/build-mergo-export.js --dry-run
 *   node scripts/build-mergo-export.js
 *   node scripts/build-mergo-export.js --event 7
 *
 * Why a script and not a formula in the sheet: an activation link is a bearer
 * credential. It is 32 random bytes, stored only as a salted hash, single-use,
 * and it expires. Nothing outside this app can compute one, so the links have to
 * be minted here and carried into the sheet as data.
 *
 * Three things about that are worth understanding before running it.
 *
 * ONE LIVE LINK PER ACCOUNT. issueResetLink upserts — minting a second link for
 * someone replaces the first, and the first stops working immediately. That is
 * deliberate and right for password resets, but it makes a careless re-run
 * destructive: export, merge, export again, and everyone in the first batch now
 * holds a dead link. So by default this SKIPS anyone who already has a live
 * unused link, leaves their Activation Link cell empty, and says so in the
 * Invite Status column. Pass --refresh to mint anyway, knowingly.
 *
 * THE PLAINTEXT LINK EXISTS ONLY IN THIS FILE. It cannot be re-exported, because
 * only the hash is kept. If the spreadsheet is lost, the links are not
 * recoverable — they have to be re-minted with --refresh, which invalidates the
 * ones already sent. Treat the file as a credential: it lets whoever holds it set
 * a password on any account listed in it. Delete it once the merge has gone out.
 *
 * THE LINKS EMBED APP_URL. A link built against http://localhost:3001 points at
 * the reader's own machine and is permanently useless the moment it lands in
 * somebody's inbox. This refuses to write a file in that case unless told
 * otherwise, because the mistake is invisible until it is too late to fix.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const config = require('../src/config');
const prisma = require('../src/config/prisma');
const passwordReset = require('../src/services/passwordReset.service');

function parseArgs(argv) {
  const opts = {
    out: path.join('docs', 'jpsme-mergo-invites.xlsx'),
    eventId: null,
    refresh: false,
    all: false,
    dryRun: false,
    allowLocalhost: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1];
    if (arg === '--out') { opts.out = next(); i += 1; }
    else if (arg === '--event') { opts.eventId = Number(next()); i += 1; }
    else if (arg.startsWith('--event=')) { opts.eventId = Number(arg.slice(8)); }
    else if (arg === '--refresh') { opts.refresh = true; }
    else if (arg === '--all') { opts.all = true; }
    else if (arg === '--dry-run') { opts.dryRun = true; }
    else if (arg === '--allow-localhost') { opts.allowLocalhost = true; }
    else if (arg === '--force') { opts.force = true; }
    else if (arg === '--help' || arg === '-h') { opts.help = true; }
    else {
      console.error(`Unrecognised option: ${arg}`);
      opts.bad = true;
    }
  }
  return opts;
}

function usage() {
  console.log(`
  Builds the Mergo invite spreadsheet.

    --dry-run           report what would be exported and mint nothing
    --out <path>        where to write (default docs/jpsme-mergo-invites.xlsx)
    --event <id>        add a Registered column for that event
    --refresh           re-mint links for people who already hold a live one.
                        Their existing link stops working immediately.
    --all               include members who have already activated
    --force             overwrite an existing output file (it may hold the only
                        copy of links already minted — see --refresh)
    --allow-localhost   write the file even though APP_URL is a local address
`);
}

// Organization is stored as a tree, and the sheet wants something a person
// reading it can recognise — "JPSME National > Luzon > TUP Manila", not an id.
// Cached because a chapter's ancestors are the same for all of its members.
function buildOrgPathResolver(organizations) {
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const cache = new Map();
  return function pathFor(id) {
    if (!id) return '';
    if (cache.has(id)) return cache.get(id);
    const parts = [];
    let cursor = byId.get(id);
    const seen = new Set();
    // Guarded against a cycle rather than trusting the data: a parent chain that
    // loops would otherwise hang the export with no indication why.
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parts.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
    const out = parts.join(' > ');
    cache.set(id, out);
    return out;
  };
}

function iso(date) {
  return date ? new Date(date).toISOString().slice(0, 10) : '';
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return; }
  if (opts.bad) { usage(); process.exitCode = 1; return; }

  const appUrl = config.appUrl || '';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(appUrl);

  console.log('');
  console.log('  APP_URL  ', appUrl || '(not set)');
  console.log('  links     will point at ' + (appUrl || '(nowhere)') + '/reset-password?...');
  console.log('');

  if (isLocal && !opts.allowLocalhost && !opts.dryRun) {
    console.error('  REFUSING to write the file.');
    console.error('');
    console.error(`  APP_URL is ${appUrl}, so every activation link would point at the reader's own`);
    console.error('  machine. Those links cannot be repaired after sending — the token is single-use');
    console.error('  and only its hash is stored, so a bad batch has to be re-minted, which kills');
    console.error('  every link already delivered.');
    console.error('');
    console.error('  Set APP_URL to the live site and run it again, or pass --allow-localhost if you');
    console.error('  genuinely want localhost links for a test run.');
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Checked here, BEFORE a single token is minted. Refusing to overwrite is the
  // only protection the links have: re-running is the natural thing to do, and on
  // a second run almost every row is correctly "not re-issued" with an empty
  // link, so the new file is mostly blank. Writing that over the previous one
  // destroys the only copy of links already minted, which cannot be regenerated
  // because just the hash is kept. Found by running the export twice in testing.
  //
  // The order matters as much as the check. Minting first and refusing to write
  // afterwards would be the worst outcome of all — tokens issued, every previous
  // link revoked, and the new plaintext discarded with the aborted file.
  const plannedOut = path.resolve(opts.out);
  if (!opts.dryRun && fs.existsSync(plannedOut) && !opts.force) {
    console.error(`  REFUSING to overwrite ${plannedOut}`);
    console.error('');
    console.error('  That file may hold activation links that exist nowhere else — only their hashes');
    console.error('  are stored, so overwriting it loses them for good, and the only way back is');
    console.error('  --refresh, which invalidates every link already delivered.');
    console.error('');
    console.error('  Move or delete it first, write elsewhere with --out, or pass --force if you are');
    console.error('  certain the merge for that file has already gone out.');
    console.error('');
    console.error('  Nothing was minted.');
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Only real members, never staff: an export that mints an activation link for
  // an ADMIN row would hand whoever holds the sheet a password-set link for an
  // administrator account.
  const where = { role: 'USER' };
  if (!opts.all) where.passwordSetAt = null;

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true, firstName: true, lastName: true, email: true,
      organizationId: true, status: true, passwordSetAt: true,
      emailVerifiedAt: true, createdAt: true,
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });

  if (!users.length) {
    console.log('  Nobody to invite — no member accounts are waiting for activation.');
    console.log('  (Import members first, or pass --all to include activated accounts.)');
    console.log('');
    return;
  }

  const organizations = await prisma.organization.findMany({ select: { id: true, name: true, parentId: true } });
  const orgPath = buildOrgPathResolver(organizations);

  // Read every existing token in one query rather than per row: the decision
  // below (mint, or leave the live link alone) needs this for all of them.
  const existingTokens = await prisma.passwordResetToken.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    select: { userId: true, expiresAt: true, usedAt: true, createdAt: true },
  });
  const tokenByUser = new Map(existingTokens.map((t) => [t.userId, t]));

  let event = null;
  const registrationByUser = new Map();
  if (opts.eventId) {
    event = await prisma.event.findUnique({ where: { id: opts.eventId }, select: { id: true, title: true } });
    if (!event) {
      console.error(`  No event with id ${opts.eventId}.`);
      process.exitCode = 1;
      return;
    }
    const registrations = await prisma.eventRegistration.findMany({
      where: { eventId: event.id, userId: { in: users.map((u) => u.id) } },
      select: { userId: true, status: true },
    });
    for (const r of registrations) registrationByUser.set(r.userId, r.status);
    console.log(`  Registered column reports event ${event.id}: ${event.title}`);
    console.log('');
  }

  const now = Date.now();
  const rows = [];
  const counts = { minted: 0, skipped: 0, activated: 0 };

  for (const user of users) {
    const token = tokenByUser.get(user.id);
    const liveLink = token && !token.usedAt && new Date(token.expiresAt).getTime() > now;
    const activated = user.passwordSetAt !== null;

    let link = '';
    let expires = '';
    let inviteStatus;

    if (activated) {
      inviteStatus = `Already activated ${iso(user.passwordSetAt)} — no link needed`;
      counts.activated += 1;
    } else if (liveLink && !opts.refresh) {
      // Their link is already out there and still works. Minting a new one here
      // would break the email they are holding.
      inviteStatus = `Invited ${iso(token.createdAt)}, link still valid until ${iso(token.expiresAt)} — not re-issued`;
      expires = iso(token.expiresAt);
      counts.skipped += 1;
    } else if (opts.dryRun) {
      inviteStatus = liveLink ? 'WOULD BE RE-ISSUED (current link would stop working)' : 'would be issued';
      counts.minted += 1;
    } else {
      const issued = await passwordReset.issueResetLink(user.id, { ttlMs: passwordReset.ACTIVATION_TTL_MS });
      link = issued.url;
      expires = iso(new Date(now + passwordReset.ACTIVATION_TTL_MS));
      inviteStatus = liveLink ? 're-issued, previous link revoked' : 'ready to send';
      counts.minted += 1;
    }

    rows.push({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      link,
      organization: orgPath(user.organizationId) || '(member chooses on activation)',
      activated: activated ? 'Yes' : 'No',
      expires,
      inviteStatus,
      registered: opts.eventId ? (registrationByUser.get(user.id) || 'No') : undefined,
    });
  }

  console.log(`  ${users.length} member${users.length === 1 ? '' : 's'} in scope`);
  console.log(`    links ${opts.dryRun ? 'that would be minted' : 'minted'}: ${counts.minted}`);
  console.log(`    left alone (already hold a valid link): ${counts.skipped}`);
  if (counts.activated) console.log(`    already activated: ${counts.activated}`);
  console.log('');

  if (opts.dryRun) {
    console.log('  --dry-run: nothing was minted and no file was written.');
    console.log('');
    for (const r of rows.slice(0, 10)) {
      console.log(`    ${r.email.padEnd(34)} ${r.inviteStatus}`);
    }
    if (rows.length > 10) console.log(`    ...and ${rows.length - 10} more`);
    console.log('');
    return;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invites');

  const columns = [
    { header: 'First Name', key: 'firstName', width: 18 },
    { header: 'Last Name', key: 'lastName', width: 20 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Activation Link', key: 'link', width: 72 },
    { header: 'Organization', key: 'organization', width: 38 },
    { header: 'Activated', key: 'activated', width: 11 },
    { header: 'Link Expires', key: 'expires', width: 14 },
    { header: 'Invite Status', key: 'inviteStatus', width: 52 },
  ];
  if (opts.eventId) columns.push({ header: 'Registered', key: 'registered', width: 14 });
  sheet.columns = columns;

  sheet.getRow(1).font = { bold: true };
  // Frozen, because the whole point of this sheet is scrolling a long list while
  // still knowing which column Mergo is merging.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const r of rows) sheet.addRow(r);

  // The link is data for a mail merge, not something to click in Excel — leaving
  // it as text keeps it intact when Mergo reads the cell.
  sheet.getColumn('link').alignment = { vertical: 'top' };

  // A second tab, so the person running the merge is not guessing. Kept out of
  // the Invites sheet because Mergo merges whatever rows it finds there.
  const notes = workbook.addWorksheet('How to use this');
  notes.columns = [{ width: 4 }, { width: 110 }];
  const lines = [
    'Sending these invitations with Mergo',
    '',
    `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} against ${appUrl}`,
    '',
    '1. Upload this file to Google Drive and open it with Google Sheets.',
    '2. Open Mergo from the Sheets add-ons menu, with the Invites tab active.',
    '3. Write the email in Gmail as a draft, using {{Activation Link}} and {{First Name}}',
    '   exactly as spelled in row 1 of the Invites tab.',
    `4. Send from ${config.email.from}.`,
    '',
    'Before you send',
    '',
    '- Skip any row whose Activation Link is empty. An empty link is not a mistake: that',
    '  person already holds a working link from an earlier batch, and issuing a new one',
    '  would break the email they already have. The Invite Status column says which.',
    '- Skip any row where Activated is Yes. They are already in.',
    '',
    'After you send',
    '',
    '- Each link works ONCE and expires on the date in Link Expires.',
    '- Delete this file once the merge has gone out. Every link in it sets a password on',
    '  a real account, so the sheet is a credential for as long as it exists.',
    '- Re-running the export does NOT reproduce these links. Only a hash is stored, so a',
    '  lost sheet means re-minting, which invalidates every link already delivered.',
    '',
    'What Mergo cannot do',
    '',
    '- Password resets, verification codes and event e-tickets are sent by the site itself,',
    '  automatically, seconds after someone acts. A merge is a person pressing send, so it',
    '  cannot carry those. They go out over SMTP from the same mailbox.',
  ];
  lines.forEach((text, i) => {
    const row = notes.addRow(['', text]);
    if (i === 0) row.getCell(2).font = { bold: true, size: 14 };
    else if (/^(Before you send|After you send|What Mergo cannot do)$/.test(text)) row.getCell(2).font = { bold: true };
  });

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);

  console.log(`  Written: ${outPath}`);
  console.log('');
  console.log('  Upload it to Drive, open with Google Sheets, and run Mergo on the Invites tab.');
  console.log('  Merge fields are the row 1 headers: {{First Name}}, {{Activation Link}}.');
  console.log('');
  console.log('  This file now contains live activation links. Delete it once the merge is sent.');
  console.log('');
}

main()
  .catch((err) => {
    console.error('');
    console.error('  Export failed:', err && err.message ? err.message : err);
    console.error('');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
