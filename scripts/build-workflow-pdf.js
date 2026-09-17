// Builds a workflow PDF for a designer — somebody who has to draw screens for
// this system without being able to read the code.
//
// Written as a generator rather than a hand-made document so it can be rebuilt
// when the system changes, and so the lists of screens and states come from the
// same names the code actually uses. A design that invents a status the system
// does not have produces screens nobody can build.
//
//   node scripts/build-workflow-pdf.js
//
// Uses PDFKit, already a dependency because e-tickets are PDFs.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// The public site's real palette, lifted from views/layout.ejs so a designer
// working from this document picks the colours the site already uses.
const NAVY = '#101934';
const NAVY_DEEP = '#080f29';
const CARD = '#111b3a';
const GOLD = '#fbbf24';
const INK = '#0f172a';
const MUTED = '#5b6785';
const RULE = '#d5dbe8';
const GREEN = '#15803d';
const ORANGE = '#c2570c';
const RED = '#b91c1c';

const OUT = path.join(__dirname, '..', 'docs', 'JPSME-workflow.pdf');

const doc = new PDFDocument({
  size: 'A4',
  // Required for the footer pass at the end: without it switchToPage cannot
  // reach a page already written, and bufferedPageRange reports only one.
  bufferPages: true,
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  info: {
    Title: 'JPSME 2.0 — How the system works',
    Author: 'JPSME',
    Subject: 'Screen and flow reference for design',
  },
});

const W = doc.page.width - 112; // usable width inside the margins
let sectionNo = 0;

// --- small helpers ----------------------------------------------------------

function space(n = 10) {
  doc.moveDown(n / 12);
}

// Back to the left margin.
//
// PDFKit remembers the x of the last text call, so a block written at an indent
// — a bullet at 72, a table's right column at 439 — leaves every following
// unpositioned heading and paragraph starting there, with its full width still
// applied. The result is text running off the right edge of the page. Every
// block-level helper below starts here.
function left() {
  doc.x = 56;
}

// A new page when the next block would not fit. Called before anything that
// should not be split across a page break.
function need(height) {
  if (doc.y + height > doc.page.height - 70) doc.addPage();
}

function h1(text) {
  left();
  sectionNo += 1;
  need(90);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(9)
    .text(`SECTION ${String(sectionNo).padStart(2, '0')}`, { characterSpacing: 1.5 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(text);
  doc.moveTo(56, doc.y + 6).lineTo(56 + W, doc.y + 6).strokeColor(RULE).lineWidth(1).stroke();
  space(18);
}

function h2(text) {
  left();
  need(60);
  space(8);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(text);
  space(6);
}

function p(text, opts = {}) {
  left();
  doc.fillColor(opts.color || MUTED).font('Helvetica').fontSize(9.5)
    .text(text, { width: W, align: 'left', lineGap: 2.5, ...opts });
  space(6);
}

function bullets(items) {
  left();
  items.forEach((item) => {
    need(24);
    const y = doc.y;
    doc.circle(61, y + 5.5, 1.7).fillColor(GOLD).fill();
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
      .text(item, 72, y, { width: W - 16, lineGap: 2.5 });
    space(5);
  });
  space(4);
}

// A labelled note in a tinted block — used for the things a designer will get
// wrong if nobody tells them.
function note(title, text, tone = GOLD) {
  left();
  const body = `${title}  ${text}`;
  // The font must be set BEFORE measuring: heightOfString measures in whatever
  // font happens to be current, so measuring first sized the box against the
  // previous block's font and the text overflowed its own background.
  doc.font('Helvetica').fontSize(9);
  const height = doc.heightOfString(body, { width: W - 28, lineGap: 2.5 }) + 22;
  need(height + 10);
  const top = doc.y;
  doc.roundedRect(56, top, W, height, 4).fillColor('#fbfaf4').fill();
  doc.rect(56, top, 3, height).fillColor(tone).fill();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(title, 70, top + 10, { width: W - 28, continued: true });
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`  ${text}`, { width: W - 28, lineGap: 2.5 });
  doc.y = top + height + 10;
}

// A two-column reference table. `rows` is [[left, right], ...].
function table(rows, leftWidth = 150) {
  left();
  rows.forEach(([left, right], i) => {
    const rightWidth = W - leftWidth - 14;
    const h = Math.max(
      doc.heightOfString(left, { width: leftWidth, lineGap: 2 }),
      doc.heightOfString(right, { width: rightWidth, lineGap: 2 })
    ) + 11;
    need(h + 6);
    const top = doc.y;
    if (i % 2 === 0) doc.rect(56, top - 3, W, h).fillColor('#f8fafc').fill();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5).text(left, 62, top + 1, { width: leftWidth, lineGap: 2 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
      .text(right, 62 + leftWidth + 8, top + 1, { width: rightWidth, lineGap: 2 });
    doc.y = top + h;
  });
  space(10);
}

// A flow drawn as boxes with arrows between them, wrapping across rows.
function flow(steps) {
  left();
  const boxW = (W - 3 * 16) / 4;
  const boxH = 46;
  const rows = [];
  for (let i = 0; i < steps.length; i += 4) rows.push(steps.slice(i, i + 4));

  need(rows.length * (boxH + 22) + 10);
  rows.forEach((row) => {
    const top = doc.y;
    row.forEach((step, i) => {
      const x = 56 + i * (boxW + 16);
      doc.roundedRect(x, top, boxW, boxH, 4).fillColor(NAVY).fill();
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(6.5)
        .text(String(step.tag || '').toUpperCase(), x + 9, top + 8, { width: boxW - 18, characterSpacing: 0.8 });
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
        .text(step.label, x + 9, top + 19, { width: boxW - 18, lineGap: 1 });

      if (i < row.length - 1) {
        const ax = x + boxW + 4;
        const ay = top + boxH / 2;
        doc.moveTo(ax, ay).lineTo(ax + 8, ay).strokeColor(RULE).lineWidth(1.2).stroke();
        doc.moveTo(ax + 8, ay).lineTo(ax + 4.5, ay - 2.5).lineTo(ax + 4.5, ay + 2.5).fillColor(RULE).fill();
      }
    });
    doc.y = top + boxH + 16;
  });
  space(6);
}

// A state and what it means, with the colour the screen actually uses.
function states(rows) {
  left();
  rows.forEach(([name, colour, meaning]) => {
    const h = doc.heightOfString(meaning, { width: W - 150, lineGap: 2 }) + 12;
    need(h + 4);
    const top = doc.y;
    doc.roundedRect(58, top + 1, 9, 9, 2).fillColor(colour).fill()
      .strokeColor('#00000022').lineWidth(0.5).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5).text(name, 74, top, { width: 120 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
      .text(meaning, 200, top, { width: W - 148, lineGap: 2 });
    doc.y = top + h;
  });
  space(10);
}

// --- cover ------------------------------------------------------------------

doc.rect(0, 0, doc.page.width, doc.page.height).fillColor(NAVY_DEEP).fill();
doc.rect(0, 300, doc.page.width, 4).fillColor(GOLD).fill();

doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10)
  .text('JUNIOR PHILIPPINE SOCIETY OF MECHANICAL ENGINEERS', 56, 190, { width: W, characterSpacing: 2 });
doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(38)
  .text('How the system works', 56, 216, { width: W });
doc.fillColor('#94a3bd').font('Helvetica').fontSize(12)
  .text('Every screen, every flow, and every state a screen has to handle.', 56, 322, { width: W - 90, lineGap: 4 });

doc.fillColor('#94a3bd').font('Helvetica').fontSize(9)
  .text('A reference for designing screens for the JPSME membership and events platform. '
      + 'Written for somebody who has to draw these screens without reading the code: what each '
      + 'screen is for, who sees it, what it shows, and — the part usually missing — every state '
      + 'it can be in.',
  56, 400, { width: W - 60, lineGap: 4 });

doc.fillColor('#5b6785').font('Helvetica').fontSize(8)
  .text(`Generated ${new Date().toISOString().slice(0, 10)} from the running system`, 56, doc.page.height - 80, { width: W });

doc.addPage();

// --- 1. the shape of it -----------------------------------------------------

h1('The shape of it');

p('Three kinds of person use this system, and they see almost nothing in common. '
  + 'Designing for the wrong one is the easiest mistake to make here, so this is first.');

table([
  ['Member / visitor', 'The public site. Dark navy, gold accents, marketing-weight pages plus '
    + 'their own profile, tickets and seat. Mostly read on a phone.'],
  ['Chapter admin', 'The admin panel, light theme, but only their own chapter\'s members — and '
    + 'event-day stations at events they have been granted.'],
  ['Main admin', 'Everything: members, events, payments, certificates, settings, the audit log.'],
], 118);

note('The two themes are not one theme',
  'The public site is dark (#080f29 ground, white text, gold accents). The admin panel is light '
  + '(white cards, slate text, indigo accents). They share a logo and nothing else. Do not design '
  + 'one and assume the other.');

h2('The four things the system does');
bullets([
  'Membership — somebody signs up, verifies their email, pays a fee, and an admin approves them.',
  'Events — published events people register for, some of them with a fee.',
  'Event day — a registration desk and hall doors, both driven by QR scans.',
  'Records — certificates, reports, broadcast email, and an audit log of who did what.',
]);

// --- 2. becoming a member ---------------------------------------------------

h1('Flow: becoming a member');

flow([
  { tag: 'public', label: 'Sign up form' },
  { tag: 'email', label: 'Verify with a 6-digit code' },
  { tag: 'public', label: 'Human check' },
  { tag: 'public', label: 'Sign in' },
  { tag: 'member', label: 'Pay the membership fee' },
  { tag: 'admin', label: 'Admin approves' },
  { tag: 'member', label: 'Full member' },
]);

p('The verification step is the one with the most states, and the one most often drawn wrong. '
  + 'The code is sent automatically — the member never asks for it — and it expires in three '
  + 'minutes, shown as a draining ring rather than a number alone.');

h2('States the verification screen must cover');
table([
  ['Waiting', 'Six empty digit boxes, the ring full, the code already sent.'],
  ['Counting down', 'The ring drains over three minutes. Below it: "Didn\'t get the code? Resend" '
    + 'with a 60-second cooldown counting down before Resend becomes clickable again.'],
  ['Expired', 'The ring is empty. The only way forward is Resend.'],
  ['Wrong code', 'An error, and the digits they typed stay where they are.'],
  ['Human check failed', 'A new challenge image, and — importantly — the typed digits survive.'],
  ['Verified', 'Straight to sign-in with the email already filled in.'],
], 118);

note('Resend needs no human check',
  'Verifying does. The difference matters: a resend only re-sends a code to an address that is '
  + 'already on the account, so putting a puzzle in front of it is friction that protects nothing.');

// --- 3. attending an event --------------------------------------------------

h1('Flow: attending an event');

flow([
  { tag: 'public', label: 'Browse events' },
  { tag: 'public', label: 'Event details' },
  { tag: 'member', label: 'Register' },
  { tag: 'member', label: 'Pay, if the event has a fee' },
  { tag: 'member', label: 'Ticket with QR' },
  { tag: 'member', label: 'Choose a seat' },
  { tag: 'venue', label: 'Scan in at the desk' },
  { tag: 'venue', label: 'Scan into the hall' },
]);

h2('The ticket');
p('One screen a member will actually hold up at a door, so it is built for that: a QR on a '
  + 'deliberately white card even though the site is dark, because a scanner reads dark-on-light '
  + 'and an inverted code will not scan. Below the card, off it: their seat, their movements, and '
  + 'a button to choose or change a seat when the event uses assigned seating.');

h2('Choosing a seat');
p('A plan of the hall the member taps directly. Taking a seat is two steps, because the plan is '
  + 'being changed by other people while they look at it:');

table([
  ['1. Hold', 'Tap a free seat and it is held for five minutes, with the countdown on screen.'],
  ['2. Confirm', 'Confirm makes it theirs. Give up releases it immediately.'],
  ['If they lose it', '"Somebody just took that seat. Please pick another." This is normal, not an '
    + 'error, and must not be drawn as a failure.'],
], 118);

note('An attendee never sees another attendee\'s name',
  'On the member seat plan, held / assigned / occupied / stepped-out all look identical — simply '
  + '"taken". Only their own seat is distinct. Which seat belongs to whom, and whether that person '
  + 'is currently in the room, is staff information.');

// --- 4. event day -----------------------------------------------------------

h1('Flow: the event day');

p('Two stations, and keeping them apart is the whole design. There was once a third — a venue '
  + 'entrance — and it was removed: for a single-hall event it asked a question the hall door had '
  + 'already answered.');

flow([
  { tag: 'station 1', label: 'Registration desk' },
  { tag: 'station 2', label: 'Hall door' },
]);

table([
  ['Registration desk', 'Scan a ticket to LOOK SOMEBODY UP — it admits nobody by itself. Staff '
    + 'then give them a seat, and only then check them in. Happens once per person.'],
  ['Hall door', 'In and out of the hall, as often as somebody comes and goes. One scan does both: '
    + 'the server decides the direction from where the person currently is.'],
], 118);

note('One button, not two',
  'The hall door has a single scan action. An operator with a queue in front of them must not have '
  + 'to choose between "in" and "out" — so the screen shows the direction as the RESULT of a scan, '
  + 'in the largest type on the page.');

h2('What a scan screen must show');
bullets([
  'A verdict readable from arm\'s length — the operator is standing, holding a scanner.',
  'The person\'s name and registration number, large.',
  'Colour that separates came-in from went-out from refused, at a glance.',
  'A live count of how many people are in the hall.',
  'Nothing that needs a mouse. The screen refocuses its own input after every scan.',
]);

h2('Scan results a screen has to handle');
states([
  ['ENTERED', '#16a34a', 'Came into the hall. Green.'],
  ['LEFT', '#0284c7', 'Went out. Blue — not green, and not red.'],
  ['ALREADY SCANNED', '#f59e0b', 'The gun fired twice, or the operator rescanned. Nothing is '
    + 'wrong and nothing changed. Amber.'],
  ['ROOM FULL', '#dc2626', 'The hall is at capacity.'],
  ['REFUSED', '#dc2626', 'Not registered, cancelled, unpaid, wrong event, or an unreadable code. '
    + 'Always says which.'],
]);

// --- 5. the seat lifecycle --------------------------------------------------

h1('The seat lifecycle');

p('The part of the system with the most states, and the one a designer most needs a reference for. '
  + 'A seat moves through these on its own as people scan in and out of the hall.');

flow([
  { tag: 'nobody\'s', label: 'Available' },
  { tag: 'choosing', label: 'Held — 5 min' },
  { tag: 'theirs', label: 'Assigned' },
  { tag: 'in the hall', label: 'Occupied' },
  { tag: 'stepped out', label: 'Away' },
  { tag: 'gone 10 min', label: 'Available again' },
]);

h2('The six states, and the colours the admin plan uses');
states([
  ['AVAILABLE', '#ffffff', 'Nobody\'s. White with a grey border on the admin plan.'],
  ['HELD', '#fde68a', 'Somebody is choosing it right now. Expires after five minutes.'],
  ['ASSIGNED', '#c7d2fe', 'Theirs, but they have not been seen in the hall yet.'],
  ['OCCUPIED', '#16a34a', 'Theirs, and they are in the hall now.'],
  ['AWAY', '#fed7aa', 'Theirs, but they have walked out. Still theirs — for ten minutes.'],
  ['BLOCKED', '#cbd5e1', 'Not in use. Struck through.'],
]);

note('AWAY is the state the whole thing exists for',
  'It is a seat that looks empty from across the hall and is not free. Ten minutes after somebody '
  + 'leaves, their seat is released automatically and can be given to somebody else. Staff also get '
  + 'a "Stepped out" list — who left, how long ago, how long until the seat frees — with a Free '
  + 'button for when they know that person has gone home.', ORANGE);

// --- 6. screen inventory ----------------------------------------------------

h1('Every screen');

h2('Public and member');
table([
  ['/', 'Home. Hero, upcoming events, sponsors, stats.'],
  ['/about/…', 'Five pages: the society, quality policy, code of ethics, theme of the year, officers.'],
  ['/events', 'Event list.'],
  ['/events/:id', 'Event details, and the Register button in all its states.'],
  ['/events/:id/ticket', 'Their ticket: QR, seat, movements.'],
  ['/events/:id/seat', 'The seat plan they pick from.'],
  ['/articles, /articles/:id', 'News.'],
  ['/chapters, /organizations', 'The society\'s structure, browsable.'],
  ['/register, /login, /verify-email', 'Sign up, sign in, verify.'],
  ['/profile', 'Their membership, registrations, tickets, certificates.'],
  ['/membership-payment', 'GCash checkout for the membership fee.'],
], 132);

h2('Admin — event day');
table([
  ['/admin/check-in', 'Which events this account can work.'],
  ['…/attendance', 'Event day hub: the funnel, and a way into each station.'],
  ['…/desk', 'Registration desk: look up, seat, admit.'],
  ['…/rooms', 'The halls, with live occupancy.'],
  ['…/rooms/:id/scan', 'The hall door scanner.'],
  ['…/seating', 'The seat plan, the stepped-out list, and the build tools.'],
  ['…/check-in/report', 'Every scan that happened, including refusals.'],
], 132);

h2('Admin — everything else');
table([
  ['Members', 'Users, approvals, per-chapter member lists, organisation admins.'],
  ['Events', 'Create, edit, registrations, invitations, per-event email.'],
  ['Money', 'Payments, refunds, the membership fee setting.'],
  ['Records', 'Certificates, broadcast email, the audit log.'],
  ['Content', 'Articles, sponsors, site settings.'],
], 132);

// --- 7. statuses ------------------------------------------------------------

h1('Statuses, as the system names them');

p('These are the exact values the system stores. A design that invents a status outside these '
  + 'lists produces a screen nobody can build.');

table([
  ['Account status', 'PENDING · APPROVED · REJECTED'],
  ['Role', 'USER · CHAPTER_ADMIN · ADMIN'],
  ['Event registration', 'REGISTERED · PENDING_PAYMENT · CANCELLED'],
  ['Payment', 'PENDING · PROCESSING · PAID · FAILED · EXPIRED · CANCELLED · REFUNDED'],
  ['Seat', 'AVAILABLE · HELD · ASSIGNED · OCCUPIED · AWAY · BLOCKED'],
  ['Seat type', 'REGULAR · VIP · ACCESSIBLE · TABLE'],
  ['In the hall', 'INSIDE · OUTSIDE'],
  ['Scan result', 'SUCCESS · ALREADY_CHECKED_IN · DUPLICATE_SCAN · INVALID_QR · WRONG_EVENT · '
    + 'NOT_REGISTERED · CANCELLED · UNPAID · REJECTED · ROOM_FULL · ROOM_CLOSED · UNDONE'],
], 118);

// --- 8. constraints ---------------------------------------------------------

h1('Things that constrain the design');

p('Not preferences. These are properties of where this runs, and a design that ignores them cannot '
  + 'be built as drawn.');

h2('The public palette, as it actually is');
states([
  ['Page ground', NAVY_DEEP, '#080f29 — the darkest surface, behind everything.'],
  ['Card', CARD, '#111b3a — panels and cards on the public site.'],
  ['Deep panel', '#0a1128', '#0a1128 — insets and tinted blocks.'],
  ['Accent', GOLD, '#fbbf24 — the one accent. Links, emphasis, active states.'],
  ['Body text', '#94a3bd', '#94a3bd — secondary text on dark. Headings are white.'],
  ['Border', '#263b70', '#263b70 — separators on dark.'],
]);

h2('Constraints worth knowing before drawing');
bullets([
  'No external fonts or scripts. The site loads nothing from a CDN, so a design that depends on '
  + 'a hosted webfont needs that font embedded instead.',
  'Uploaded images are capped at 5 MB and stored in the database in pieces. Avoid designs needing '
  + 'many large images per page.',
  'The QR on a ticket must stay dark-on-light with a quiet zone around it, whatever the surrounding '
  + 'theme. This is a scanning requirement, not a style choice.',
  'Scanner screens are used standing up, one-handed, at arm\'s length, sometimes in a noisy hall. '
  + 'Large type, strong colour, no small targets.',
  'Every list can be empty on a fresh deployment. Empty states need designing, not leaving blank.',
  'Tables on phones must scroll inside their own container — the page itself must never scroll '
  + 'sideways.',
]);

note('If you change one thing, make it the empty and error states',
  'Most screens here are drawn well for the happy path and thinly for everything else. The refusal '
  + 'at a door, the seat somebody just lost, the expired code, the event with no registrations yet '
  + '— these are the screens staff and members actually remember.');

// --- footers ----------------------------------------------------------------

const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i += 1) {
  doc.switchToPage(range.start + i);
  if (i === 0) continue; // the cover carries no footer
  const y = doc.page.height - 42;
  doc.moveTo(56, y - 8).lineTo(56 + W, y - 8).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text('JPSME 2.0 — how the system works', 56, y, { width: W / 2 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text(String(i), 56 + W / 2, y, { width: W / 2, align: 'right' });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const stream = fs.createWriteStream(OUT);
doc.pipe(stream);
doc.end();
stream.on('finish', () => {
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`${OUT}  (${range.count} pages, ${kb} KB)`);
});
