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
    const err = new Error(payload.message || 'Request failed');
    err.errors = payload.errors;
    err.status = response.status;
    throw err;
  }

  return payload;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  const color = type === 'success' ? 'bg-green-600' : 'bg-red-600';
  toast.className = `${color} text-white px-4 py-2 rounded-md shadow-lg text-sm mb-2 transition-opacity duration-300`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function createToastContainer() {
  const container = document.createElement('div');
  container.id = 'toast-container';
  container.className = 'fixed top-4 right-4 z-50 flex flex-col items-end';
  document.body.appendChild(container);
  return container;
}
