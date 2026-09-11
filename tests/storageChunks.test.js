// Tests for storing a file bigger than one database packet.
//
// The bug: uploading a 1.2 MB logo came back as a bare 500. Not a validation
// message, not a caught error — the MySQL connection was simply gone.
//
// MySQL refuses any single statement, or any single row it sends back, larger
// than max_allowed_packet. MariaDB does not refuse politely: it closes the
// connection, which surfaces as "Server has closed the connection" from
// whatever query happened to be running. The default is 1 MB — that is exactly
// what XAMPP ships — and on the live host it is a server setting we do not get
// to change. So "write the whole file into one LONGBLOB" could never work for
// a real logo, and the previous migration's own comment named that limit
// without noticing it applied.
//
// The fix is one chunk per row. What these check is that a file survives the
// trip in pieces: the same bytes, in the same order, with nothing of an older
// file left behind, and that no single row ever gets near a packet.

const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const driver = require('../src/services/storage/dbStorage.driver');

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

const PREFIX = 'uploads/__chunktest__';
let seq = 0;
const keyFor = (ext = '.png') => `${PREFIX}/file-${(seq += 1)}${ext}`;

// Random, not a run of one repeated byte: a chunk written twice, dropped, or
// reassembled out of order would still compare equal against a uniform buffer.
const noise = (bytes) => crypto.randomBytes(bytes);

async function cleanup() {
  await prisma.storedFile.deleteMany({ where: { key: { startsWith: PREFIX } } });
}

async function main() {
  await cleanup();

  const packet = Number(
    (await prisma.$queryRawUnsafe("SHOW VARIABLES LIKE 'max_allowed_packet'"))[0].Value
  );
  console.log(`(this server's max_allowed_packet is ${(packet / 1024 / 1024).toFixed(1)} MB)\n`);

  await test('a file larger than one packet survives the round trip', async () => {
    // The exact case that used to kill the connection.
    const key = keyFor();
    const original = noise(Math.round(packet * 1.2));
    await driver.save(original, key);

    const back = await driver.read(key);
    assertEqual(back.length, original.length, 'same length');
    assert(back.equals(original), 'and the same bytes, in the same order');
  });

  await test('a 5 MB file — the largest an upload allows — survives too', async () => {
    const key = keyFor();
    const original = noise(5 * 1024 * 1024);
    await driver.save(original, key);
    assert((await driver.read(key)).equals(original), 'identical');
  });

  await test('no single row is anywhere near a packet', async () => {
    // The property the whole fix rests on. A chunk size that crept up past the
    // limit would bring the bug back with no other test noticing.
    const key = keyFor();
    await driver.save(noise(3 * 1024 * 1024), key);

    const rows = await prisma.$queryRawUnsafe(
      'SELECT MAX(LENGTH(`data`)) AS biggest, COUNT(*) AS n FROM `stored_file_chunks` WHERE `key` = ?',
      key
    );
    const biggest = Number(rows[0].biggest);
    assert(Number(rows[0].n) > 1, 'it really was split up');
    assert(biggest <= 256 * 1024, `a chunk is at most 256 KB, got ${biggest}`);
    assert(biggest < packet / 2, `and well under this server's ${packet} byte packet`);
  });

  await test('a file smaller than one chunk is still one row', async () => {
    const key = keyFor();
    const original = noise(2000);
    await driver.save(original, key);

    const count = await prisma.storedFileChunk.count({ where: { key } });
    assertEqual(count, 1, 'no needless splitting');
    assert((await driver.read(key)).equals(original), 'identical');
  });

  await test('a file exactly one chunk long is not split', async () => {
    // Off-by-one at the boundary is how a file ends up with an empty trailing
    // row, or one byte short.
    const key = keyFor();
    const original = noise(256 * 1024);
    await driver.save(original, key);

    assertEqual(await prisma.storedFileChunk.count({ where: { key } }), 1, 'exactly one');
    assert((await driver.read(key)).equals(original), 'identical');
  });

  await test('one byte over a chunk is two rows, and still the same file', async () => {
    const key = keyFor();
    const original = noise(256 * 1024 + 1);
    await driver.save(original, key);

    assertEqual(await prisma.storedFileChunk.count({ where: { key } }), 2, 'two');
    const back = await driver.read(key);
    assertEqual(back.length, original.length, 'not one byte short');
    assert(back.equals(original), 'identical');
  });

  await test('a zero-byte file reads back as empty, not as missing', async () => {
    const key = keyFor();
    await driver.save(Buffer.alloc(0), key);
    assertEqual((await driver.read(key)).length, 0, 'empty');
  });

  await test('replacing a big file with a small one leaves no tail behind', async () => {
    // The failure this prevents is silent and ugly: the new logo with three
    // megabytes of the old one appended to it.
    const key = keyFor();
    await driver.save(noise(2 * 1024 * 1024), key);
    const small = noise(40 * 1024);
    await driver.save(small, key);

    const back = await driver.read(key);
    assertEqual(back.length, small.length, 'only the new file');
    assert(back.equals(small), 'identical');
    assertEqual(await prisma.storedFileChunk.count({ where: { key } }), 1, 'and only its rows remain');
  });

  await test('the recorded size is the file\'s, not a chunk\'s', async () => {
    // It is what the Content-Length header is set from — wrong here and the
    // browser is told to expect 256 KB of a 3 MB image.
    const key = keyFor();
    const original = noise(3 * 1024 * 1024);
    await driver.save(original, key);

    const row = await prisma.storedFile.findUnique({ where: { key } });
    assertEqual(row.size, original.length, 'the whole file');
  });

  await test('deleting a file takes its chunks with it', async () => {
    const key = keyFor();
    await driver.save(noise(1024 * 1024), key);
    await driver.delete(key);

    assertEqual(await prisma.storedFileChunk.count({ where: { key } }), 0, 'nothing orphaned');
    assertEqual(await driver.exists(key), false, 'and the file is gone');
  });

  await test('removing a folder takes every file under it, chunks included', async () => {
    const folder = `${PREFIX}/batch`;
    await driver.save(noise(600 * 1024), `${folder}/a.png`);
    await driver.save(noise(600 * 1024), `${folder}/b.png`);
    await driver.removeFolder(folder);

    const left = await prisma.storedFileChunk.count({ where: { key: { startsWith: folder } } });
    assertEqual(left, 0, 'no chunks left behind');
  });

  await test('a missing file still reports ENOENT, the way a filesystem would', async () => {
    let threw = null;
    try { await driver.read(`${PREFIX}/never-written.png`); } catch (err) { threw = err; }
    assert(threw, 'it threw');
    assertEqual(threw.code, 'ENOENT', 'shaped like the filesystem error callers handle');
  });

  await test('a file written before chunking existed is still readable', async () => {
    // The column is nullable and unused now, but anything already in it has to
    // keep working — the migration does not move rows.
    const key = keyFor();
    const legacy = noise(5000);
    await prisma.storedFile.create({
      data: { key, mimeType: 'image/png', size: legacy.length, data: legacy },
    });

    const back = await driver.read(key);
    assert(back.equals(legacy), 'read straight out of the old column');
  });

  await test('a readStream delivers the reassembled file', async () => {
    // Certificates are served through this path rather than through read().
    const key = keyFor('.pdf');
    const original = noise(700 * 1024);
    await driver.save(original, key);

    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = driver.readStream(key);
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    assert(Buffer.concat(chunks).equals(original), 'identical');
  });

  await test('two files written at once do not get each other\'s chunks', async () => {
    const a = keyFor();
    const b = keyFor();
    const fileA = noise(900 * 1024);
    const fileB = noise(900 * 1024);
    await Promise.all([driver.save(fileA, a), driver.save(fileB, b)]);

    assert((await driver.read(a)).equals(fileA), 'a is a');
    assert((await driver.read(b)).equals(fileB), 'b is b');
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
