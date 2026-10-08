// The contact form on /contact. Posts to /api/contact through apiFetch, which
// adds the CSRF header, and shows the outcome above the form.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('contact-form');
  const status = document.getElementById('contact-message-status');
  if (!form || !status) return;

  function show(message, ok) {
    status.textContent = message;
    status.classList.remove('hidden', 'text-red-600', 'text-green-700');
    status.classList.add(ok ? 'text-green-700' : 'text-red-600');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const res = await apiFetch('/api/contact', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.reset();
      form.classList.add('hidden');
      show(res.message || 'Thank you. Your message has been sent.', true);
    } catch (err) {
      show(err.message, false);
      // A Turnstile token is single-use, so a failed submit needs a fresh one.
      // (The built-in image challenge reloads itself; see captcha.js.)
      if (window.turnstile && typeof window.turnstile.reset === 'function') {
        try { window.turnstile.reset(); } catch (resetErr) { /* widget not rendered */ }
      }
    } finally {
      button.disabled = false;
    }
  });
});
