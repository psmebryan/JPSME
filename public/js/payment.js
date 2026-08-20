document.addEventListener('DOMContentLoaded', () => {
  const payBtn = document.getElementById('pay-now-btn');
  if (payBtn) {
    payBtn.addEventListener('click', async () => {
      payBtn.disabled = true;
      const originalText = payBtn.textContent;
      payBtn.textContent = 'Redirecting to GCash...';

      try {
        const res = await apiFetch('/api/payments/membership/create', { method: 'POST', body: JSON.stringify({}) });
        window.location.href = res.data.checkoutUrl;
      } catch (err) {
        showToast(err.message, 'error');
        payBtn.disabled = false;
        payBtn.textContent = originalText;
      }
    });
  }

  // On the PayMongo return page, a PENDING/PROCESSING payment might get
  // confirmed by the webhook seconds after the user lands here — poll the
  // real server-side status (never trust the redirect itself) and reload once
  // it changes, instead of leaving the user stuck on a stale "processing" view.
  const returnPanel = document.getElementById('payment-return-panel');
  if (returnPanel) {
    const initialStatus = returnPanel.dataset.status;
    const statusEndpoint = returnPanel.dataset.statusEndpoint || '/api/payments/membership/status';
    if (initialStatus === 'PENDING' || initialStatus === 'PROCESSING') {
      let attempts = 0;
      const maxAttempts = 40; // ~2 minutes at 3s intervals
      const interval = setInterval(async () => {
        attempts += 1;
        if (attempts > maxAttempts) {
          clearInterval(interval);
          return;
        }
        try {
          const res = await apiFetch(statusEndpoint);
          const currentStatus = res.data.payment ? res.data.payment.status : 'NONE';
          if (currentStatus !== initialStatus) {
            clearInterval(interval);
            window.location.reload();
          }
        } catch (err) {
          // Transient network error — keep polling silently.
        }
      }, 3000);
    }
  }
});
