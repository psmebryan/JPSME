// Local copy — admin.js has its own, but that file isn't loaded on the public
// register page where the organization picker renders search results.
// Organization names come from the official workbook (admin-supplied text),
// so they're escaped before ever being inserted as HTML.
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(loginForm);
      try {
        const res = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(formData)),
        });
        showToast('Logged in! Redirecting...');
        const loginContext = formData.get('context');
        const user = res.data.user;
        let destination = '/profile';
        if (loginContext === 'admin' && ['ADMIN', 'CHAPTER_ADMIN'].includes(user.role)) {
          destination = '/admin/dashboard';
        } else if (user.role === 'USER' && user.status === 'PENDING') {
          // A pending membership payment always takes priority over wherever
          // the user was headed (e.g. an event invitation link) — nothing
          // else on the account is usable until that's resolved.
          destination = '/membership-payment';
        } else if (loginContext !== 'admin') {
          // Only a same-site relative path is ever honored — a bare "/next"
          // (never "//next", which browsers treat as protocol-relative to an
          // attacker's own host) — so a crafted login link can't redirect a
          // freshly-authenticated session off-site. The server-remembered
          // postApprovalRedirectUrl (set back at registration, e.g. "come back
          // to this event") takes priority since it survives the days-long
          // gap until approval, when the URL's own ?next= is long gone.
          const next = user.postApprovalRedirectUrl || new URLSearchParams(window.location.search).get('next');
          if (next && next.startsWith('/') && !next.startsWith('//')) {
            destination = next;
          }
        }
        window.location.href = destination;
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  if (registerForm) {
    const passwordInput = document.getElementById('password');
    const confirmPasswordInput = document.getElementById('confirmPassword');
    const confirmPasswordError = document.getElementById('confirm-password-error');

    // Letters-only enforcement (no digits) on first/middle/last name, in real time —
    // not just on submit via the pattern attribute.
    const nameFieldIds = ['firstName', 'middleInitial', 'lastName'];
    nameFieldIds.forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      // Strip any digits as the user types or pastes.
      input.addEventListener('input', () => {
        const cleaned = input.value.replace(/[0-9]/g, '');
        if (cleaned !== input.value) input.value = cleaned;
      });
      // Block digit keystrokes outright (belt-and-suspenders with the input handler above).
      input.addEventListener('keydown', (e) => {
        if (e.key.length === 1 && /[0-9]/.test(e.key)) {
          e.preventDefault();
        }
      });
    });

    // --- Organization picker -------------------------------------------
    // Search-driven rather than a cascade of Region/Cluster/Chapter selects:
    // the hierarchy has variable depth, so a fixed cascade would either show
    // levels that don't exist for a branch or force the member to already know
    // their own org chart. They type a name; the server resolves the full path.
    const orgSearch = document.getElementById('organization-search');
    const orgHidden = document.getElementById('organizationId');
    const orgResults = document.getElementById('organization-results');
    const orgSelected = document.getElementById('organization-selected');
    const orgSelectedName = document.getElementById('organization-selected-name');
    const orgSelectedPath = document.getElementById('organization-selected-path');
    const orgClear = document.getElementById('organization-clear');
    const orgError = document.getElementById('chapter-error');

    if (orgSearch && orgHidden) {
      let searchTimer = null;
      let lastQuery = null;

      function hideResults() {
        orgResults.innerHTML = '';
        orgResults.classList.add('hidden');
      }

      function selectOrganization(org) {
        orgHidden.value = org.id;
        orgSelectedName.textContent = org.name;
        orgSelectedPath.textContent = org.pathLabel || '';
        orgSelected.classList.remove('hidden');
        orgSearch.classList.add('hidden');
        orgError?.classList.add('hidden');
        hideResults();
      }

      function renderResults(organizations) {
        if (!organizations.length) {
          orgResults.innerHTML = '<p class="px-3 py-3 text-sm text-slate-500">No organizations match that search.</p>';
          orgResults.classList.remove('hidden');
          return;
        }
        orgResults.innerHTML = organizations.map((o) => `
          <button type="button" data-org-id="${o.id}"
                  class="block w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-slate-100 last:border-b-0">
            <span class="block text-sm font-medium text-slate-900">${escapeHtml(o.name)}</span>
            <span class="block text-xs text-slate-500">${escapeHtml(o.pathLabel || '')}</span>
          </button>`).join('');
        orgResults.classList.remove('hidden');

        orgResults.querySelectorAll('[data-org-id]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = Number(btn.getAttribute('data-org-id'));
            const org = organizations.find((o) => o.id === id);
            if (org) selectOrganization(org);
          });
        });
      }

      async function runSearch(term) {
        if (term === lastQuery) return;
        lastQuery = term;
        try {
          const res = await apiFetch(`/api/organizations/search?q=${encodeURIComponent(term)}`);
          renderResults(res.data.organizations);
        } catch (err) {
          hideResults();
        }
      }

      // Debounced so typing doesn't fire a request per keystroke.
      orgSearch.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const term = orgSearch.value.trim();
        if (term.length < 2) { hideResults(); return; }
        searchTimer = setTimeout(() => runSearch(term), 250);
      });

      orgClear?.addEventListener('click', () => {
        orgHidden.value = '';
        orgSelected.classList.add('hidden');
        orgSearch.classList.remove('hidden');
        orgSearch.value = '';
        orgSearch.focus();
      });

      document.addEventListener('click', (e) => {
        if (!orgResults.contains(e.target) && e.target !== orgSearch) hideResults();
      });
    }

    // Live confirm-password check
    function passwordsMatch() {
      const match = passwordInput.value === confirmPasswordInput.value;
      if (confirmPasswordError) {
        confirmPasswordError.classList.toggle('hidden', match || confirmPasswordInput.value === '');
      }
      return match;
    }
    passwordInput?.addEventListener('input', passwordsMatch);
    confirmPasswordInput?.addEventListener('input', passwordsMatch);

    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Native required/type=email/minlength constraints already passed by this point
      // (the browser blocks the submit event otherwise). Confirm-password match is
      // custom, so check it here before hitting the server.
      if (!passwordsMatch()) {
        showToast('Passwords do not match.', 'error');
        confirmPasswordInput?.focus();
        return;
      }

      // The organization field is a hidden input fed by the search picker, so
      // the browser's own `required` handling can't surface a useful message
      // for it — check it explicitly.
      if (orgHidden && !orgHidden.value) {
        orgError?.classList.remove('hidden');
        showToast('Please select your organization.', 'error');
        orgSearch?.focus();
        return;
      }

      const formData = new FormData(registerForm);
      try {
        const res = await apiFetch('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(formData)),
        });
        showToast(res.message);
        registerForm.classList.add('hidden');
        document.getElementById('register-success')?.classList.remove('hidden');
      } catch (err) {
        showToast(err.errors?.[0]?.msg || err.message, 'error');
      }
    });
  }

  const resendForm = document.getElementById('resend-verification-form');
  if (resendForm) {
    resendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(resendForm);
      try {
        const res = await apiFetch('/api/auth/resend-verification', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(formData)),
        });
        showToast(res.message);
        resendForm.reset();
      } catch (err) {
        showToast(err.errors?.[0]?.msg || err.message, 'error');
      }
    });
  }

  // Show/hide password toggles — works on any page (login or register) that has
  // buttons with data-toggle-password="<input id>"
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-toggle-password');
      const input = document.getElementById(targetId);
      if (!input) return;

      const eyeIcon = btn.querySelector('[data-icon="eye"]');
      const eyeSlashIcon = btn.querySelector('[data-icon="eye-slash"]');

      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';

      eyeIcon?.classList.toggle('hidden', isHidden);
      eyeSlashIcon?.classList.toggle('hidden', !isHidden);
      btn.setAttribute('aria-pressed', String(isHidden));
      btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  });
});
