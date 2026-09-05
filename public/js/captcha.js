// Fills in the built-in challenge image wherever partials/human-check rendered
// a slot for it. Only ever runs when Turnstile is not configured — with keys
// set, the partial renders Cloudflare's widget instead and there is no slot.

document.addEventListener('DOMContentLoaded', () => {
  const slots = document.querySelectorAll('[data-challenge]');
  if (!slots.length) return;

  async function load() {
    slots.forEach((slot) => {
      const box = slot.querySelector('[data-challenge-image]');
      if (box) box.textContent = 'Loading…';
    });

    try {
      const res = await fetch('/api/captcha', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        // The challenge is per-session and single-use, so a cached image would
        // be an image whose answer the server has already thrown away.
        cache: 'no-store',
      });
      const payload = await res.json();
      const svg = payload && payload.data && payload.data.svg;
      if (!svg) return;

      slots.forEach((slot) => {
        const box = slot.querySelector('[data-challenge-image]');
        // The SVG is built by challenge.service from a fixed alphabet and
        // random numbers — nothing a visitor supplied reaches it — so this is
        // markup the server authored, not user content being trusted.
        if (box) box.innerHTML = svg;
      });
    } catch (err) {
      slots.forEach((slot) => {
        const box = slot.querySelector('[data-challenge-image]');
        if (box) box.textContent = 'Could not load';
      });
    }
  }

  slots.forEach((slot) => {
    const refresh = slot.querySelector('[data-challenge-refresh]');
    if (refresh) {
      refresh.addEventListener('click', () => {
        const input = slot.querySelector('[name="challengeAnswer"]');
        if (input) input.value = '';
        load();
      });
    }
  });

  // A submitted answer is spent whether it was right or wrong, so after any
  // attempt the image on screen is stale. Reloading it on a failed submit
  // saves the person typing an answer that could not work no matter what.
  document.addEventListener('submit', () => {
    setTimeout(load, 400);
  }, true);

  load();
});
