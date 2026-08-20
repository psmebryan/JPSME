document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-register-event]').forEach((button) => {
    button.addEventListener('click', async () => {
      // Defensive client-side guard: don't allow admins to register even if a button
      // is present (template also renders a disabled label for admins).
      const userRole = button.getAttribute('data-user-role');
      if (userRole === 'ADMIN') {
        showToast('Admins cannot register for events', 'error');
        return;
      }

      const eventId = button.getAttribute('data-register-event');
      const isLoggedIn = button.getAttribute('data-logged-in') === 'true';

      if (!isLoggedIn) {
        window.location.href = `/login?next=/events/${eventId}`;
        return;
      }

      // If the button is disabled (aria-disabled), don't attempt registration
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;

      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = 'Registering...';

      try {
        // No form to fill out: the server pulls name/email/phone/school straight
        // from the logged-in user's saved profile. For a paid event this
        // returns a checkoutUrl instead of registering immediately — the
        // registration itself stays PENDING_PAYMENT until PayMongo confirms.
        const res = await apiFetch(`/api/events/${eventId}/register`, { method: 'POST' });
        if (res.data && res.data.checkoutUrl) {
          button.textContent = 'Redirecting to GCash...';
          window.location.href = res.data.checkoutUrl;
          return;
        }
        showToast('You are registered for this event!');
        // Refresh to reflect DB state (registeredEventIds) and show cancel option
        setTimeout(() => window.location.reload(), 700);
      } catch (err) {
        showToast(err.message, 'error');
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  });

  // "Payment Pending — Pay Now" button (event-details page and profile page) —
  // hits the same register endpoint, which idempotently reuses the existing
  // PENDING_PAYMENT hold and issues a fresh checkout session for it.
  document.querySelectorAll('[data-pay-event]').forEach((button) => {
    button.addEventListener('click', async () => {
      const eventId = button.getAttribute('data-pay-event');
      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = 'Redirecting to GCash...';

      try {
        const res = await apiFetch(`/api/events/${eventId}/register`, { method: 'POST' });
        if (res.data && res.data.checkoutUrl) {
          window.location.href = res.data.checkoutUrl;
          return;
        }
        window.location.reload();
      } catch (err) {
        showToast(err.message, 'error');
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  });

  document.querySelectorAll('[data-cancel-registration]').forEach((button) => {
    button.addEventListener('click', async () => {
      const eventId = button.getAttribute('data-cancel-registration');
      if (!confirm('Cancel your registration for this event?')) return;

      try {
        await apiFetch(`/api/events/${eventId}/cancel`, { method: 'POST' });
        showToast('Registration cancelled');
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
});
