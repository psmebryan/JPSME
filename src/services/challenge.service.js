const crypto = require('crypto');

// A visible challenge the server owns end to end: no keys, no third party, no
// external request. It exists because Turnstile only does anything once its
// keys are configured, and a site with no keys yet would otherwise have nothing
// a person can actually see working.
//
// This is deliberately the weaker of the two. Distorted text is beatable by
// anyone who points OCR at it; what it stops is the ordinary case — a script
// POSTing at a form endpoint, which has no idea a challenge exists and cannot
// answer one. When Turnstile keys are present this steps aside for it.

// No 0/O, 1/I/L, 5/S, 2/Z. A challenge a person misreads is a challenge that
// fails an honest visitor, which costs more than the marginal difficulty it
// adds for a machine.
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789';
const LENGTH = 5;
const TTL_MS = 10 * 60 * 1000;

function randomText() {
  const bytes = crypto.randomBytes(LENGTH);
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Stored as a hash, like every other secret here — a session store is a
// database, and the answer sitting in it in the clear would be readable by
// anything that can read sessions.
function hashAnswer(text) {
  return crypto.createHash('sha256').update(String(text).trim().toUpperCase()).digest('hex');
}

function randomBetween(min, max) {
  return min + (crypto.randomBytes(2).readUInt16BE(0) / 65536) * (max - min);
}

// Hand-built SVG rather than a raster library: it adds no dependency, scales
// without blurring on a phone, and can be inlined straight into the page, which
// matters because the CSP here allows no external images.
function renderSvg(text) {
  const W = 180;
  const H = 60;
  const parts = [];

  // Confusion lines drawn under the glyphs. Enough to break a naive contour
  // trace, few enough that a person still reads it at a glance.
  for (let i = 0; i < 5; i += 1) {
    parts.push(
      `<path d="M${randomBetween(0, 30).toFixed(1)},${randomBetween(0, H).toFixed(1)} `
      + `Q${randomBetween(60, 120).toFixed(1)},${randomBetween(0, H).toFixed(1)} `
      + `${randomBetween(150, W).toFixed(1)},${randomBetween(0, H).toFixed(1)}" `
      + `fill="none" stroke="#94a3b8" stroke-width="${randomBetween(0.8, 1.6).toFixed(1)}" opacity="0.55"/>`
    );
  }

  const step = W / (text.length + 1);
  text.split('').forEach((ch, i) => {
    const x = step * (i + 1);
    const y = H / 2 + randomBetween(6, 12);
    const rotate = randomBetween(-24, 24);
    const size = randomBetween(26, 34);
    parts.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size.toFixed(1)}" `
      + `font-family="Georgia,'Times New Roman',serif" font-weight="700" fill="#1e293b" `
      + `transform="rotate(${rotate.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`
    );
  });

  for (let i = 0; i < 24; i += 1) {
    parts.push(`<circle cx="${randomBetween(0, W).toFixed(1)}" cy="${randomBetween(0, H).toFixed(1)}" r="${randomBetween(0.6, 1.6).toFixed(1)}" fill="#64748b" opacity="0.5"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Characters to type">`
    + `<rect width="${W}" height="${H}" fill="#f1f5f9"/>${parts.join('')}</svg>`;
}

// Issues a challenge and remembers only its hash on the session. One live
// challenge per session: asking for a new one abandons the old, so a script
// cannot stockpile answers to submit later.
function issue(session) {
  const text = randomText();
  session.challenge = {
    hash: hashAnswer(text),
    expiresAt: Date.now() + TTL_MS,
  };
  return { svg: renderSvg(text) };
}

// Consumes the challenge whether or not the answer was right. A wrong answer
// therefore costs a fresh challenge rather than another free guess at the same
// one, which is what keeps a five-character space from being worth grinding.
function verify(session, answer) {
  const challenge = session && session.challenge;
  if (session) delete session.challenge;

  if (!challenge) return false;
  if (challenge.expiresAt < Date.now()) return false;
  if (typeof answer !== 'string' || !answer.trim()) return false;

  const expected = Buffer.from(challenge.hash, 'hex');
  const supplied = Buffer.from(hashAnswer(answer), 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

module.exports = { issue, verify, LENGTH, TTL_MS };
