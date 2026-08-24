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
      const inviteToken = button.getAttribute('data-invite-token');

      if (!isLoggedIn) {
        // Uses the actual current URL (not a reconstructed /events/:id) so an
        // invitation link (/events/:id/invite/:token) round-trips back here
        // after login instead of losing the invite context.
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
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
        const res = await apiFetch(`/api/events/${eventId}/register`, {
          method: 'POST',
          body: inviteToken ? JSON.stringify({ inviteToken }) : undefined,
        });
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

  const invitationRequestForm = document.getElementById('invitation-request-form');
  invitationRequestForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const eventId = document.getElementById('invitation-request-section').getAttribute('data-event-id');
    const messageEl = document.getElementById('invitation-request-message');
    const submitButton = invitationRequestForm.querySelector('button[type="submit"]');
    const formData = new FormData(invitationRequestForm);

    submitButton.disabled = true;
    submitButton.textContent = 'Sending...';
    try {
      const res = await apiFetch(`/api/events/${eventId}/invitation-requests`, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      invitationRequestForm.classList.add('hidden');
      messageEl.textContent = res.message || "Your invitation is on its way — check your email.";
      messageEl.classList.remove('hidden', 'text-red-600');
      messageEl.classList.add('text-green-700');
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.remove('hidden', 'text-green-700');
      messageEl.classList.add('text-red-600');
      submitButton.disabled = false;
      submitButton.textContent = 'Request an Invitation';
    }
  });

  document.getElementById('invitation-rsvp-section')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rsvp-action]');
    if (!btn) return;

    const section = document.getElementById('invitation-rsvp-section');
    const eventId = section.getAttribute('data-event-id');
    const token = section.getAttribute('data-invite-token');
    const status = btn.getAttribute('data-rsvp-action');
    const messageEl = document.getElementById('invitation-rsvp-message');

    btn.disabled = true;
    try {
      await apiFetch(`/api/events/${eventId}/invitations/${token}/rsvp`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      showToast(status === 'ATTENDING' ? "You're marked as attending!" : "Got it — thanks for letting us know.");
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.remove('hidden');
      messageEl.classList.add('text-red-600');
      btn.disabled = false;
    }
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
