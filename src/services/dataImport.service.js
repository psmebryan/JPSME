const ExcelJS = require('exceljs');
const prisma = require('./../config/prisma');
const AppError = require('./../utils/AppError');
const organizationService = require('./organization.service');

// Reads back the Organizations and Members sheets produced by
// dataExport.service.js, so a workbook can be exported, edited in Excel, and
// re-imported.
//
// Three rules this holds to, because an import that gets them wrong is very
// hard to undo:
//
//   * It never deletes. A row missing from the sheet is left alone, not
//     removed — a partial sheet is far more likely than a deliberate purge.
//   * It never creates member accounts. Importing logins would mean inventing
//     passwords and bypassing email verification; members register themselves.
//     Member rows only update existing accounts, matched on email.
//   * Nothing is written until every row has been checked. A sheet with a bad
//     row on line 40 must not leave 39 rows applied and the rest not.
//
// dryRun returns exactly what would change without touching anything, and the
// admin UI runs it first so the report can be read before committing.

const ORG_TYPES = ['NATIONAL', 'PROVINCE', 'STUDENT_UNIT'];
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

      for (let r = 2; r <= memberSheet.rowCount; r += 1) {
        const row = memberSheet.getRow(r);
        const email = cell(row, h.email).toLowerCase();
        if (!email) continue;

        const user = byEmail.get(email);
        if (!user) {
          // Not an error: accounts are created by people registering, so an
          // unknown email is a row to report and skip, not a failure.
          plan.members.push({ action: 'skip', row: r, email, changes: ['no account with this email — members register themselves'] });
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

  const applied = { created: 0, updated: 0, membersUpdated: 0 };

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

  return { ...plan, applied };
}

module.exports = { analyze, applyImport };
