// Builds the student-facing guide: activating an account from an emailed link,
// through to showing a QR at the registration desk.
//
//   node scripts/build-attendee-guide.js
//
// Written as a generator rather than a hand-made document for the same reason
// build-workflow-pdf.js is: every button name and page title here is the one
// the site actually renders, and when a screen changes this can be rebuilt
// instead of quietly going stale in somebody's Drive folder.
//
// The audience is a student on a phone, most likely reading this on the way to
// the venue. So: short sentences, one action per step, and the exact words that
// appear on the buttons — a guide that paraphrases a button is a guide that
// sends somebody hunting for something that is not there.
//
// Uses PDFKit, already a dependency because e-tickets are PDFs.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// The current brand palette, from tailwind.config.js. The older generator in
// this folder still carries the pre-2026 colours; these are the live ones.
const INK = '#131131';        // deepest ground
const INK_MID = '#25225d';
const GOLD = '#ecb827';       // the seal's gold
const BRONZE = '#785d12';     // gold-voiced text, where gold itself is unreadable
const BODY = '#423f52';
const MUTED = '#5f5c6e';
const RULE = '#dbd5c6';
const PAPER = '#f4f1e9';

const EVENT_NAME = '74th JPSME National Convention';

const doc = new PDFDocument({
  size: 'A4',
  bufferPages: true,
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  info: {
    Title: `JPSME — Activating your account and getting your ${EVENT_NAME} ticket`,
    Author: 'JPSME Philippines',
    Subject: 'Step-by-step guide for members',
  },
});

const M = 56;
const W = doc.page.width - M * 2;
let step = 0;

// --- block helpers -----------------------------------------------------------
//
// Every one of these starts by resetting x. PDFKit remembers the x of the last
// text call, so a block written at an indent leaves the NEXT unpositioned block
// starting there with its full width still applied — which runs text off the
// right edge of the page. That bug cost a rebuild of the other generator in this
// folder; the fix is that no helper here assumes where the cursor was left.
function left() {
  doc.x = M;
}

function space(n = 10) {
  doc.moveDown(n / 12);
}

// A new page when the next block would not fit, so a step is never split from
// its own heading.
function need(height) {
  if (doc.y + height > doc.page.height - 70) doc.addPage();
}

function h1(text, kicker) {
  left();
  need(100);
  if (kicker) {
    doc.fillColor(BRONZE).font('Helvetica-Bold').fontSize(9)
      .text(kicker.toUpperCase(), { characterSpacing: 1.6 });
    space(4);
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(19).text(text, { width: W });
  doc.moveTo(M, doc.y + 7).lineTo(M + W, doc.y + 7).strokeColor(RULE).lineWidth(1).stroke();
  space(20);
}

function p(text, opts = {}) {
  left();
  doc.fillColor(opts.color || BODY).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5)
    .text(text, { width: W, lineGap: 3, ...opts });
  space(8);
}

// One numbered step: a gold disc with the number, the instruction beside it,
// and an optional "what you will see" line underneath.
function stepBlock(title, body, seen) {
  left();
  step += 1;

  // Measured with the right font set FIRST — heightOfString measures in
  // whatever font is current, so measuring before setting it sizes the block
  // against the previous one and the text overflows.
  doc.font('Helvetica').fontSize(10.5);
  const bodyH = doc.heightOfString(body, { width: W - 46, lineGap: 3 });
  doc.font('Helvetica-Oblique').fontSize(9.5);
  const seenH = seen ? doc.heightOfString(seen, { width: W - 46, lineGap: 2.5 }) + 8 : 0;
  need(bodyH + seenH + 46);

  const top = doc.y;
  doc.circle(M + 12, top + 11, 12).fillColor(GOLD).fill();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
    .text(String(step), M, top + 6, { width: 24, align: 'center' });

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12.5)
    .text(title, M + 34, top + 2, { width: W - 34 });
  doc.fillColor(BODY).font('Helvetica').fontSize(10.5)
    .text(body, M + 34, doc.y + 4, { width: W - 46, lineGap: 3 });

  if (seen) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
      .text(seen, M + 34, doc.y + 5, { width: W - 46, lineGap: 2.5 });
  }
  doc.y += 16;
  left();
}

// A tinted aside for the things people get stuck on.
function note(title, text, tone = GOLD) {
  left();
  doc.font('Helvetica').fontSize(9.5);
  const height = doc.heightOfString(`${title}  ${text}`, { width: W - 30, lineGap: 2.5 }) + 24;
  need(height + 12);
  const top = doc.y;
  doc.roundedRect(M, top, W, height, 5).fillColor('#fdfbf3').fill();
  doc.rect(M, top, 3.5, height).fillColor(tone).fill();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
    .text(title, M + 16, top + 11, { width: W - 30, continued: true });
  doc.fillColor(BODY).font('Helvetica').fontSize(9.5)
    .text(`  ${text}`, { width: W - 30, lineGap: 2.5 });
  doc.y = top + height + 12;
}

// A row of "if this, do that" pairs — the troubleshooting table.
function faq(rows) {
  left();
  rows.forEach(([problem, answer]) => {
    doc.font('Helvetica-Bold').fontSize(10);
    const qH = doc.heightOfString(problem, { width: W });
    doc.font('Helvetica').fontSize(10);
    const aH = doc.heightOfString(answer, { width: W, lineGap: 3 });
    need(qH + aH + 26);

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(problem, M, doc.y, { width: W });
    doc.fillColor(BODY).font('Helvetica').fontSize(10)
      .text(answer, M, doc.y + 3, { width: W, lineGap: 3 });
    doc.y += 14;
    left();
  });
}

// =============================================================================
// COVER
// =============================================================================

doc.rect(0, 0, doc.page.width, doc.page.height).fillColor(INK).fill();

// A drafting grid, faint, so the cover is not a flat rectangle. Drawn rather
// than an image because the seal is an SVG and PDFKit does not read SVG.
doc.save();
for (let x = 0; x < doc.page.width; x += 42) {
  doc.moveTo(x, 0).lineTo(x, doc.page.height).strokeColor('#ecb827').opacity(0.05).lineWidth(0.6).stroke();
}
for (let y = 0; y < doc.page.height; y += 42) {
  doc.moveTo(0, y).lineTo(doc.page.width, y).strokeColor('#ecb827').opacity(0.05).lineWidth(0.6).stroke();
}
doc.restore();

// A gear, as the mark. Simple trapezoidal teeth on two circles.
(function gear(cx, cy, r, teeth) {
  const step2 = (Math.PI * 2) / teeth;
  doc.save();
  doc.strokeColor(GOLD).opacity(0.9).lineWidth(1.6);
  doc.circle(cx, cy, r * 0.62).stroke();
  doc.circle(cx, cy, r * 0.22).stroke();
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step2;
    const inner = r * 0.62;
    const outer = r * 0.78;
    const half = step2 * 0.2;
    doc.moveTo(cx + inner * Math.cos(a - half), cy + inner * Math.sin(a - half));
    doc.lineTo(cx + outer * Math.cos(a - half * 0.7), cy + outer * Math.sin(a - half * 0.7));
    doc.lineTo(cx + outer * Math.cos(a + half * 0.7), cy + outer * Math.sin(a + half * 0.7));
    doc.lineTo(cx + inner * Math.cos(a + half), cy + inner * Math.sin(a + half));
    doc.stroke();
  }
  doc.restore();
}(doc.page.width / 2, 210, 96, 20));

doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(42)
  .text('JPSME', M, 330, { width: W, align: 'center', characterSpacing: 3 });
doc.fillColor('#d3d2e5').font('Helvetica').fontSize(10.5)
  .text('JUNIOR PHILIPPINE SOCIETY OF MECHANICAL ENGINEERS', M, 382,
    { width: W, align: 'center', characterSpacing: 1.4 });

doc.moveTo(M + 110, 410).lineTo(doc.page.width - M - 110, 410).strokeColor(GOLD).opacity(0.5).lineWidth(0.8).stroke();
doc.opacity(1);

doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
  .text('Getting your ticket', M, 440, { width: W, align: 'center' });
doc.fillColor('#b7b6ce').font('Helvetica').fontSize(12)
  .text(`Activate your account, register, and show your QR at the ${EVENT_NAME}`,
    M + 40, 470, { width: W - 80, align: 'center', lineGap: 3 });

doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(9)
  .text('A GUIDE FOR MEMBERS', M, 560, { width: W, align: 'center', characterSpacing: 1.8 });

doc.fillColor('#8685a3').font('Helvetica').fontSize(9)
  .text('About 10 minutes. You can do all of it on your phone.',
    M, 690, { width: W, align: 'center' });

// =============================================================================
// WHAT YOU NEED
// =============================================================================

doc.addPage();
h1('Before you start', 'What you need');

p('Your chapter has created a JPSME account for you and sent an activation email. '
  + 'You cannot sign in until you open the link in it — the account has no password yet, '
  + 'and nobody at JPSME has one for you either.');

note('Cannot find the email?',
  'Check your spam or promotions folder, and search for "Activate your JPSME account". '
  + 'If it is genuinely not there, ask your chapter officer to send it again — they can do '
  + 'that from the admin page in a few seconds.');

p('You will need:', { bold: true, color: INK });
[
  'The email address your chapter used for you.',
  'The activation email itself.',
  'A phone or laptop with a browser.',
  'A password you will remember. Nobody at JPSME can see it or look it up.',
].forEach((item) => {
  left();
  need(22);
  const y = doc.y;
  doc.circle(M + 5, y + 5.5, 1.8).fillColor(GOLD).fill();
  doc.fillColor(BODY).font('Helvetica').fontSize(10.5)
    .text(item, M + 16, y, { width: W - 16, lineGap: 3 });
  space(5);
});
space(10);

note('The link expires', 'An activation link works for 14 days and can only be used once. '
  + 'After that it stops working and you will need a new one. Nothing is lost — ask for another.');

// =============================================================================
// PART ONE — THE ACCOUNT
// =============================================================================

doc.addPage();
h1('Setting up your account', 'Part one');

stepBlock(
  'Open the activation email',
  'Find the email titled "Activate your JPSME account" and tap the gold button that says '
  + '"Activate my account". If the button does not work, copy the long link underneath it '
  + 'and paste it into your browser.',
  'The page that opens says "Activate your account" and greets you by your first name.',
);

stepBlock(
  'Choose your password',
  'Type a password at least 8 characters long, then type the same one again in '
  + '"Confirm password" so you know you have not mistyped it.',
  'This is yours alone. Nobody at JPSME, including administrators, can see it.',
);

stepBlock(
  'Choose your school or organization',
  'Below the password there is a box that says "Your school or organization". Start typing '
  + 'your school and pick it from the list that appears. If you would rather browse, use the '
  + 'step-by-step menus underneath it instead.',
  'Pick the one you actually belong to. Your chapter left this blank on purpose, because you '
  + 'know it and they would be guessing.',
);

stepBlock(
  'Press "Activate my account"',
  'That is the whole setup. Your email address is confirmed at the same moment, so there is '
  + 'no separate code to type in.',
  'You will see "Your account is ready", and a button to sign in.',
);

stepBlock(
  'Sign in',
  'Use your email address and the password you just chose.',
  'You are now a full member on the site.',
);

note('Do not share the link',
  'Anyone who opens your activation link can set the password on your account. Treat it like '
  + 'a key, not like an invitation.');

// =============================================================================
// PART TWO — THE EVENT
// =============================================================================

doc.addPage();
step = 0;
h1(`Registering for the ${EVENT_NAME}`, 'Part two');

stepBlock(
  'Open Events',
  'From the top menu, tap "Events". Find the convention in the list and open it.',
  'You can also reach it from the home page, under "Upcoming Events & Assemblies".',
);

stepBlock(
  'Press "Register for this event"',
  'One press is all it takes — your details are already on your account, so there is no form '
  + 'to fill in again.',
  'The button changes to "Registered" and a "View ticket" link appears beside it.',
);

stepBlock(
  'Open your ticket',
  'Tap "View ticket". You can always come back to it later from your profile, under '
  + '"My Registrations".',
  'Your ticket shows your name, your registration number, and a large QR code.',
);

stepBlock(
  'Choose your seat, if you are asked to',
  'Some events have assigned seating. If yours does, a "Choose my seat" button appears under '
  + 'the ticket. Tap it, pick a free seat from the plan, and confirm.',
  'Not every event uses seating. If you do not see the button, there is nothing to choose.',
);

note('Registering is free unless the event says otherwise',
  'If the convention charges a fee, the button will say "Register & Pay" instead and will take '
  + 'you to the payment step first. Your ticket appears once the payment is confirmed.');

// =============================================================================
// PART THREE — SAVING IT
// =============================================================================

doc.addPage();
step = 0;
h1('Saving your ticket', 'Part three');

p('Do this before you travel. Venue wifi and mobile data are not reliable, and a ticket you '
  + 'cannot load is a ticket you cannot show.', { color: INK, bold: true });

stepBlock(
  'Save the QR as a picture',
  'On your ticket page, tap "Save ticket image". This saves the QR code to your phone as a '
  + 'picture, named after your registration number.',
  'This saves the QR code only — not your name or the event. It is what the scanner reads, '
  + 'and it works with no signal.',
);

stepBlock(
  'Or download the print-ready PDF',
  'Tap "Print-ready PDF". This one has everything on it: your name, your registration number, '
  + 'your seat if you have one, and the QR.',
  'Best if you want to print it, or if you would rather hand over paper than your phone.',
);

note('Do both, if you can',
  'Save the picture to your phone AND keep the PDF. If your screen will not scan, the printed '
  + 'copy will — and if you forget the paper, your phone still has it.');

note('Your QR is only yours',
  'It belongs to your registration alone and admits one person. Do not post it publicly or '
  + 'send it to friends — anyone holding it can be checked in as you.', '#803636');

// =============================================================================
// PART FOUR — AT THE VENUE
// =============================================================================

doc.addPage();
step = 0;
h1('At the registration desk', 'Part four');

stepBlock(
  'Have your QR open before you reach the front',
  'Open the saved picture, or your ticket page, while you are still in the queue. The desk '
  + 'moves faster and so do you.',
  '',
);

stepBlock(
  'Turn your screen brightness up',
  'This is the single most common reason a scan fails. A dim screen under bright hall lighting '
  + 'is hard for a scanner to read.',
  'Turning off auto-brightness for the day helps too.',
);

stepBlock(
  'Hold it steady for the scanner',
  'Hold the phone flat, about a hand-span from the scanner, and wait a moment. The desk will '
  + 'tell you straight away whether you are in.',
  '',
);

space(6);
faq([
  ['"Already checked in"',
    'Somebody has already been admitted with your QR. If that was not you, say so at the desk '
    + 'right away — they can see when it happened and can put it right.'],
  ['"QR code not recognised"',
    'Either the image is not your JPSME ticket, or the screen is too dim to read. Turn the '
    + 'brightness up and try again, or show the desk your registration number instead.'],
  ['"This code is registered for a different event"',
    'You have opened the ticket for another JPSME event. Go back to your profile, under '
    + '"My Registrations", and open the one for this convention.'],
  ['Your phone is dead, or you forgot everything',
    'Give the desk your name or your registration number (it looks like REG-2026-000123). '
    + 'They can find you and check you in by hand.'],
]);

// =============================================================================
// IF SOMETHING GOES WRONG
// =============================================================================

doc.addPage();
h1('If something goes wrong', 'Help');

faq([
  ['"This link cannot be used"',
    'Your activation link has expired, or it has already been used. Ask your chapter officer '
    + 'to send you a new one.'],
  ['"This account has not been activated yet" when signing in',
    'You have not finished the activation link yet. Find the email and open the link — until '
    + 'then there is no password that will work, including any you have tried.'],
  ['You forgot your password after activating',
    'On the sign-in page, tap "Forgot your password?" and enter your email. You will get a '
    + 'link to choose a new one. That link lasts one hour.'],
  ['Your email address is wrong',
    'Ask your chapter officer to correct it. They can change it for you, and you will get a '
    + 'fresh link at the new address.'],
  ['You picked the wrong school when activating',
    'Ask your chapter officer — they can move you to the right organization.'],
  ['You cannot find your ticket again',
    'Sign in, open your profile, and look under "My Registrations". Every event you have '
    + 'registered for is listed there with a link to its ticket.'],
]);

space(10);
note('Still stuck?',
  'Contact your chapter officer first — most of the above they can fix in under a minute. '
  + 'For anything else, use the Contact Us page on the JPSME website.');

// =============================================================================
// FOOTERS
// =============================================================================

const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i += 1) {
  doc.switchToPage(i);
  // Skip the cover, which is a dark full-bleed page a footer would sit badly on.
  if (i === range.start) continue;
  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
    .text('JPSME Philippines', M, doc.page.height - 44, { width: W / 2, align: 'left' })
    .text(`Page ${i - range.start + 1} of ${range.count - 1}`, M + W / 2, doc.page.height - 44,
      { width: W / 2, align: 'right' });
}

const out = path.join(__dirname, '..', 'docs', 'JPSME-member-ticket-guide.pdf');
fs.mkdirSync(path.dirname(out), { recursive: true });
const stream = fs.createWriteStream(out);
doc.pipe(stream);
doc.end();
stream.on('finish', () => {
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), out)}  (${kb} KB, ${range.count} pages)`);
});
