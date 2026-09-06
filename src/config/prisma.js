const fs = require('fs');
const path = require('path');

// Prisma chooses its query engine by sniffing the host's OpenSSL version. On
// some Linux images that sniff fails outright — it logs "failed to detect the
// libssl/openssl version" and falls back to openssl-1.1.x, then tries to load
// an engine needing libssl.so.1.1, which a modern distro does not ship. The
// process dies before the first query.
//
// binaryTargets cannot fix that on its own. The lookup uses the name detection
// produced, so listing more targets only decides whether the wrong name
// resolves to a file that exists (loads, then fails on the missing library) or
// to nothing at all (fails to find an engine). Either way it is the detection
// that is wrong, not the list.
//
// So when detection is unreliable, skip it: PRISMA_QUERY_ENGINE_LIBRARY names
// the engine file directly, and Prisma uses it without probing anything. This
// picks the OpenSSL 3 engine that generate actually produced.
//
// Deliberately narrow. It only acts on Linux, only when the variable is not
// already set — an explicit value from the environment always wins — and only
// when the file is really there. Anywhere else, including every Windows
// development machine, this does nothing at all.
function useOpenSsl3EngineIfNeeded() {
  if (process.platform !== 'linux') return;
  if (process.env.PRISMA_QUERY_ENGINE_LIBRARY) return;

  let clientDir;
  try {
    // The generated client, not the npm package: the engines sit beside it.
    clientDir = path.dirname(require.resolve('.prisma/client'));
  } catch (err) {
    return; // not generated yet — nothing to point at
  }

  // Which C library the host uses decides this, and it is not a guess: a musl
  // image (Alpine) has no glibc dynamic linker, so a glibc engine cannot even
  // start — it fails with "Error loading shared library ld-linux-x86-64.so.2",
  // which is precisely what happened here after the first override picked the
  // Debian engine on this host's recommendation.
  //
  // Node reports the runtime glibc version, and on musl there is none. That is
  // a direct reading of the host rather than another inference from a platform
  // name, which is what got this wrong twice.
  let isMusl = false;
  try {
    isMusl = !process.report.getReport().header.glibcVersionRuntime;
  } catch (err) {
    isMusl = false; // unreadable — assume glibc, the commoner case
  }

  const candidates = isMusl
    ? ['libquery_engine-linux-musl-openssl-3.0.x.so.node']
    : [
      'libquery_engine-debian-openssl-3.0.x.so.node',
      'libquery_engine-rhel-openssl-3.0.x.so.node',
    ];

  for (const name of candidates) {
    const full = path.join(clientDir, name);
    if (fs.existsSync(full)) {
      process.env.PRISMA_QUERY_ENGINE_LIBRARY = full;
      return;
    }
  }
}

// Runs before @prisma/client is required, so the variable is in place by the
// time anything reads it.
useOpenSsl3EngineIfNeeded();

// eslint-disable-next-line import/order
const { PrismaClient } = require('@prisma/client');

// Single shared Prisma instance for the whole app (avoids exhausting DB connections).
const prisma = new PrismaClient();

module.exports = prisma;
