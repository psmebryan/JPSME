// Shared fetch wrapper: attaches the CSRF token and normalizes the JSON envelope
// { success, message, data } returned by every API route.
async function apiFetch(url, options = {}) {
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});

  if (!(options.body instanceof FormData) && options.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (csrfMeta) {
    headers['X-CSRF-Token'] = csrfMeta.getAttribute('content');
  }

  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.success === false) {
    // When the server reports several problems at once, say all of them. Call
    // sites reach for errors[0].msg, so showing one at a time turned a form
    // with three mistakes into three round trips: fix one, resubmit, discover
    // the next. Composing them here fixes every caller at once.
    const list = Array.isArray(payload.errors)
      ? payload.errors.map((e) => (e && e.msg) || e).filter(Boolean)
      : [];
    const err = new Error(
      list.length > 1
        ? list.map((m) => '\u2022 ' + m).join('\n')
        : (list[0] || payload.message || 'Request failed')
    );
    // Kept intact for anything that wants the structured form. The first entry
    // is rewritten to the composed text so the existing errors[0].msg callers
    // show everything rather than one line of it.
    err.errors = list.length > 1
      ? [{ msg: err.message }].concat(payload.errors)
      : payload.errors;
    err.status = response.status;
    throw err;
  }

  return payload;
}

// Runs an async action with its own button visibly busy, and — the part that
// matters most — ignores a second click while the first is still in flight.
//
// Without this, a slow connection produces the worst version of every action in
// the app: the person clicks Register, nothing appears to happen, they click
// again, and the second request fails on a constraint the first one just
// satisfied. They are then shown "email already registered" moments after
// successfully registering. The fix is not a spinner, it is refusing the second
// click; the label change is just so they know why nothing else is happening.
//
// `target` may be the button itself or the form it sits in, in which case the
// submit button is found automatically. Returns undefined for the ignored
// second click, so callers can tell it apart from a completed run.
async function withPending(target, busyText, run) {
  if (!target) return run();

  const button = target.tagName === 'FORM'
    ? target.querySelector('[type="submit"]')
    : target;
  const holder = button || target;
  if (holder.dataset.pending === '1') return undefined;
  holder.dataset.pending = '1';

  const originalText = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    if (busyText) button.textContent = busyText;
  }

  try {
    return await run();
  } finally {
    // Always restored, including after a redirect has been started — a browser
    // can cancel navigation, and a permanently dead button would leave someone
    // stuck with no way to retry.
    delete holder.dataset.pending;
    if (button) {
      button.disabled = false;
      if (originalText !== null) button.textContent = originalText;
    }
  }
}

// A success and a failure need different amounts of time on screen. A success
// confirms something the person just did and they can look away immediately; a
// failure has to be read, understood, and acted on, and three seconds is not
// enough for a sentence explaining what went wrong — especially if it names a
// field to go back and fix. Errors therefore stay much longer, and either kind
// can be dismissed with a click rather than waited out.
const TOAST_MS = { success: 3000, error: 9000 };

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  const color = type === 'success' ? 'bg-green-600' : 'bg-red-600';
  toast.className = `${color} text-white px-4 py-3 rounded-md shadow-lg text-sm mb-2 max-w-sm cursor-pointer transition-opacity duration-300 whitespace-pre-line`;
  // textContent, never innerHTML: some of these strings come back from the
  // server and one of them could carry something a person typed.
  toast.textContent = message;
  toast.title = 'Click to dismiss';

  let removed = false;
  function dismiss() {
    if (removed) return;
    removed = true;
    toast.classList.add('opacity-0');
    setTimeout(() => toast.remove(), 300);
  }
  toast.addEventListener('click', dismiss);

  container.appendChild(toast);
  setTimeout(dismiss, TOAST_MS[type] || TOAST_MS.success);
}

function createToastContainer() {
  const container = document.createElement('div');
  container.id = 'toast-container';
  container.className = 'fixed top-4 right-4 z-50 flex flex-col items-end';
  // Announced to screen readers, which otherwise never learn that anything
  // happened — the toast is the only confirmation most actions give.
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}
