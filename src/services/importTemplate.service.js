// The blank workbook somebody fills in to add members.
//
// WHY THIS EXISTS RATHER THAN "export, then edit". The export is the whole
// database — every member, every payment, every registration. Handing that to a
// chapter officer so they can add twelve names is both a lot to wade through and
// a lot of other people's personal data to send over Viber. This is the same
// Members sheet with nothing in it.
//
// THE EXAMPLE ROWS ARE NOT ON THE MEMBERS SHEET, and that is deliberate. An
// example sitting in row 2 of the sheet being edited is an example somebody
// forgets to delete, and then "Juan dela Cruz" is a member of JPSME. The
// importer reads only the sheets named `Members` and `Organizations`, so the
// examples live on a third sheet it ignores entirely — visible while you work,
// impossible to import by accident.

const ExcelJS = require('exceljs');

// Exactly the headers dataImport.service.js looks for. Kept in this order
// because it is the order dataExport writes them, so a template and an export
// look like the same document to whoever is filling one in.
const MEMBER_COLUMNS = [
  { header: 'ID', key: 'id', width: 8 },
  { header: 'First Name', key: 'firstName', width: 18 },
  { header: 'M.I.', key: 'middleInitial', width: 6 },
  { header: 'Last Name', key: 'lastName', width: 18 },
  { header: 'Email', key: 'email', width: 32 },
  { header: 'Phone', key: 'phone', width: 16 },
  { header: 'Year Level', key: 'yearLevel', width: 12 },
  { header: 'Organization Path', key: 'organizationPath', width: 46 },
];

const EXAMPLES = [
  ['', 'Juan', 'D', 'Dela Cruz', 'juan.delacruz@example.com', '09171234567', '1st Year', ''],
  ['', 'Maria', '', 'Santos', 'maria.santos@example.com', '', '3rd Year', ''],
  ['', 'Jose', '', 'Rizal', 'jose.rizal@example.com', '', '', 'JPSME National > Luzon > Cavite > Cavite State University'],
];

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function note(sheet, text, { bold = false, color = 'FF475569', size = 11 } = {}) {
  const row = sheet.addRow([text]);
  row.getCell(1).font = { bold, size, color: { argb: color } };
  row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  return row;
}

async function buildTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JPSME';
  workbook.created = new Date();

  // --- the sheet they actually fill in ---------------------------------------
  const members = workbook.addWorksheet('Members');
  members.columns = MEMBER_COLUMNS;
  styleHeader(members);

  // Required columns marked on the header itself, so the one thing somebody
  // needs to know is visible without reading anything else.
  ['First Name', 'Last Name', 'Email'].forEach((header) => {
    const index = MEMBER_COLUMNS.findIndex((c) => c.header === header) + 1;
    members.getRow(1).getCell(index).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' },
    };
  });

  // Year Level as a dropdown rather than free text. It is the only column with a
  // fixed vocabulary, and "4th yr" typed by hand is the most common way a sheet
  // comes back with errors in it.
  //
  // Added as a RANGE, not cell by cell. Setting .dataValidation on G2..G600
  // individually materialises all 599 cells, which leaves the sheet claiming 600
  // rows: the next row appended lands at 601, autofilter and "go to last row"
  // both point into empty space, and the importer scans hundreds of blanks. The
  // range form applies the same dropdown with the sheet still one row long.
  //
  // Generous upper bound so it still works after somebody pastes 300 names in;
  // allowBlank because the column is optional.
  members.dataValidations.add('G2:G600', {
    type: 'list',
    allowBlank: true,
    formulae: ['"1st Year,2nd Year,3rd Year,4th Year"'],
    showErrorMessage: true,
    errorTitle: 'Pick a year level',
    error: 'Choose 1st, 2nd, 3rd or 4th Year, or leave the cell empty.',
  });

  // --- how to use it ----------------------------------------------------------
  //
  // A sheet the importer never reads, so everything here is safe to leave in
  // place — including the examples.
  const guide = workbook.addWorksheet('How to use this');
  guide.getColumn(1).width = 110;

  note(guide, 'Adding members to JPSME', { bold: true, size: 16, color: 'FF1E1B4B' });
  note(guide, '');
  note(guide, 'Fill in the Members sheet, one row per person, then upload this file in Admin → Settings → Data export & import.');
  note(guide, '');

  note(guide, 'What each row needs', { bold: true, size: 13, color: 'FF1E1B4B' });
  note(guide, 'REQUIRED — First Name, Last Name, Email. That is all. The three purple columns.');
  note(guide, 'Leave ID blank. It is filled in by an export; a blank ID is what marks a row as somebody new.');
  note(guide, 'Email must be unique. If it already belongs to an account, that account is UPDATED rather than duplicated.');
  note(guide, '');
  note(guide, 'OPTIONAL — M.I., Phone, Year Level.');
  note(guide, 'Organization Path: leave it BLANK. Each member chooses their own school when they activate, which saves you');
  note(guide, 'filling in hundreds of paths and getting some of them wrong. Only fill it in if you are certain.');
  note(guide, '');

  note(guide, 'What happens when you import', { bold: true, size: 13, color: 'FF1E1B4B' });
  note(guide, '1. Press "Check what would change" first. Nothing is written until you press Apply.');
  note(guide, '2. If anything is wrong, you get a list naming the exact row number in this file. Fix those rows and try again.');
  note(guide, '3. One bad row means NOTHING is imported — not even the good rows. So the list is the whole job, not a first instalment.');
  note(guide, '4. Accounts are created with no password, and NOBODY is emailed yet.');
  note(guide, '5. When you are happy with what was created, press "Send activation links".');
  note(guide, '');
  note(guide, 'Each member then gets an email, chooses their own password and their own school, and can sign in.');
  note(guide, 'Nobody — not even an administrator — ever sees their password.');
  note(guide, '');

  note(guide, 'Examples — do not copy these into the Members sheet, they are here so you can see the shape', {
    bold: true, size: 13, color: 'FF1E1B4B',
  });
  note(guide, '');

  const exampleHeader = guide.addRow(MEMBER_COLUMNS.map((c) => c.header));
  exampleHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  exampleHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
  EXAMPLES.forEach((row) => guide.addRow(row));

  // The example table needs real column widths, which fight the single wide
  // column the prose above uses. Prose wins — it is what people read — so the
  // example columns are merely wide enough to be legible.
  MEMBER_COLUMNS.forEach((c, i) => {
    if (i > 0) guide.getColumn(i + 1).width = Math.max(c.width, 14);
  });

  const noteRow = guide.addRow(['']);
  noteRow.getCell(1).font = { italic: true, color: { argb: 'FF475569' } };
  guide.addRow(['Juan has a middle initial and a phone number; Maria has neither. Both are fine.']);
  guide.addRow(['Jose shows what an Organization Path looks like IF you fill one in — but leaving it blank is better.']);

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildTemplate, MEMBER_COLUMNS };
