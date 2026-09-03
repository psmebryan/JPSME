// SUPERSEDED — this script no longer runs, and is kept only for reference.
//
// It builds a five-level tree (National / Region / Cluster / Chapter / Student
// Unit). The hierarchy has since been collapsed to National → Province →
// Student Unit, so REGION, CLUSTER and CHAPTER are no longer values
// OrganizationType accepts and every create below would be rejected by the
// database. The guard at the bottom of this comment block stops it with an
// explanation rather than letting it fail partway through on a raw enum error,
// which would leave a half-imported tree behind.
//
// Reviving it means deciding what a province is in terms of the workbook's own
// columns — the workbook has no province column, which is the same gap that
// made cluster/chapter parentage underivable (see below).
//
// Imports the official "2026 DATABASE OF JPSME ORGANIZATIONS.xlsx" into the
// organizations table.
//
// WHAT THIS SCRIPT WILL AND WILL NOT DO
//
// The workbook establishes a parent organization for only 1 of its 176
// organization rows — the MOTHER ORGANIZATION and CHAPTER columns are empty
// everywhere else. So the importer seeds only what the source actually
// supports:
//
//   * mother region  — derived from the sheet the row lives on (NCR / LUZON /
//                      VISAYAS / MINDANAO). Reliable.
//   * sub-region     — derived from the row's own REGION column (NORTHERN /
//                      CENTRAL / SOUTHERN / EASTERN / WESTERN). Reliable, and
//                      a real level in the workbook's own hierarchy chart.
//   * cluster/chapter parentage — NOT derivable. Never guessed. Every row that
//                      should sit under a cluster or chapter is imported at
//                      its region and flagged needsReview with an importNote,
//                      for an admin to reassign in the UI.
//
// Run:  npm run import:organizations -- --file "<path to xlsx>"
//       npm run import:organizations -- --dry-run     (report only, no writes)

const path = require('path');
const ExcelJS = require('exceljs');
const prisma = require('../src/config/prisma');
const orgService = require('../src/services/organization.service');

const REGION_SHEETS = ['JPSME NCR', 'JPSME LUZON', 'JPSME MINDANAO', 'JPSME VISAYAS'];
const MOTHER_SHEET = 'MOTHER ORGANIZATIONS';

// Column indices are 0-based and identical across all four region sheets
// (verified against the workbook's own header rows 2 and 3).
const COL = {
  region: 0, status: 1, type: 2, institution: 3, name: 4,
  motherOrg: 6, chapter: 7, email: 8, facebook: 9,
};

const SUB_REGIONS = ['NORTHERN', 'CENTRAL', 'SOUTHERN', 'EASTERN', 'WESTERN'];

// Always returns a string. ExcelJS cell values can be plain scalars, Dates,
// rich-text objects, formula results, or hyperlink objects whose `.text` is
// itself rich text — so every branch is coerced rather than returned raw.
function cellText(c) {
  if (c == null) return '';
  if (typeof c === 'object') {
    if (Array.isArray(c.richText)) return c.richText.map((t) => String(t.text || '')).join('');
    if (c.text != null) return cellText(c.text);
    if (c.result !== undefined) return String(c.result);
    if (c.hyperlink) return String(c.hyperlink);
    if (c instanceof Date) return c.toISOString();
    return '';
  }
  return String(c);
}

// Collapses whitespace and strips the stylised Unicode letters the source
// workbook uses in places (e.g. "𝗬𝗻𝗻𝗮" for "Ynna"), so names compare and
// display consistently.
function normalizeText(value) {
  let s = cellText(value).replace(/\s+/g, ' ').trim();
  s = s.replace(/[\uD835][\uDC00-\uDFFF]/g, (ch) => {
    const cp = ch.codePointAt(0);
    const OFFSETS = [
      [0x1d5d4, 0x1d5ed, 65], [0x1d5ee, 0x1d607, 97], // sans-serif bold
      [0x1d400, 0x1d419, 65], [0x1d41a, 0x1d433, 97], // serif bold
      [0x1d5a0, 0x1d5b9, 65], [0x1d5ba, 0x1d5d3, 97], // sans-serif
    ];
    for (const [lo, hi, base] of OFFSETS) {
      if (cp >= lo && cp <= hi) return String.fromCharCode(base + (cp - lo));
    }
    return ch;
  });
  return s.trim();
}

function titleCaseRegion(word, motherLabel) {
  const w = word.charAt(0) + word.slice(1).toLowerCase();
  return `${w} ${motherLabel}`;
}

// A region sheet holds one contiguous block of organization rows starting at
// row 4. Mindanao additionally carries an unrelated contact table further down
// (its own header row, university/president/email columns) — stopping at the
// first fully-empty row keeps that out of the import entirely.
function readSheetRows(ws) {
  const rows = [];
  for (let i = 4; i <= ws.rowCount; i += 1) {
    const row = ws.getRow(i);
    const get = (ix) => normalizeText(row.getCell(ix + 1).value);
    const record = {
      rowNumber: i,
      region: get(COL.region),
      status: get(COL.status),
      type: get(COL.type),
      institution: get(COL.institution),
      name: get(COL.name),
      motherOrg: get(COL.motherOrg),
      chapter: get(COL.chapter),
      email: get(COL.email),
      facebook: get(COL.facebook),
    };
    const empty = !record.region && !record.status && !record.type && !record.institution && !record.name;
    if (empty) break;
    rows.push(record);
  }
  return rows;
}

function mapType(rawType) {
  const t = (rawType || '').toUpperCase().trim();
  if (t === 'CHAPTER') return { type: 'CHAPTER', provisional: false };
  if (t === 'STUDENT UNIT') return { type: 'STUDENT_UNIT', provisional: false };
  if (t === 'CLUSTER') return { type: 'CLUSTER', provisional: false };
  // Blank or junk (some rows carry an email address in this column). Import
  // the row so the roster stays complete, but mark the classification
  // provisional rather than asserting a type the source never gave.
  return { type: 'STUDENT_UNIT', provisional: true };
}

// Refuses up front rather than failing partway through. Without this the first
// REGION create throws a raw Prisma enum error after the national root has
// already been written, leaving a partial tree to clean up by hand.
function assertSchemaStillSupported() {
  const supported = require('@prisma/client').OrganizationType || {};
  const needed = ['REGION', 'CLUSTER', 'CHAPTER'];
  const missing = needed.filter((t) => !(t in supported));
  if (missing.length) {
    console.error('This importer is superseded and cannot run.\n');
    console.error(`It creates ${missing.join(', ')} organizations, and OrganizationType no longer`);
    console.error(`accepts those — the hierarchy is now ${Object.keys(supported).join(' / ')}.`);
    console.error('\nNothing has been written. See the note at the top of this file.');
    process.exit(1);
  }
}

async function main() {
  assertSchemaStillSupported();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileIx = args.indexOf('--file');
  const filePath = fileIx !== -1 && args[fileIx + 1]
    ? args[fileIx + 1]
    : path.join(process.env.USERPROFILE || '', 'Downloads', '2026 DATABASE OF  𝗝𝗣𝗦𝗠𝗘 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗧𝗜𝗢𝗡𝗦 .xlsx');

  console.log('Workbook :', filePath);
  console.log('Mode     :', dryRun ? 'DRY RUN (no writes)' : 'IMPORT');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const report = {
    created: 0, skipped: 0, needsReview: 0,
    provisionalType: 0, nameFromInstitution: 0,
    bySheet: {}, skippedRows: [],
  };

  if (dryRun) {
    for (const sheetName of REGION_SHEETS) {
      const ws = wb.getWorksheet(sheetName);
      if (!ws) continue;
      const rows = readSheetRows(ws);
      const usable = rows.filter((r) => r.name || r.institution);
      report.bySheet[sheetName] = { rows: rows.length, usable: usable.length, skipped: rows.length - usable.length };
    }
    console.log('\n--- DRY RUN SUMMARY ---');
    console.table(report.bySheet);
    await prisma.$disconnect();
    return;
  }

  const existing = await prisma.organization.count();
  if (existing > 0) {
    console.error(`\nRefusing to import: organizations table already has ${existing} row(s).`);
    console.error('Clear it first, or the import would create duplicates.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // 1. The single root.
  const national = await orgService.createOrganization({
    name: 'JPSME National', type: 'NATIONAL', parentId: null,
    code: 'NATIONAL', sourceSheet: 'hierarchy',
  });
  report.created += 1;
  console.log('\nroot: JPSME National');

  // 2. One mother region per sheet, plus sub-regions created on demand.
  const motherRegions = new Map();
  const subRegions = new Map();

  for (const sheetName of REGION_SHEETS) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) { console.warn(`  (sheet "${sheetName}" not found — skipped)`); continue; }

    const motherLabel = sheetName.replace(/^JPSME\s+/i, '').trim();
    const mother = await orgService.createOrganization({
      name: `JPSME ${motherLabel}`, type: 'REGION', parentId: national.id, sourceSheet: sheetName,
    });
    motherRegions.set(sheetName, mother);
    report.created += 1;

    const rows = readSheetRows(ws);
    let sheetCreated = 0;
    let sheetSkipped = 0;

    for (const r of rows) {
      // A row with neither an organization name nor an institution carries no
      // organization at all — usually a spacer or a partially-filled line.
      if (!r.name && !r.institution) {
        sheetSkipped += 1;
        report.skipped += 1;
        report.skippedRows.push({ sheet: sheetName, row: r.rowNumber, reason: 'no name or institution' });
        continue;
      }

      const notes = [];
      let orgName = r.name;
      if (!orgName) {
        orgName = r.institution;
        notes.push('Name taken from UNIVERSITY / INSTITUTION — the JPSME STUDENT UNIT column was blank.');
        report.nameFromInstitution += 1;
      }

      const { type, provisional } = mapType(r.type);
      if (provisional) {
        notes.push(`ORGANIZATION TYPE was "${r.type || '(blank)'}" in the source; classified provisionally as STUDENT_UNIT.`);
        report.provisionalType += 1;
      }

      // Parent: the sub-region when the row names one, otherwise the mother
      // region. Never a cluster or chapter — the source does not say.
      let parent = mother;
      const subKey = SUB_REGIONS.includes(r.region.toUpperCase()) ? r.region.toUpperCase() : null;
      if (subKey) {
        const cacheKey = `${sheetName}::${subKey}`;
        if (!subRegions.has(cacheKey)) {
          const sub = await orgService.createOrganization({
            name: titleCaseRegion(subKey, motherLabel), type: 'REGION',
            parentId: mother.id, subRegion: subKey, sourceSheet: sheetName,
          });
          subRegions.set(cacheKey, sub);
          report.created += 1;
        }
        parent = subRegions.get(cacheKey);
      } else if (r.region) {
        notes.push(`REGION column held "${r.region}", which is not a recognised sub-region; attached to ${mother.name}.`);
      }

      notes.push('Cluster/chapter parent not present in the source workbook — attached at region level pending review.');

      await orgService.createOrganization({
        name: orgName,
        type,
        parentId: parent.id,
        institution: r.institution || null,
        email: r.email || null,
        facebookUrl: r.facebook || null,
        subRegion: subKey,
        sourceSheet: sheetName,
        needsReview: true,
        importNote: notes.join(' '),
      });
      report.created += 1;
      report.needsReview += 1;
      sheetCreated += 1;
    }

    report.bySheet[sheetName] = { imported: sheetCreated, skipped: sheetSkipped };
    console.log(`  ${sheetName.padEnd(16)} imported ${String(sheetCreated).padStart(3)}  skipped ${sheetSkipped}`);
  }

  // 3. Mother organizations (clusters and chapters). These have a CATEGORY but
  //    no parent column at all, and their names don't reliably encode one
  //    either — so they attach to the root, flagged, rather than being guessed
  //    into a region.
  const motherWs = wb.getWorksheet(MOTHER_SHEET);
  if (motherWs) {
    let count = 0;
    for (let i = 4; i <= motherWs.rowCount; i += 1) {
      const row = motherWs.getRow(i);
      const get = (ix) => normalizeText(row.getCell(ix + 1).value);
      const category = get(2);
      const name = get(3);
      if (!name) continue;
      const type = category.toUpperCase() === 'CHAPTER' ? 'CHAPTER'
        : category.toUpperCase() === 'CLUSTER' ? 'CLUSTER' : null;
      const notes = ['Imported from MOTHER ORGANIZATIONS. The workbook gives no parent for this organization; attached to the national root pending review.'];
      if (!type) notes.push(`CATEGORY was "${category || '(blank)'}"; classified provisionally as CLUSTER.`);

      await orgService.createOrganization({
        name, type: type || 'CLUSTER', parentId: national.id,
        email: get(7) || null, facebookUrl: get(8) || null,
        subRegion: SUB_REGIONS.includes(get(0).toUpperCase()) ? get(0).toUpperCase() : null,
        sourceSheet: MOTHER_SHEET, needsReview: true, importNote: notes.join(' '),
      });
      count += 1;
      report.created += 1;
      report.needsReview += 1;
    }
    report.bySheet[MOTHER_SHEET] = { imported: count, skipped: 0 };
    console.log(`  ${MOTHER_SHEET.padEnd(16)} imported ${String(count).padStart(3)}`);
  }

  // 4. Integrity check — the materialized paths must agree with parentId.
  const integrity = await orgService.verifyPathIntegrity();

  console.log('\n=========== IMPORT REPORT ===========');
  console.log('organizations created      :', report.created);
  console.log('rows skipped (no data)     :', report.skipped);
  console.log('flagged needsReview        :', report.needsReview);
  console.log('  ...provisional type      :', report.provisionalType);
  console.log('  ...name from institution :', report.nameFromInstitution);
  console.log('path integrity             :', integrity.problems.length === 0
    ? `OK (${integrity.checked} checked)`
    : `${integrity.problems.length} PROBLEM(S)`);
  if (integrity.problems.length) console.log(JSON.stringify(integrity.problems.slice(0, 5), null, 2));

  console.log('\nEvery imported organization is flagged needsReview because the');
  console.log('workbook does not record cluster/chapter parentage. Reassign them');
  console.log('under the correct parent in Admin → Organizations.');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nImport failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
