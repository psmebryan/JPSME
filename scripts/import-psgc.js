// Imports the PSA's PSGC list (regions to barangays) for the store's address
// dropdowns, from the PSA "Publication Datafile" workbook:
//
//   npm run import:psgc -- "C:\path\to\PSGC-xQ-YYYY-Publication-Datafile.xlsx"
//
// Download the workbook from https://psa.gov.ph/classification/psgc . The same
// import can be done from the admin: Merchandise -> Delivery & Pickup.
// Replaces the whole list in one transaction.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fulfilment = require('../src/services/merchFulfilment.service');
const prisma = require('../src/config/prisma');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: npm run import:psgc -- <path to the PSA Publication Datafile .xlsx>');
    process.exit(1);
  }
  const summary = await fulfilment.importPsgc(fs.readFileSync(file), { source: path.basename(file) });
  console.log(`Imported ${summary.regions} regions, ${summary.provinces} provinces, ${summary.cities} cities and municipalities, ${summary.barangays} barangays from ${summary.source}.`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('PSGC import failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
