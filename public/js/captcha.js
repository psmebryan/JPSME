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
      // Cleared here rather than only on the refresh button: every path that
      // loads a new image invalidates whatever was typed against the old one,
      // and an answer left under a fresh image is one the server is guaranteed
      // to reject. That matters more now the verify form carries a challenge —
      // a wrong code spends it too, and the retry would otherwise resubmit a
      // stale answer alongside the corrected digits.
      const answer = slot.querySelector('[name="challengeAnswer"]');
      if (answer) answer.value = '';
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
      refresh.addEventListener('click', () => load());
    }
  });

  // A submitted answer is spent whether it was right or wrong, so after an
  // attempt the image on screen is stale. Reloading it saves the person typing
  // an answer that could not work no matter what.
  //
  // Only for a form that actually carries a challenge. This used to fire on
  // ANY submit on the page, which on /login meant the login form: 400ms after
  // pressing Login — almost exactly how long a login takes — this fetched
  // /api/captcha, and that endpoint writes to the session. Two requests, one
  // session, last write wins: the captcha request had loaded the session
  // before login saved the user into it, so saving afterwards put the
  // logged-out copy back. The login succeeded, the next page found no session,
  // and the person landed back on the login form with no error to explain it.
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || typeof form.querySelector !== 'function') return;
    if (!form.querySelector('[name="challengeAnswer"]')) return;
    setTimeout(load, 400);
  }, true);

  load();
});
