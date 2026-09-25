// Creating member accounts from a spreadsheet.
//
// This suite builds real .xlsx buffers with ExcelJS and runs the real importer
// against the real database, then removes what it made. Structural assertions
// could not cover what actually matters here — that a row number in an error
// message is the row number Excel shows, and that a sheet with one bad row
// writes nothing — because both are properties of running the thing.
//
// Follows tests/verifyFlow.test.js: tagged fixtures, cleaned up in a finally.
//
// The three rules being defended, in order of how much damage getting them
// wrong would do:
//
//   A created account has NO usable password and cannot be signed in to until
//   its owner opens an activation link. An import that produced usable accounts
//   would be an import that hands out access to addresses nobody has verified.
//
//   One bad row writes nothing at all. A half-applied import of 400 members is
//   not something anybody can unpick afterwards.
//
//   Every error names the Excel row, and every bad row is reported. A 400-row
//   sheet is only fixable if the report says where.

const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const dataImport = require('../src/services/dataImport.service');
const importTemplate = require('../src/services/importTemplate.service');
const organizationService = require('../src/services/organization.service');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${String(err.message).split('\n').join('\n      ')}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const TAG = '__bulkimport__';
const E = (name) => `${TAG}${name}@example.test`;

// The column headers dataExport.service.js writes, so these tests exercise the
// real round trip: export, edit in Excel, import.
const HEADERS = ['ID', 'First Name', 'M.I.', 'Last Name', 'Email', 'Phone', 'Year Level', 'Organization Path'];

async function workbook(rows, extraHeaders = []) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Members');
  sheet.addRow(HEADERS.concat(extraHeaders));
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const countMade = () => prisma.user.count({ where: { email: { contains: TAG } } });

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { targetUserId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  await cleanup();
  const unit = await prisma.organization.findFirst({ where: { type: 'STUDENT_UNIT', isActive: true } });
  assert(unit, 'the database has at least one active student unit to attach members to');

  // --- creating ---------------------------------------------------------------

  await test('a sheet of names and addresses creates accounts', async () => {
    const buf = await workbook([
      ['', 'Ana', 'B', 'Reyes', E('ana'), '0917', '1st Year', ''],
      ['', 'Ben', '', 'Santos', E('ben'), '', '', ''],
    ]);
    const plan = await dataImport.analyze(buf);
    assertEqual(plan.errors.length, 0, `no errors, got ${JSON.stringify(plan.errors)}`);
    assertEqual(plan.summary.membersToCreate, 2, 'two creates');
    // Counted apart from updates: creating sixty people and correcting sixty
    // phone numbers are not the same kind of event.
    assertEqual(plan.summary.membersToUpdate, 0, 'and no updates');

    assertEqual(await countMade(), 0, 'the preview wrote nothing');

    const applied = await dataImport.applyImport(buf);
    assertEqual(applied.applied.membersCreated, 2, 'two created');
    assertEqual(await countMade(), 2, 'and they exist');
  });

  await test('a created account cannot be signed in to', async () => {
    // The whole reason the importer was allowed to start creating accounts.
    const ana = await prisma.user.findUnique({ where: { email: E('ana') } });
    assertEqual(ana.passwordSetAt, null, 'no usable password has ever been set');
    assertEqual(ana.emailVerifiedAt, null, 'and the address is unproven');
    assertEqual(ana.status, 'PENDING', 'PENDING until they activate');
    assert(ana.password && ana.password.startsWith('$2'), 'the column still holds a real bcrypt hash');
    // Of random bytes that were discarded, so there is nothing to guess. The
    // obvious wrong answers would be an empty string or a known sentinel.
    assert(!(await bcrypt.compare('', ana.password)), 'empty string does not match');
    assert(!(await bcrypt.compare(E('ana'), ana.password)), 'nor their own address');
  });

  await test('the member keeps the choices that are theirs', async () => {
    const ana = await prisma.user.findUnique({ where: { email: E('ana') } });
    // Blank in the sheet on purpose: an admin filling in sixty organization
    // paths is guessing, and the member knows their own school unit.
    assertEqual(ana.organizationId, null, 'no organization until they pick one');
    assertEqual(ana.role, 'USER', 'and a plain member role');
  });

  await test('names arrive upper-cased, like every self-registered member', async () => {
    // Otherwise a member typed in Excel sorts and searches differently from one
    // who signed up.
    const ana = await prisma.user.findUnique({ where: { email: E('ana') } });
    assertEqual(ana.firstName, 'ANA', 'first name');
    assertEqual(ana.lastName, 'REYES', 'last name');
    assertEqual(ana.middleInitial, 'B', 'middle initial kept');
    assertEqual(ana.yearLevel, 'FIRST', 'year level mapped from "1st Year"');
  });

  await test('the import sends no email', async () => {
    // Importing 500 rows must not fire 500 emails from one button press.
    // Inviting is a separate, resumable action.
    const ana = await prisma.user.findUnique({ where: { email: E('ana') } });
    const jobs = await prisma.job.count({
      where: { type: 'SEND_ACTIVATION_EMAIL', payload: { contains: `"userId":${ana.id}` } },
    });
    assertEqual(jobs, 0, 'nothing queued by the import itself');
  });

  await test('re-importing the same sheet does not duplicate anybody', async () => {
    const buf = await workbook([
      ['', 'Ana', 'B', 'Reyes', E('ana'), '0917', '1st Year', ''],
      ['', 'Ben', '', 'Santos', E('ben'), '', '', ''],
    ]);
    const plan = await dataImport.analyze(buf);
    assertEqual(plan.summary.membersToCreate, 0, 'they are matched by email and updated instead');
    assertEqual(await countMade(), 2, 'still two accounts');
  });

  // --- the error report --------------------------------------------------------

  await test('every error names the row number Excel shows', async () => {
    // The header is row 1, so the rows below are 2, 3, 4, 5, 6. An off-by-one
    // here would make every message in a 400-row report point at the wrong line.
    const buf = await workbook([
      ['', 'Dan', '', 'Cruz', E('dan'), '', '', ''],                        // 2 — fine
      ['', '', '', 'NoFirst', E('nofirst'), '', '', ''],                    // 3 — no first name
      ['', 'Eve', '', 'Tan', E('eve'), '', '5th Year', ''],                 // 4 — bad year level
      ['', 'Fay', '', 'Uy', E('dan'), '', '', ''],                          // 5 — duplicate of row 2
      ['', 'Gus', '', 'Vee', E('gus'), '', '', 'Nowhere > Nothing'],        // 6 — unknown organization
    ]);
    const plan = await dataImport.analyze(buf);
    const report = plan.errors.join('\n');

    // All of them, not just the first: one pass over the sheet has to list
    // everything wrong with it, or a 12-mistake sheet becomes 12 uploads.
    assertEqual(plan.errors.length, 4, `four problems, got:\n${report}`);

    assert(/row 3: First Name is required/.test(report), `missing name on row 3:\n${report}`);
    assert(/row 4: "5TH YEAR" is not a year level/.test(report), `bad year on row 4:\n${report}`);
    assert(/row 6: organization "Nowhere > Nothing" was not found/.test(report), `bad org on row 6:\n${report}`);
    // A duplicate names BOTH rows — the fix needs to know which one to delete.
    assert(/row 5: email .* also appears on row 2/.test(report), `duplicate cites both rows:\n${report}`);
  });

  await test('a sheet with one bad row writes nothing at all', async () => {
    const before = await countMade();
    const buf = await workbook([
      ['', 'Hal', '', 'Ilo', E('hal'), '', '', ''],     // row 2 — perfectly good
      ['', '', '', 'NoFirst', E('nofirst2'), '', '', ''], // row 3 — bad
    ]);
    let threw = null;
    await dataImport.applyImport(buf).catch((e) => { threw = e; });
    assert(threw, 'the import is refused');
    assertEqual(threw.statusCode, 400, 'as a 400, not a server error');
    // The point: the good row above the bad one is not applied either.
    assertEqual(await countMade(), before, 'nothing was created');
  });

  // --- what a spreadsheet may not do -------------------------------------------

  await test('a spreadsheet cannot mint an administrator', async () => {
    // The workbook is edited in Excel by whoever was handed it. Role and status
    // are set by this code, never read from the sheet.
    const buf = await workbook(
      [['', 'Mal', '', 'Actor', E('mal'), '', '', '', 'ADMIN', 'APPROVED']],
      ['Role', 'Status'],
    );
    await dataImport.applyImport(buf);
    const mal = await prisma.user.findUnique({ where: { email: E('mal') } });
    assert(mal, 'the row was imported');
    assertEqual(mal.role, 'USER', 'as a plain member, whatever the Role column said');
    assertEqual(mal.status, 'PENDING', 'and PENDING, whatever the Status column said');
    assertEqual(mal.passwordSetAt, null, 'still with no usable password');
  });

  await test('an invalid email address is refused rather than imported', async () => {
    const buf = await workbook([['', 'Bad', '', 'Address', `${TAG}not-an-email`, '', '', '']]);
    const plan = await dataImport.analyze(buf);
    assert(plan.errors.some((e) => /is not a valid email address/.test(e)), `refused:\n${plan.errors.join('\n')}`);
  });

  // --- the optional organization ------------------------------------------------

  await test('an Organization Path is honoured when the sheet names one', async () => {
    // Optional, not ignored: an admin who does know the chapter should not have
    // to leave it out.
    const path = await organizationService.getOrganizationPathLabel(unit.id, ' > ');
    const buf = await workbook([['', 'Ivy', '', 'Jung', E('ivy'), '', '', path]]);
    const plan = await dataImport.analyze(buf);
    assertEqual(plan.errors.length, 0, `resolves, got ${JSON.stringify(plan.errors)}`);
    assertEqual(plan.members[0].create.organizationId, unit.id, 'and is pre-filled on the account');
  });

  await test('a blank Organization Path is the expected case, not an error', async () => {
    const buf = await workbook([['', 'Kai', '', 'Lee', E('kai'), '', '', '']]);
    const plan = await dataImport.analyze(buf);
    assertEqual(plan.errors.length, 0, `no error for a blank organization, got ${JSON.stringify(plan.errors)}`);
    assertEqual(plan.members[0].create.organizationId, null, 'left for the member to choose');
    assert(
      plan.members[0].changes.some((c) => /chosen on activation/.test(c)),
      `and the preview says so: ${JSON.stringify(plan.members[0].changes)}`,
    );
  });

  // --- the template ------------------------------------------------------------

  await test('the template is a workbook the importer accepts, with nothing in it', async () => {
    const buf = Buffer.from(await importTemplate.buildTemplate());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const members = wb.getWorksheet('Members');
    assert(members, 'it has a Members sheet');
    const headers = members.getRow(1).values.slice(1).map(String);
    ['First Name', 'Last Name', 'Email', 'Year Level', 'Organization Path'].forEach((h) => {
      assert(headers.includes(h), `the ${h} column the importer looks for`);
    });

    const plan = await dataImport.analyze(buf);
    assertEqual(plan.errors.length, 0, `imports cleanly, got ${JSON.stringify(plan.errors)}`);
    assertEqual(plan.summary.membersToCreate, 0, 'and finds nobody to create');
  });

  await test('the template has no phantom rows, so row 2 is row 2', async () => {
    // Setting the Year Level dropdown cell by cell materialises every cell it
    // touches: G2..G600 individually left the sheet claiming 600 rows, so the
    // next row appended landed at 601 and every error message would have named
    // a line number hundreds away from the one the reader is looking at.
    // Adding it as a RANGE applies the same dropdown to a one-row sheet.
    const buf = Buffer.from(await importTemplate.buildTemplate());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assertEqual(wb.getWorksheet('Members').rowCount, 1, 'the Members sheet is just its header');

    // And prove it end to end: a row typed straight under the header is row 2.
    const filled = new ExcelJS.Workbook();
    await filled.xlsx.load(buf);
    filled.getWorksheet('Members').addRow(['', '', '', 'NoFirstName', E('phantom'), '', '', '']);
    const plan = await dataImport.analyze(Buffer.from(await filled.xlsx.writeBuffer()));
    const report = plan.errors.join('\n');
    assert(/row 2: First Name is required/.test(report),
      `the first data row is reported as row 2:\n${report}`);
  });

  await test('the examples cannot be imported by accident', async () => {
    // They live on a sheet the importer never reads, because an example sitting
    // in row 2 of the sheet being edited is an example somebody forgets to
    // delete — and then "Juan dela Cruz" is a member of JPSME.
    const buf = Buffer.from(await importTemplate.buildTemplate());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const guide = wb.getWorksheet('How to use this');
    assert(guide, 'there is a guide sheet');
    let hasExample = false;
    guide.eachRow((row) => { if (String(row.values).includes('@example.com')) hasExample = true; });
    assert(hasExample, 'the examples are on it');

    const plan = await dataImport.analyze(buf);
    assertEqual(plan.summary.membersToCreate, 0, 'and the importer creates nobody from them');
  });

  // --- updates still work -------------------------------------------------------

  await test('updating an existing member still works, and does not touch their password', async () => {
    const before = await prisma.user.findUnique({ where: { email: E('ben') } });
    const buf = await workbook([['', 'Ben', '', 'Santos', E('ben'), '0999', '2nd Year', '']]);
    await dataImport.applyImport(buf);
    const after = await prisma.user.findUnique({ where: { email: E('ben') } });
    assertEqual(after.phone, '0999', 'phone updated');
    assertEqual(after.yearLevel, 'SECOND', 'year level updated');
    assertEqual(after.password, before.password, 'the password column is untouched by an update');
    assertEqual(after.passwordSetAt, before.passwordSetAt, 'and so is its activation state');
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
