// Fills in the built-in challenge image wherever partials/human-check rendered
// a slot for it. Only ever runs when Turnstile is not configured — with keys
// set, the partial renders Cloudflare's widget instead and there is no slot.

document.addEventListener('DOMContentLoaded', () => {
  const slots = document.querySelectorAll('[data-challenge]');
  if (!slots.length) return;

  // Only the newest load may paint. Two loads can overlap — a submit schedules
  // one 400ms later, and a person who submits twice gets two — and each one
  // issues a NEW challenge, replacing the session's. If the slower response
  // rendered last, the image on screen would belong to a challenge the server
  // had already thrown away, and every answer to it would be refused.
  let loadToken = 0;

  async function load() {
    const token = (loadToken += 1);

    slots.forEach((slot) => {
      const box = slot.querySelector('[data-challenge-image]');
      if (box) box.textContent = 'Loading…';
    });

    // The answer is NOT cleared here.
    //
    // This runs 400ms after a submit, by which time somebody told "that did not
    // match" has already started retyping — and clearing at this point wipes
    // what they are in the middle of typing, leaving a half-word that is
    // refused again. They retype, it happens again. That was a real report.
    //
    // It is cleared when the new image actually appears instead: anything typed
    // before that belonged to the old image and is worthless, anything typed
    // after belongs to the new one and must be kept.

    try {
      const res = await fetch('/api/captcha', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        // The challenge is per-session and single-use, so a cached image would
        // be an image whose answer the server has already thrown away.
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => null);

      // A refused request used to fall straight through the `if (!svg) return`
      // below, which left the box reading "Loading…" for ever: the form could
      // not be submitted and nothing on the page said why, because this only
      // ever caught a network failure and an HTTP error is not one.
      //
      // The 429 is the one that actually happens. The whole API shares an abuse
      // budget per address, and a registration page spends several requests a
      // visit — the challenge, the organization list, one per search — so a
      // busy signup session, or a lab of students behind one address, can run
      // it out. Worth naming, because "wait a minute" is a thing somebody can
      // act on and a blank grey box is not.
      if (token !== loadToken) return undefined;

      if (!res.ok) {
        return fail(res.status === 429
          ? 'Too many attempts from this network. Wait a minute, then press New image.'
          : `Could not load (error ${res.status}). Press New image to try again.`);
      }

      const svg = payload && payload.data && payload.data.svg;
      if (!svg) {
        // Null means the server believes Turnstile is handling this, while the
        // page has drawn the built-in box — the two disagree about which check
        // is running, which is a deployment with half its keys set.
        return fail('The security check is misconfigured. Please tell an administrator.');
      }

      // A response from an older load has nothing useful left to say: a newer
      // one has already replaced the challenge it belongs to.
      if (token !== loadToken) return undefined;

      slots.forEach((slot) => {
        const box = slot.querySelector('[data-challenge-image]');
        if (!box) return;
        // Undo whatever a previous failure left behind, so a retry that works
        // does not show the image wearing the styling of an error message.
        box.classList.remove(...MESSAGE_CLASSES);
        // The SVG is built by challenge.service from a fixed alphabet and
        // random numbers — nothing a visitor supplied reaches it — so this is
        // markup the server authored, not user content being trusted.
        box.innerHTML = svg;

        // Cleared at the moment the picture changes, not before it. Whatever
        // was typed was an answer to the image that has just been replaced.
        const answer = slot.querySelector('[name="challengeAnswer"]');
        if (answer) answer.value = '';
      });
      return undefined;
    } catch (err) {
      return fail('Could not reach the server. Check your connection, then press New image.');
    }
  }

  // Said in the box where the image would have been, so it is read by somebody
  // looking for the characters rather than announced somewhere else. The box is
  // 180x60 and sized for a picture, so the message needs its own type size to
  // fit inside it rather than spilling out.
  const MESSAGE_CLASSES = ['text-xs', 'text-slate-500', 'text-center', 'px-2'];

  function fail(message) {
    slots.forEach((slot) => {
      const box = slot.querySelector('[data-challenge-image]');
      if (!box) return;
      box.innerHTML = '';
      box.textContent = message;
      box.classList.add(...MESSAGE_CLASSES);
    });
    return undefined;
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
