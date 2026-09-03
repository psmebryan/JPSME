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

    // --- Organization cascade -------------------------------------------
    // A guided drill-down through National → Province → Student Unit. Each
    // step is populated from the real children of the step above, so the
    // member can only pick a branch that actually exists, and the cascade
    // stops as soon as the selected organization has no children — a province
    // with no units recorded simply ends there. The member may stop at
    // whichever level they belong to; the value kept is the deepest chosen.
    const orgCascade = document.getElementById('organization-cascade');
    const orgHidden = document.getElementById('organizationId');
    const orgSelected = document.getElementById('organization-selected');
    const orgSelectedName = document.getElementById('organization-selected-name');
    const orgSelectedPath = document.getElementById('organization-selected-path');
    const orgError = document.getElementById('chapter-error');

    const ORG_TYPE_LABEL = {
      NATIONAL: 'National', REGION: 'Region', PROVINCE: 'Province', STUDENT_UNIT: 'Student Unit',
    };

    if (orgCascade && orgHidden) {
      // One entry per rendered step: { parentId, options, selectedId }.
      const levels = [];

      // Name the step after what it actually contains — a level holding only
      // student units is labelled "Student Unit". A mixed level gets a neutral
      // label rather than claiming to be one specific rung.
      function levelLabel(options) {
        const types = [...new Set(options.map((o) => o.type))];
        if (types.length === 1) return ORG_TYPE_LABEL[types[0]] || 'Organization';
        return 'Organization';
      }

      function selectedChain() {
        return levels.filter((l) => l.selectedId)
          .map((l) => l.options.find((o) => String(o.id) === String(l.selectedId)))
          .filter(Boolean);
      }

      function refreshSummary() {
        const chain = selectedChain();
        if (!chain.length) {
          orgHidden.value = '';
          orgSelected.classList.add('hidden');
          return;
        }
        const deepest = chain[chain.length - 1];
        orgHidden.value = deepest.id;
        orgSelectedName.textContent = deepest.name;
        orgSelectedPath.textContent = ['JPSME National'].concat(chain.map((o) => o.name)).join(' › ');
        orgSelected.classList.remove('hidden');
        orgError?.classList.add('hidden');
      }

      // Shallowest level first, so a step that mixes levels reads top-down the
      // way the hierarchy does rather than in arbitrary order.
      const TYPE_ORDER = ['NATIONAL', 'REGION', 'PROVINCE', 'STUDENT_UNIT'];

      function optionHtml(o, selectedId) {
        return `<option value="${o.id}" ${String(o.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`;
      }

      // A step can still hold more than one level at once: a student unit with
      // no province recorded attaches straight to National, so National lists
      // provinces and units side by side. Grouping keeps that readable without
      // forcing a Province step that some branches genuinely do not have.
      function optionsHtml(options, selectedId) {
        const groups = new Map();
        options.forEach((o) => {
          if (!groups.has(o.type)) groups.set(o.type, []);
          groups.get(o.type).push(o);
        });
        const types = [...groups.keys()].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));

        // One level present: the step's own label already names it, so a single
        // group heading would just repeat that.
        if (types.length === 1) {
          return groups.get(types[0])
            .slice().sort((a, b) => a.name.localeCompare(b.name))
            .map((o) => optionHtml(o, selectedId)).join('');
        }
        return types.map((t) => {
          const items = groups.get(t).slice().sort((a, b) => a.name.localeCompare(b.name));
          const heading = (ORG_TYPE_LABEL[t] || t) + (items.length > 1 ? 's' : '');
          return `<optgroup label="${escapeHtml(heading)} (${items.length})">`
            + items.map((o) => optionHtml(o, selectedId)).join('')
            + '</optgroup>';
        }).join('');
      }

      function render() {
        orgCascade.innerHTML = levels.map((level, i) => {
          const label = levelLabel(level.options);
          const opts = optionsHtml(level.options, level.selectedId);
          return `
            <div>
              <label class="block text-sm font-medium mb-1" for="org-level-${i}">${escapeHtml(label)}</label>
              <select id="org-level-${i}" data-level="${i}"
                      class="org-level w-full border border-gray-300 rounded-md px-3 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">${i === 0 ? 'Select your ' + label.toLowerCase() : 'Select ' + label.toLowerCase() + ' (optional)'}</option>
                ${opts}
              </select>
            </div>`;
        }).join('');

        orgCascade.querySelectorAll('.org-level').forEach((sel) => {
          sel.addEventListener('change', () => onLevelChange(Number(sel.dataset.level), sel.value));
        });
      }

      async function onLevelChange(index, value) {
        // Everything below the changed step is now invalid.
        levels.length = index + 1;
        levels[index].selectedId = value || null;

        if (value) {
          try {
            const res = await apiFetch(`/api/organizations/${value}/children`);
            const children = res.data.children || [];
            // No children means this is a leaf for registration purposes —
            // the cascade simply ends here rather than showing an empty step.
            if (children.length) levels.push({ parentId: Number(value), options: children, selectedId: null });
          } catch (err) {
            // A failed lookup must not strand the form: keep what's chosen.
          }
        }
        render();
        refreshSummary();
      }

      (async function initCascade() {
        try {
          const res = await apiFetch('/api/organizations/top-level');
          const children = res.data.children || [];
          if (!children.length) return;
          levels.push({ parentId: res.data.root ? res.data.root.id : null, options: children, selectedId: null });
          render();
        } catch (err) {
          orgCascade.innerHTML = '<p class="text-sm text-red-600">Could not load organizations. Please refresh the page.</p>';
        }
      }());

      // --- Search shortcut ------------------------------------------------
      const orgSearch = document.getElementById('organization-search');
      const orgResults = document.getElementById('organization-results');

      if (orgSearch && orgResults) {
        let searchTimer = null;
        let lastQuery = null;

        function hideResults() {
          orgResults.innerHTML = '';
          orgResults.classList.add('hidden');
        }

        // Rebuilds the cascade so every step of the chosen organization's
        // branch is present and already selected. Walks the ancestor chain and
        // fetches each level's siblings, so the member can still see — and
        // change — where they landed rather than being handed an opaque result.
        async function fillCascadeFor(organizationId) {
          const res = await apiFetch(`/api/organizations/${organizationId}/path`);
          const chain = res.data.path || []; // root first, target last
          if (chain.length < 2) return; // the root itself isn't selectable

          // One request per level, all in flight together — the chain is only
          // ever a few deep, so this stays a single round-trip's worth of wait.
          const parents = chain.slice(0, -1);
          const levelOptions = await Promise.all(
            parents.map((p) => apiFetch(`/api/organizations/${p.id}/children`)
              .then((r) => r.data.children || [])
              .catch(() => []))
          );

          levels.length = 0;
          levelOptions.forEach((options, i) => {
            if (!options.length) return;
            levels.push({ parentId: parents[i].id, options, selectedId: chain[i + 1].id });
          });

          // If the target itself has children, offer them as an optional next
          // step — a member who searched for their chapter may still want to
          // narrow to their student unit.
          try {
            const deeper = await apiFetch(`/api/organizations/${organizationId}/children`);
            const kids = deeper.data.children || [];
            if (kids.length) levels.push({ parentId: Number(organizationId), options: kids, selectedId: null });
          } catch (err) { /* optional extra step only */ }

          render();
          refreshSummary();
        }

        function renderResults(organizations) {
          if (!organizations.length) {
            orgResults.innerHTML = '<p class="px-3 py-3 text-xs text-gray-500">No organization matches that search.</p>';
            orgResults.classList.remove('hidden');
            return;
          }
          orgResults.innerHTML = organizations.map((o) => `
            <button type="button" data-org-id="${o.id}"
                    class="block w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-gray-300 last:border-b-0">
              <span class="block text-sm font-medium text-indigo-950">${escapeHtml(o.name)}</span>
              <span class="block text-xs text-gray-500">${escapeHtml(o.pathLabel || '')}</span>
            </button>`).join('');
          orgResults.classList.remove('hidden');

          orgResults.querySelectorAll('[data-org-id]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const id = btn.getAttribute('data-org-id');
              hideResults();
              orgSearch.value = '';
              try {
                await fillCascadeFor(id);
              } catch (err) {
                showToast('Could not load that organization. Please choose it below instead.', 'error');
              }
            });
          });
        }

        async function runSearch(term) {
          if (term === lastQuery) return;
          lastQuery = term;
          try {
            const res = await apiFetch(`/api/organizations/search?q=${encodeURIComponent(term)}`);
            renderResults(res.data.organizations || []);
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

        document.addEventListener('click', (e) => {
          if (!orgResults.contains(e.target) && e.target !== orgSearch) hideResults();
        });
      }
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

      // The organization field is a hidden input fed by the cascade, so the
      // browser's own `required` handling can't surface a useful message for
      // it — check it explicitly.
      if (orgHidden && !orgHidden.value) {
        orgError?.classList.remove('hidden');
        showToast('Please select your organization.', 'error');
        document.getElementById('org-level-0')?.focus();
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
