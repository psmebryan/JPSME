// Regression tests for paymongo.service.js's error-handling, specifically the
// bug where a missing PAYMONGO_SECRET_KEY (a 503 config error) got caught by
// paymongoRequest's network-error handler and rewritten into a misleading 502
// "could not reach the gateway". Found during Phase 2 live testing of the
// event-registration-fee feature.
//
// This project has no test framework installed — everything else in this
// codebase has been verified via live/mocked Node scripts rather than a
// formal suite, so these follow the same convention: plain assertions,
// pass/fail printed per case, non-zero exit on failure.
//
// Run: node tests/paymongo.service.test.js  (or `npm run test:paymongo`)

const assert = require('assert');
const paymongoService = require('../src/services/paymongo.service');

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
  }
}

const CHECKOUT_ARGS = {
  amountCentavos: 1000,
  description: 'test',
  referenceNumber: 'test-ref',
  successUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel',
  metadata: {},
};

async function run() {
  await test('missing PAYMONGO_SECRET_KEY produces a 503 config error, not a 502 network error', async () => {
    delete process.env.PAYMONGO_SECRET_KEY;
    const originalFetch = global.fetch;
    let fetchWasCalled = false;
    global.fetch = async () => {
      fetchWasCalled = true;
      throw new Error('fetch must never be reached when the key is missing');
    };

    try {
      await paymongoService.createGcashCheckout(CHECKOUT_ARGS);
      assert.fail('expected createGcashCheckout to throw');
    } catch (err) {
      assert.strictEqual(err.statusCode, 503, `expected statusCode 503, got ${err.statusCode}`);
      assert.match(err.message, /not configured/i);
      // The error message must never leak the key itself (there is none to
      // leak here, but this guards against a future regression that
      // interpolates the raw env value into the message).
      assert.ok(!/sk_(test|live)_/.test(err.message), 'error message must not contain a PayMongo key');
      assert.strictEqual(fetchWasCalled, false, 'fetch must never be attempted when the key is missing');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('a configured key allows a normal request to reach fetch and succeed', async () => {
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake_for_unit_test';
    const originalFetch = global.fetch;
    let capturedAuth = null;
    global.fetch = async (url, options) => {
      capturedAuth = options.headers.Authorization;
      return {
        ok: true,
        json: async () => ({ data: { id: 'cs_test_123', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_test_123' } } }),
      };
    };

    try {
      const result = await paymongoService.createGcashCheckout(CHECKOUT_ARGS);
      assert.strictEqual(result.checkoutId, 'cs_test_123');
      assert.strictEqual(result.checkoutUrl, 'https://checkout.paymongo.com/cs_test_123');
      assert.ok(capturedAuth && capturedAuth.startsWith('Basic '), 'expected a Basic auth header on the request');
    } finally {
      global.fetch = originalFetch;
      delete process.env.PAYMONGO_SECRET_KEY;
    }
  });

  await test('a genuine network failure still produces the existing 502 gateway-unreachable error', async () => {
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake_for_unit_test';
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.paymongo.com');
    };

    try {
      await paymongoService.createGcashCheckout(CHECKOUT_ARGS);
      assert.fail('expected createGcashCheckout to throw');
    } catch (err) {
      assert.strictEqual(err.statusCode, 502, `expected statusCode 502, got ${err.statusCode}`);
      assert.match(err.message, /could not reach/i);
      assert.ok(!err.message.includes('ENOTFOUND'), 'the raw network error / implementation detail must not reach the client message');
    } finally {
      global.fetch = originalFetch;
      delete process.env.PAYMONGO_SECRET_KEY;
    }
  });

  await test('a genuine timeout still produces the existing 504 gateway-timeout error', async () => {
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake_for_unit_test';
    const originalFetch = global.fetch;
    global.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    };

    try {
      await paymongoService.createGcashCheckout(CHECKOUT_ARGS);
      assert.fail('expected createGcashCheckout to throw');
    } catch (err) {
      assert.strictEqual(err.statusCode, 504, `expected statusCode 504, got ${err.statusCode}`);
    } finally {
      global.fetch = originalFetch;
      delete process.env.PAYMONGO_SECRET_KEY;
    }
  });

  await test('a genuine PayMongo API rejection (non-2xx) still produces the existing 502 with the gateway detail, no stack trace', async () => {
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake_for_unit_test';
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ errors: [{ detail: 'amount must be at least 10000' }] }),
    });

    try {
      await paymongoService.createGcashCheckout(CHECKOUT_ARGS);
      assert.fail('expected createGcashCheckout to throw');
    } catch (err) {
      assert.strictEqual(err.statusCode, 502);
      assert.strictEqual(err.message, 'amount must be at least 10000');
      assert.ok(!/sk_(test|live)_/.test(err.message), 'error message must not contain a PayMongo key');
    } finally {
      global.fetch = originalFetch;
      delete process.env.PAYMONGO_SECRET_KEY;
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll paymongo.service.js error-handling tests passed.');
}

run();
