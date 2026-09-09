// Draws the member's ticket as a saveable image, matching the card on screen.
//
// The server can already send the QR on its own, and that is what "Save QR
// image" used to give you: a bare square of pixels with no event, no name and
// no registration number. Useful to a scanner, useless to the person holding
// it — you cannot tell which event it is for, and neither can the person at
// the door if they need to read the number aloud.
//
// Composed here rather than server-side because everything needed is already
// on this page, and drawing it on the server would mean an image library and a
// second copy of the design to keep in step with the CSS. Canvas keeps one
// design in one place; the numbers below are lifted from .ticket-* in
// tailwind.css so the saved image and the screen cannot drift apart.
//
// The server endpoint stays as the link's href, so with JavaScript off the
// button still saves a working code. Worse-looking, but never nothing.

(function () {
  const card = document.getElementById('ticket-card-data');
  const button = document.getElementById('save-ticket-image');
  // The QR is taken from the image already rendered on the page rather than
  // repeated in a data attribute. It is a data: URI a few kilobytes long, and
  // carrying it twice doubles the page for no gain — there is only ever one
  // code here, and it is already in the DOM.
  const qrImageEl = document.getElementById('ticket-qr');
  if (!card || !button || !qrImageEl) return;

  // Same palette as .ticket-card and friends.
  const INK = '#0f172a';
  const MUTED = '#64748b';
  const BORDER = '#e2e8f0';
  const DIVIDER = '#f1f5f9';
  const BADGE_BG = '#dcfce7';
  const BADGE_INK = '#15803d';
  const WHITE = '#ffffff';

  const SANS = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';
  const MONO = 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace';

  // Drawn at 2x and scaled down on save, so the text is crisp on a phone
  // screen and still legible printed.
  const SCALE = 2;
  const W = 720;
  const PAD = 48;
  const QR = 380;

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Returns the lines rather than drawing them, so the height can be measured
  // before anything is committed — the card grows to fit a long event title
  // instead of clipping it.
  function wrap(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const lines = [];
    let line = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const candidate = line + ' ' + words[i];
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
    return lines;
  }

  function centred(ctx, text, y, font, colour) {
    ctx.font = font;
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.fillText(text, W / 2, y);
  }

  function draw(qrImage, data) {
    const measure = document.createElement('canvas').getContext('2d');

    measure.font = '700 34px ' + SANS;
    const titleLines = wrap(measure, data.title, W - PAD * 2);
    measure.font = '400 20px ' + SANS;
    const orgLines = data.organization ? wrap(measure, data.organization, W - PAD * 2) : [];

    // Laid out by walking down the same order the page shows, so a change to
    // one is obvious against the other.
    const headerH = PAD + 22 + titleLines.length * 42 + 34 + (data.venue ? 30 : 0) + 28;
    const qrH = QR + 56;
    const footH = 30 + 40 + 44 + orgLines.length * 26 + 60 + PAD;
    const H = headerH + qrH + footH;

    const canvas = document.createElement('canvas');
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // The card, on white. A ticket saved on a transparent ground turns black
    // in any viewer with a dark theme, taking the QR's quiet zone with it —
    // and a code without its margin is a code that will not scan.
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    roundedRect(ctx, 0.5, 0.5, W - 1, H - 1, 20);
    ctx.stroke();

    let y = PAD + 4;

    ctx.letterSpacing = '2px';
    centred(ctx, 'PSME EVENT', y, '600 15px ' + SANS, MUTED);
    ctx.letterSpacing = '0px';
    y += 40;

    titleLines.forEach((line) => {
      centred(ctx, line, y, '700 34px ' + SANS, INK);
      y += 42;
    });

    y += 4;
    centred(ctx, data.when, y, '400 20px ' + SANS, MUTED);
    y += 30;
    if (data.venue) {
      centred(ctx, data.venue, y, '400 20px ' + SANS, MUTED);
      y += 30;
    }

    y += 12;
    ctx.strokeStyle = DIVIDER;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();

    y += 36;
    ctx.drawImage(qrImage, (W - QR) / 2, y, QR, QR);
    y += QR + 44;

    ctx.letterSpacing = '2px';
    centred(ctx, 'REGISTRATION NUMBER', y, '600 13px ' + SANS, MUTED);
    ctx.letterSpacing = '0px';
    y += 32;

    centred(ctx, data.reference, y, '600 26px ' + MONO, INK);
    y += 44;

    centred(ctx, data.name, y, '600 22px ' + SANS, INK);
    y += orgLines.length ? 28 : 0;

    orgLines.forEach((line, i) => {
      centred(ctx, line, y + i * 24, '400 17px ' + SANS, MUTED);
    });
    y += orgLines.length * 24 + 28;

    // Badge, sized to its own text rather than a guessed width.
    ctx.font = '600 15px ' + SANS;
    const badgeW = ctx.measureText(data.badge).width + 40;
    const badgeH = 34;
    ctx.fillStyle = BADGE_BG;
    roundedRect(ctx, (W - badgeW) / 2, y, badgeW, badgeH, badgeH / 2);
    ctx.fill();
    centred(ctx, data.badge, y + 23, '600 15px ' + SANS, BADGE_INK);

    return canvas;
  }

  button.addEventListener('click', (event) => {
    const qrSrc = qrImageEl.getAttribute('src');
    if (!qrSrc) return; // let the href do its job

    event.preventDefault();
    const original = button.textContent;
    button.textContent = 'Preparing…';
    button.setAttribute('aria-busy', 'true');

    const image = new Image();

    image.onload = () => {
      try {
        const canvas = draw(image, {
          title: card.dataset.title,
          when: card.dataset.when,
          venue: card.dataset.venue,
          reference: card.dataset.reference,
          name: card.dataset.name,
          organization: card.dataset.organization,
          badge: card.dataset.badge,
        });

        canvas.toBlob((blob) => {
          if (!blob) throw new Error('canvas produced nothing');
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = (card.dataset.reference || 'ticket') + '.png';
          document.body.appendChild(link);
          link.click();
          link.remove();
          // Revoked on the next tick rather than immediately: some browsers
          // have not finished reading the blob when click() returns.
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          button.textContent = original;
          button.removeAttribute('aria-busy');
        }, 'image/png');
      } catch (err) {
        // Anything unexpected falls back to the server's plain QR, which is
        // still a working ticket. Silently producing no file would leave
        // someone at a door with nothing.
        button.textContent = original;
        button.removeAttribute('aria-busy');
        window.location.href = button.getAttribute('href');
      }
    };

    image.onerror = () => {
      button.textContent = original;
      button.removeAttribute('aria-busy');
      window.location.href = button.getAttribute('href');
    };

    // A data: URL, so nothing here taints the canvas and toBlob stays allowed.
    image.src = qrSrc;
  });
}());
