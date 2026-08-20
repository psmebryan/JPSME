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
          destination = '/membership-payment';
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
