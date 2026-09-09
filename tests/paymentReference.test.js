// Tests for buildPaymentReference in payment.service.js.
//
// The reference is derived from the payment row rather than stored, so its
// stability is a property of this function rather than of a column. That is the
// whole bet: an id never changes and neither does a creation date, so the same
// payment must always produce the same string — including after a restart, a
// deploy, or a year rolling over.
//
// Pure: no database, no fixtures.

const paymentService = require('../src/services/payment.service');

const { buildPaymentReference } = paymentService;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${err.message}`);
    failed += 1;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

test('reads as a reference number, padded to six digits', () => {
  assertEqual(
    buildPaymentReference({ id: 123, createdAt: new Date('2026-09-09T02:00:00Z') }),
    'PAY-2026-000123',
    'shape'
  );
});

test('the same payment always produces the same string', () => {
  // The reason this can be derived rather than stored. If it varied by when it
  // was asked, an admin reading it to a member today and tomorrow would give
  // two different answers.
  const payment = { id: 7, createdAt: new Date('2026-01-02T03:04:05Z') };
  const first = buildPaymentReference(payment);
  const second = buildPaymentReference({ ...payment });
  assertEqual(first, second, 'stable across calls');
  assertEqual(first, 'PAY-2026-000007', 'and the value itself');
});

test('a date string works as well as a Date', () => {
  // Prisma hands back Date objects, but the same row arrives as a string once
  // it has been through JSON — an API response, a cached payload.
  assertEqual(
    buildPaymentReference({ id: 42, createdAt: '2025-12-31T16:00:00.000Z' }),
    buildPaymentReference({ id: 42, createdAt: new Date('2025-12-31T16:00:00.000Z') }),
    'string and Date agree'
  );
});

test('the year comes from the payment, not from today', () => {
  // Otherwise every reference silently changes on 1 January.
  assertEqual(
    buildPaymentReference({ id: 5, createdAt: new Date('2019-06-01T00:00:00Z') }),
    'PAY-2019-000005',
    'an old payment keeps its own year'
  );
});

test('an id longer than six digits is not truncated', () => {
  // Padding is a minimum width, never a maximum. Truncating would make two
  // different payments share a reference, which is the one thing it must not do.
  assertEqual(
    buildPaymentReference({ id: 12345678, createdAt: new Date('2026-03-03T00:00:00Z') }),
    'PAY-2026-12345678',
    'full id kept'
  );
});

test('nothing to reference returns nothing, rather than a plausible-looking string', () => {
  // A row that has not been created yet has no identity. "PAY-2026-000000"
  // would look like a real reference and belong to nothing.
  assertEqual(buildPaymentReference(null), null, 'null payment');
  assertEqual(buildPaymentReference(undefined), null, 'undefined payment');
  assertEqual(buildPaymentReference({}), null, 'no id');
  assertEqual(buildPaymentReference({ id: 0 }), null, 'id zero is not a real row');
});

test('an unparseable date falls back rather than producing PAY-NaN', () => {
  const ref = buildPaymentReference({ id: 9, createdAt: 'not a date' });
  const year = new Date().getFullYear();
  assertEqual(ref, `PAY-${year}-000009`, 'uses the current year instead of NaN');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
