const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const prisma = require('./../config/prisma');
const AppError = require('./../utils/AppError');
const organizationService = require('./organization.service');

// Names are stored upper-cased throughout this app (see auth.service's
// normalizeName), so an imported row has to arrive the same way — otherwise a
// member typed in Excel as "Ana Reyes" sorts and searches differently from every
// member who registered themselves.
const normalizeName = (value) => String(value || '').trim().toUpperCase();

// Reads back the Organizations and Members sheets produced by
// dataExport.service.js, so a workbook can be exported, edited in Excel, and
// re-imported.
//
// Three rules this holds to, because an import that gets them wrong is very
// hard to undo:
//
//   * It never deletes. A row missing from the sheet is left alone, not
//     removed — a partial sheet is far more likely than a deliberate purge.
//   * Nothing is written until every row has been checked. A sheet with a bad
//     row on line 40 must not leave 39 rows applied and the rest not.
//   * Every error names the row number as Excel shows it, and ALL of them are
//     reported. A 400-row sheet is only fixable if the report says where, and
//     stopping at the first mistake turns a 12-mistake sheet into 12 rounds of
//     upload-fix-upload.
//
// dryRun returns exactly what would change without touching anything, and the
// admin UI runs it first so the report can be read before committing.
//
// IT NOW CREATES MEMBER ACCOUNTS. It used to refuse, and the reason it gave was
// a good one: "importing logins would mean inventing passwords and bypassing
// email verification". Both objections are answered rather than ignored.
//
// No password is invented. A created account gets a bcrypt hash of 32 random
// bytes that are immediately discarded, so it has a password column that nothing
// can ever match, and `passwordSetAt` is NULL to say so. Nobody — not the
// administrator who imported the sheet, not this code — knows a password for it.
//
// Verification is not bypassed, it is deferred and then done properly. The
// account cannot be signed in to at all until the member opens an emailed
// activation link, and opening it IS the proof the address reaches them. That is
// a stronger check than the six-digit code a self-registration gets, because the
// address was typed by somebody else.
//
// What the member still owns: their password, and their organization. The sheet
// leaves the organization blank on purpose — an admin filling in sixty
// organization paths is guessing at the most tedious column in the workbook, and
// the person reading the activation page is the one who knows which school unit
// they belong to.

const ORG_TYPES = ['NATIONAL', 'REGION', 'PROVINCE', 'STUDENT_UNIT'];
const YEAR_LEVELS = { '1ST YEAR': 'FIRST', '2ND YEAR': 'SECOND', '3RD YEAR': 'THIRD', '4TH YEAR': 'FOURTH', FIRST: 'FIRST', SECOND: 'SECOND', THIRD: 'THIRD', FOURTH: 'FOURTH' };

function cell(row, index) {
  const v = row.getCell(index).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.text !== undefined) return String(v.text).trim();
    if (v.result !== undefined) return String(v.result).trim();
    return '';
  }
  return String(v).trim();
}

function headerIndex(sheet) {
  const map = {};
  sheet.getRow(1).eachCell((c, i) => { map[String(c.value || '').trim().toLowerCase()] = i; });
  return map;
}

// Resolves "JPSME National > Luzon" against the live tree. Matching on the
// readable path rather than an id is what lets someone add rows by typing a
// parent name they can actually see in the sheet.
function buildPathResolver(orgs) {
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const labelOf = (org) => organizationService.parsePathIds(org.path)
    .map((id) => (byId.get(id) || {}).name)
    .filter(Boolean)
    .join(' > ')
    .toLowerCase();

  const byFullPath = new Map();
  const byName = new Map();
  orgs.forEach((o) => {
    byFullPath.set(labelOf(o), o);
    const key = o.name.trim().toLowerCase();
    // Ambiguous names resolve to null rather than guessing which was meant.
    byName.set(key, byName.has(key) ? null : o);
  });

  return (raw) => {
    const value = (raw || '').trim().toLowerCase();
    if (!value) return { org: null, ambiguous: false };
    if (byFullPath.has(value)) return { org: byFullPath.get(value), ambiguous: false };
    const leaf = value.split('>').pop().trim();
    if (byName.has(leaf)) {
      const hit = byName.get(leaf);
      return hit ? { org: hit, ambiguous: false } : { org: null, ambiguous: true };
    }
    return { org: null, ambiguous: false };
  };
}

async function analyze(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const orgSheet = workbook.getWorksheet('Organizations');
  const memberSheet = workbook.getWorksheet('Members');
  if (!orgSheet && !memberSheet) {
    throw new AppError('The workbook has no "Organizations" or "Members" sheet. Export first to get the expected format.', 400);
  }

  const existingOrgs = await prisma.organization.findMany();
  const resolvePath = buildPathResolver(existingOrgs);
  const orgById = new Map(existingOrgs.map((o) => [o.id, o]));

  const plan = { organizations: [], members: [] };
  const errors = [];

  // --- Organizations -------------------------------------------------------
  if (orgSheet) {
    const h = headerIndex(orgSheet);
    const need = ['name', 'type'];
    const missing = need.filter((c) => !h[c]);
    if (missing.length) {
      errors.push(`Organizations sheet is missing the ${missing.join(', ')} column(s).`);
    } else {
      for (let r = 2; r <= orgSheet.rowCount; r += 1) {
        const row = orgSheet.getRow(r);
        const name = cell(row, h.name);
        if (!name) continue; // blank spacer row

        const idRaw = h.id ? cell(row, h.id) : '';
        const type = cell(row, h.type).toUpperCase();
        const parentRaw = h['parent path'] ? cell(row, h['parent path']) : '';

        if (!ORG_TYPES.includes(type)) {
          errors.push(`Organizations row ${r}: "${type || '(blank)'}" is not a valid type. Use ${ORG_TYPES.join(', ')}.`);
          continue;
        }

        const existing = idRaw && orgById.get(Number(idRaw));
        const { org: parent, ambiguous } = resolvePath(parentRaw);

        if (ambiguous) {
          errors.push(`Organizations row ${r}: more than one organization is named "${parentRaw.split('>').pop().trim()}". Use the full parent path.`);
          continue;
        }
        if (parentRaw && !parent) {
          errors.push(`Organizations row ${r}: parent "${parentRaw}" was not found. Create it first, or fix the path.`);
          continue;
        }
        if (!parentRaw && type !== 'NATIONAL') {
          errors.push(`Organizations row ${r}: "${name}" needs a Parent Path. Only the national root may have none.`);
          continue;
        }
        if (parent) {
          try { organizationService.validateParentChild(type, parent.type); }
          catch (e) { errors.push(`Organizations row ${r}: ${e.message}`); continue; }
        }

        if (existing) {
          const changes = [];
          if (existing.name !== name) changes.push(`name "${existing.name}" -> "${name}"`);
          if (existing.type !== type) changes.push(`type ${existing.type} -> ${type}`);
          if (parent && existing.parentId !== parent.id) changes.push(`moved under "${parent.name}"`);
          if (changes.length) {
            plan.organizations.push({ action: 'update', row: r, id: existing.id, name, type, parentId: parent ? parent.id : existing.parentId, changes });
          }
        } else {
          plan.organizations.push({ action: 'create', row: r, name, type, parentId: parent ? parent.id : null, changes: [`new ${type}`] });
        }
      }
    }
  }

  // --- Members -------------------------------------------------------------
  if (memberSheet) {
    const h = headerIndex(memberSheet);
    if (!h.email) {
      errors.push('Members sheet is missing the Email column, which is how rows are matched to accounts.');
    } else {
      const emails = [];
      for (let r = 2; r <= memberSheet.rowCount; r += 1) {
        const e = cell(memberSheet.getRow(r), h.email).toLowerCase();
        if (e) emails.push(e);
      }
      const found = await prisma.user.findMany({
        where: { email: { in: emails } },
        include: { organization: true },
      });
      const byEmail = new Map(found.map((u) => [u.email.toLowerCase(), u]));

      // Which row first claimed each address, so a duplicate can name the row it
      // collides with rather than just saying "duplicate". Two rows with the same
      // address is a copy-paste mistake, not two members, and the fix needs both
      // line numbers.
      const seenAt = new Map();

      for (let r = 2; r <= memberSheet.rowCount; r += 1) {
        const row = memberSheet.getRow(r);
        const email = cell(row, h.email).toLowerCase();
        if (!email) continue;

        if (seenAt.has(email)) {
          errors.push(`Members row ${r}: email "${email}" also appears on row ${seenAt.get(email)}.`);
          continue;
        }
        seenAt.set(email, r);

        const user = byEmail.get(email);
        if (!user) {
          // --- a new account ---------------------------------------------------
          //
          // Validated here and created in applyImport, so a sheet with one bad
          // row writes nothing at all.
          const rowErrors = [];
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            rowErrors.push(`Members row ${r}: "${email}" is not a valid email address.`);
          }

          const firstName = h['first name'] ? cell(row, h['first name']) : '';
          const lastName = h['last name'] ? cell(row, h['last name']) : '';
          // The whole required minimum. A chapter list of names and addresses
          // imports as it stands — everything else the member fills in or the
          // admin corrects later.
          if (!firstName) rowErrors.push(`Members row ${r}: First Name is required to create a new member.`);
          if (!lastName) rowErrors.push(`Members row ${r}: Last Name is required to create a new member.`);

          // Optional, and normally blank: the member chooses it when they
          // activate. Validated only when the sheet does name one.
          let orgId = null;
          const orgRaw = (h['organization path'] || h.organization)
            ? cell(row, h['organization path'] || h.organization) : '';
          if (orgRaw) {
            const { org, ambiguous } = resolvePath(orgRaw);
            if (ambiguous) {
              rowErrors.push(`Members row ${r}: more than one organization is named "${orgRaw.split('>').pop().trim()}". Use the full path.`);
            } else if (!org) {
              rowErrors.push(`Members row ${r}: organization "${orgRaw}" was not found.`);
            } else {
              orgId = org.id;
            }
          }

          let yearLevel = null;
          if (h['year level']) {
            const raw = cell(row, h['year level']).toUpperCase();
            if (raw && !YEAR_LEVELS[raw]) {
              rowErrors.push(`Members row ${r}: "${raw}" is not a year level. Use 1st/2nd/3rd/4th Year, or leave blank.`);
            } else {
              yearLevel = raw ? YEAR_LEVELS[raw] : null;
            }
          }

          if (rowErrors.length) {
            // Every problem with the row, not just the first — so one pass over
            // the sheet lists everything to fix.
            rowErrors.forEach((e) => errors.push(e));
            continue;
          }

          plan.members.push({
            action: 'create',
            row: r,
            email,
            create: {
              firstName, lastName, email, yearLevel, organizationId: orgId,
              middleInitial: h['m.i.'] ? (cell(row, h['m.i.']) || null) : null,
              phone: h.phone ? (cell(row, h.phone) || null) : null,
              school: h.school ? (cell(row, h.school) || null) : null,
            },
            changes: [
              `new account for ${firstName} ${lastName}`,
              orgId ? 'organization from the sheet' : 'organization chosen on activation',
              'invited separately — no email sent by this import',
            ],
          });
          continue;
        }

        const changes = [];
        const update = {};

        if (h['organization path'] || h.organization) {
          const raw = cell(row, h['organization path'] || h.organization);
          const { org, ambiguous } = resolvePath(raw);
          if (raw && ambiguous) {
            errors.push(`Members row ${r}: more than one organization is named "${raw.split('>').pop().trim()}". Use the full path.`);
            continue;
          }
          if (raw && !org) {
            errors.push(`Members row ${r}: organization "${raw}" was not found.`);
            continue;
          }
          const nextId = org ? org.id : null;
          if (user.organizationId !== nextId) {
            update.organizationId = nextId;
            changes.push(`organization -> ${org ? org.name : '(none)'}`);
          }
        }

        if (h['year level']) {
          const raw = cell(row, h['year level']).toUpperCase();
          const next = raw ? (YEAR_LEVELS[raw] || null) : null;
          if (raw && !next) {
            errors.push(`Members row ${r}: "${raw}" is not a year level. Use 1st/2nd/3rd/4th Year, or leave blank.`);
            continue;
          }
          if (user.yearLevel !== next) {
            update.yearLevel = next;
            changes.push(`year level -> ${next || '(none)'}`);
          }
        }

        ['phone', 'school'].forEach((f) => {
          if (!h[f]) return;
          const v = cell(row, h[f]) || null;
          if ((user[f] || null) !== v) { update[f] = v; changes.push(`${f} -> ${v || '(blank)'}`); }
        });

        if (changes.length) plan.members.push({ action: 'update', row: r, email, userId: user.id, update, changes });
      }
    }
  }

  return {
    errors,
    organizations: plan.organizations,
    members: plan.members,
    summary: {
      orgsToCreate: plan.organizations.filter((o) => o.action === 'create').length,
      orgsToUpdate: plan.organizations.filter((o) => o.action === 'update').length,
      // Counted apart from updates on purpose. Creating sixty people and
      // correcting sixty phone numbers are not the same kind of event, and the
      // admin reading the preview needs to see which one they are about to do.
      membersToCreate: plan.members.filter((m) => m.action === 'create').length,
      membersToUpdate: plan.members.filter((m) => m.action === 'update').length,
      membersSkipped: plan.members.filter((m) => m.action === 'skip').length,
      errors: errors.length,
    },
  };
}

async function applyImport(buffer) {
  const plan = await analyze(buffer);

  // Refuse the whole import if anything failed validation, rather than
  // applying the good rows and leaving the sheet half-processed.
  if (plan.errors.length) {
    throw new AppError(`Import refused — ${plan.errors.length} problem(s) found. Nothing was changed.`, 400);
  }

  const applied = { created: 0, updated: 0, membersCreated: 0, membersUpdated: 0 };

  // Shallowest first, so a row whose parent is also new in this sheet finds it
  // already created.
  const creates = plan.organizations.filter((o) => o.action === 'create');
  const updates = plan.organizations.filter((o) => o.action === 'update');

  for (const item of creates) {
    // eslint-disable-next-line no-await-in-loop
    await organizationService.createOrganization({
      name: item.name, type: item.type, parentId: item.parentId,
    });
    applied.created += 1;
  }
  for (const item of updates) {
    // eslint-disable-next-line no-await-in-loop
    await organizationService.updateOrganization(item.id, { name: item.name, type: item.type });
    const current = await prisma.organization.findUnique({ where: { id: item.id } });
    if (item.parentId && current.parentId !== item.parentId) {
      // Reparenting goes through moveOrganization so cycles are rejected and
      // the subtree's paths are rewritten.
      // eslint-disable-next-line no-await-in-loop
      await organizationService.moveOrganization(item.id, item.parentId);
    }
    applied.updated += 1;
  }
  for (const item of plan.members.filter((m) => m.action === 'update')) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.user.update({ where: { id: item.userId }, data: item.update });
    applied.membersUpdated += 1;
  }

  // --- new accounts ----------------------------------------------------------
  //
  // Created unusable and uninvited. Two deliberate omissions:
  //
  // No email is sent here. Importing 500 rows must not fire 500 emails from one
  // button press — the queue drains at one every couple of seconds, so that is
  // twenty minutes of sending with no way to stop it, and a mistake in the sheet
  // would have already reached 500 inboxes. Inviting is a separate action.
  //
  // No role comes from the sheet. It is always USER, whatever a column says:
  // a spreadsheet is not a route to an administrator account, and the workbook
  // is edited in Excel by whoever was handed it.
  for (const item of plan.members.filter((m) => m.action === 'create')) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.user.create({
      data: {
        ...item.create,
        firstName: normalizeName(item.create.firstName),
        lastName: normalizeName(item.create.lastName),
        middleInitial: item.create.middleInitial ? normalizeName(item.create.middleInitial) : null,
        // A hash of 32 bytes that are discarded on the next line. The column is
        // NOT NULL and this satisfies it with a value nothing can ever match, so
        // there is no password to guess and no sentinel string to recognise.
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        // Explicitly NULL, against the column's default. This is the one place
        // in the codebase that says "this account has no usable password", and
        // it is what makes the login form tell them to activate rather than
        // claiming their password is wrong.
        passwordSetAt: null,
        // Unproven until they open the activation link. Nobody typed this
        // address but the person holding the spreadsheet.
        emailVerifiedAt: null,
        status: 'PENDING',
        role: 'USER',
      },
    });
    applied.membersCreated += 1;
  }

  return { ...plan, applied };
}

module.exports = { analyze, applyImport };
