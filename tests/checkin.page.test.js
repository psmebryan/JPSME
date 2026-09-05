// Drives the real public/js/checkin.js through a stub DOM, simulating what an
// actual gun scanner does at a door. This is the layer the API tests never
// touch: everything below has been proven server-side, but nothing had ever
// confirmed the page turns a scan into the right request and shows the right
// answer.

const fs = require('fs');
const path = require('path');
const { El, buildDocument } = require('./support/domHarness');

const PROJECT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) { passed += 1; console.log('  ok    ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

// Rebuilds the markup views/admin/event-checkin.ejs renders, with the same
// data-attributes checkin.js looks for.
function buildPage() {
  const root = new El('div', { dataset: { checkinRoot: '', eventId: '42' } });
  const form = new El('form', { dataset: { scanForm: '' } });
  const input = new El('input', { dataset: { scanInput: '' } });
  const station = new El('input', { dataset: { station: '' } });
  const result = new El('div', { dataset: { result: '' } });
  const manual = new El('details', { dataset: { manual: '' } });
  const manualSearch = new El('input', { dataset: { manualSearch: '' } });
  const manualResults = new El('div', { dataset: { manualResults: '' } });
  const recent = new El('ul', { dataset: { recent: '' } });
  form.appendChild(input);
  manual.append(manualSearch, manualResults);
  root.append(form, station, result, manual, recent);
  return { root, form, input, station, result };
}

// What the scanner physically does: types the characters, then maybe a suffix.
function scanWith(input, code, suffix) {
  input.value = '';
  for (const ch of code) {
    input.value += ch;
    input.dispatch('input');
  }
  if (suffix === 'enter') input.parent.dispatch('submit', { preventDefault() {} });
  if (suffix === 'tab') input.dispatch('keydown', { key: 'Tab', preventDefault() {} });
  // suffix === 'none': nothing further happens at all.
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const TOKEN = 'a'.repeat(64);
  const requests = [];

  // --- environment ---------------------------------------------------------
  const page = buildPage();
  const doc = buildDocument(page.root);
  global.document = doc;
  global.window = {
    addEventListener() {},
    location: { pathname: '/admin/events/42/check-in', search: '' },
    AudioContext: function AudioContext() {
      return {
        currentTime: 0,
        createOscillator: () => ({ connect() {}, frequency: {}, start() {}, stop() {} }),
        createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }),
        destination: {},
      };
    },
  };
  global.localStorage = { getItem: () => null, setItem() {} };

  let nextResponse = {
    ok: true, result: 'SUCCESS', message: 'Checked in.',
    participant: { name: 'Juan Dela Cruz', registrationNumber: 'REG-2026-000123', organizationPath: null },
    checkedInAt: new Date().toISOString(),
  };

  global.apiFetch = async (url, opts = {}) => {
    requests.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('/checkin/stats')) {
      return { data: { stats: { registered: 3, checkedIn: 1, remaining: 2, rate: 33.33 }, recent: [] } };
    }
    return { data: nextResponse };
  };
  global.showToast = () => {};

  // --- load the real page script -------------------------------------------
  const code = fs.readFileSync(path.join(PROJECT, 'public/js/checkin.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(code)();
  doc.dispatch('DOMContentLoaded');

  console.log('=== THE SCANNER, HOWEVER IT IS CONFIGURED ===');

  for (const [label, suffix] of [['sends Enter', 'enter'], ['sends Tab', 'tab'], ['sends NO suffix', 'none']]) {
    requests.length = 0;
    scanWith(page.input, TOKEN, suffix);
    await wait(300);
    const scan = requests.find((r) => r.url.endsWith('/checkin'));
    check('scanner that ' + label + ' -> a scan is submitted', !!scan,
      'no POST was made; the operator would see nothing happen');
    if (scan) {
      check('   ...with the scanned code intact', scan.body.qrToken.includes(TOKEN), JSON.stringify(scan.body));
    }
    await wait(150);
  }

  console.log('');
  console.log('=== ONE SCAN MAKES ONE REQUEST ===');
  requests.length = 0;
  scanWith(page.input, TOKEN, 'enter');
  await wait(400);
  const scans = requests.filter((r) => r.url.endsWith('/checkin'));
  check('typing the code AND pressing Enter sends exactly one', scans.length === 1, scans.length + ' requests');

  console.log('');
  console.log('=== WHAT THE OPERATOR SEES ===');
  requests.length = 0;
  nextResponse = {
    ok: true, result: 'SUCCESS', message: 'Checked in.',
    participant: { name: 'Juan Dela Cruz', registrationNumber: 'REG-2026-000123', organizationPath: 'JPSME National' },
    checkedInAt: new Date().toISOString(),
  };
  scanWith(page.input, TOKEN, 'enter');
  await wait(300);
  check('success shows CHECKED IN', page.result.text.includes('CHECKED IN'), page.result.text);
  check('success names the person', page.result.text.includes('Juan Dela Cruz'), page.result.text);
  check('success shows the registration number', page.result.text.includes('REG-2026-000123'));
  check('success panel turns green', page.result.className.includes('green'), page.result.className);

  nextResponse = { ok: false, result: 'WRONG_EVENT', message: 'This code is registered for a different event.',
    participant: { name: 'Maria Santos', registrationNumber: 'REG-2026-000999' } };
  scanWith(page.input, 'b'.repeat(64), 'enter');
  await wait(300);
  check('wrong event shows WRONG EVENT', page.result.text.includes('WRONG EVENT'), page.result.text);
  check('wrong event still names them, so staff can help', page.result.text.includes('Maria Santos'));
  check('refusal panel turns red', page.result.className.includes('red'), page.result.className);

  nextResponse = { ok: false, result: 'ALREADY_CHECKED_IN', message: 'This person has already been checked in.',
    participant: { name: 'Juan Dela Cruz', registrationNumber: 'REG-2026-000123' },
    checkedInAt: new Date().toISOString() };
  scanWith(page.input, TOKEN, 'enter');
  await wait(300);
  check('duplicate shows ALREADY CHECKED IN', page.result.text.includes('ALREADY CHECKED IN'), page.result.text);
  check('duplicate panel is amber, not red', page.result.className.includes('amber'), page.result.className);

  console.log('');
  console.log('=== READY FOR THE NEXT PERSON ===');
  check('the input is cleared after a scan', page.input.value === '', JSON.stringify(page.input.value));
  check('focus is back on the input', global.document.activeElement === page.input);

  console.log('');
  console.log('=== THE STATION IS SENT WITH THE SCAN ===');
  page.station.value = 'ENTRANCE-02';
  requests.length = 0;
  scanWith(page.input, TOKEN, 'enter');
  await wait(300);
  const withStation = requests.find((r) => r.url.endsWith('/checkin'));
  check('scannerIdentifier travels with the scan',
    withStation && withStation.body.scannerIdentifier === 'ENTRANCE-02',
    withStation ? JSON.stringify(withStation.body) : 'no request');

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run();
