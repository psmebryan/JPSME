function initAdminPage() {
  initUserApprovals();
  initLogoUpload();
  initMembershipFeeForm();
  initGatewaySurchargeForm();
  initPaymentsEnabledToggle();
  initEventsTable();
  initArticlesTable();
  initInvitationsModule();
  initInvitationsReportTable({ moduleId: 'all-invitations-module', tableId: 'all-invitations-table', formId: 'all-invitations-filter-form', emptyStateId: 'all-inv-empty', paginationId: 'all-inv-pagination', includeEventColumn: true });
  initInvitationsReportTable({ moduleId: 'event-invitations-module', tableId: 'invitations-table', formId: 'event-invitations-filter-form', emptyStateId: 'event-inv-empty', paginationId: 'event-inv-pagination', includeEventColumn: false });
  initOrganizationAdmins();
  initOrganizationTree();
  initSponsors();
  initCertificates();
  initPaymentsModule();
  initEmailTemplates();
  initBroadcastModule();
}

// --- Email templates (admin/emails and admin/event-email pages) ---
function initEmailTemplates() {
  initMemberEmailModule();
  initEventEmailModule();
}

function initMemberEmailModule() {
  const module = document.getElementById('member-email-module');
  if (!module) return;

  const attachmentForm = document.getElementById('member-email-attachment-form');
  attachmentForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/admin/emails/member-approved/attachment', {
        method: 'POST',
        body: new FormData(attachmentForm),
      });
      showToast('Attachment updated');
      const preview = document.getElementById('member-email-attachment-preview');
      const emptyState = document.getElementById('member-email-attachment-empty');
      if (preview) {
        preview.src = `${res.data.template.attachmentImage}?t=${Date.now()}`;
        preview.classList.remove('hidden');
      }
      emptyState?.classList.add('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const textForm = document.getElementById('member-email-text-form');
  textForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(textForm);
    try {
      await apiFetch('/api/admin/emails/member-approved', {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      showToast('Email updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });
}

function initEventEmailModule() {
  const module = document.getElementById('event-email-module');
  if (!module) return;

  const eventId = module.dataset.eventId;

  const attachmentForm = document.getElementById('event-email-attachment-form');
  attachmentForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch(`/api/admin/emails/events/${eventId}/template/attachment`, {
        method: 'POST',
        body: new FormData(attachmentForm),
      });
      showToast('Attachment updated');
      const preview = document.getElementById('event-email-attachment-preview');
      const emptyState = document.getElementById('event-email-attachment-empty');
      if (preview) {
        preview.src = `${res.data.template.attachmentImage}?t=${Date.now()}`;
        preview.classList.remove('hidden');
      }
      emptyState?.classList.add('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const textForm = document.getElementById('event-email-text-form');
  textForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(textForm);
    try {
      await apiFetch(`/api/admin/emails/events/${eventId}/template`, {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      showToast('Email updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });

  const invitationTextForm = document.getElementById('event-invitation-email-text-form');
  invitationTextForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(invitationTextForm);
    try {
      await apiFetch(`/api/admin/emails/events/${eventId}/invitation-template`, {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      showToast('Invitation email updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });
}

// --- Broadcast email (admin/broadcasts page) ---
function broadcastStatusBadgeHtml(status) {
  const styles = {
    PENDING: 'badge-slate',
    SENDING: 'badge-blue',
    COMPLETED: 'badge-green',
    FAILED: 'badge-red',
  };
  return `<span class="${styles[status] || 'badge-slate'}">${status}</span>`;
}

function initBroadcastModule() {
  const module = document.getElementById('broadcast-module');
  if (!module) return;

  function getCurrentAudienceFilter() {
    const scope = document.querySelector('input[name="audienceScope"]:checked')?.value || 'all';
    if (scope === 'selected') {
      const userIds = Array.from(document.querySelectorAll('.broadcast-row-checkbox:checked')).map((cb) => Number(cb.value));
      return { scope: 'selected', userIds };
    }
    const organizationId = document.getElementById('audience-organization')?.value || '';
    return organizationId ? { scope: 'all', organizationId: Number(organizationId) } : { scope: 'all' };
  }

  async function refreshAudienceCount() {
    const filter = getCurrentAudienceFilter();
    const countEl = document.getElementById('broadcast-audience-count');
    if (filter.scope === 'selected' && !filter.userIds.length) {
      if (countEl) countEl.textContent = '0';
      return;
    }
    try {
      const res = await apiFetch(`/api/admin/broadcasts/audience-count?audience=${encodeURIComponent(JSON.stringify(filter))}`);
      if (countEl) countEl.textContent = String(res.data.count);
    } catch (err) {
      // Live-count is a convenience readout; the confirm() dialog and
      // server-side validation are the real safety net if this fails.
    }
  }

  function updateBroadcastSelectionUI() {
    const checkboxes = Array.from(document.querySelectorAll('.broadcast-row-checkbox'));
    const checked = checkboxes.filter((cb) => cb.checked);

    const countEl = document.getElementById('broadcast-selected-count');
    if (countEl) countEl.textContent = String(checked.length);

    const selectAll = document.getElementById('broadcast-select-all');
    if (selectAll) {
      selectAll.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
    }
  }

  document.querySelectorAll('input[name="audienceScope"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isSelected = document.querySelector('input[name="audienceScope"]:checked')?.value === 'selected';
      document.getElementById('audience-all-panel')?.classList.toggle('hidden', isSelected);
      document.getElementById('audience-selected-panel')?.classList.toggle('hidden', !isSelected);
      refreshAudienceCount();
    });
  });

  document.getElementById('audience-chapter')?.addEventListener('change', refreshAudienceCount);

  document.getElementById('broadcast-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.broadcast-row-checkbox').forEach((cb) => { cb.checked = e.target.checked; });
    updateBroadcastSelectionUI();
    refreshAudienceCount();
  });

  document.getElementById('audience-selected-panel')?.addEventListener('change', (e) => {
    if (e.target.classList.contains('broadcast-row-checkbox')) {
      updateBroadcastSelectionUI();
      refreshAudienceCount();
    }
  });

  function prependBroadcastRow(b) {
    const table = document.getElementById('broadcast-history-table');
    const tbody = table?.querySelector('tbody');
    if (!tbody) return;
    table.parentElement?.querySelector('p.empty-state')?.remove();
    const tr = document.createElement('tr');
    tr.dataset.broadcastId = b.id;
    tr.dataset.status = b.status;
    tr.className = 'admin-tr';
    tr.innerHTML = `
      <td class="admin-td max-w-[280px] truncate">${escapeHtml(b.subject)}</td>
      <td class="admin-td">${b.totalRecipients}</td>
      <td class="admin-td broadcast-sent-cell">${b.sentCount}</td>
      <td class="admin-td broadcast-failed-cell">${b.failedCount}</td>
      <td class="admin-td broadcast-status-cell">${broadcastStatusBadgeHtml(b.status)}</td>
      <td class="admin-td">${new Date(b.createdAt).toLocaleString()}</td>`;
    tbody.prepend(tr);
  }

  function updateBroadcastRow(b) {
    const row = document.querySelector(`#broadcast-history-table tr[data-broadcast-id="${b.id}"]`);
    if (!row) return;
    row.dataset.status = b.status;
    const sentCell = row.querySelector('.broadcast-sent-cell');
    const failedCell = row.querySelector('.broadcast-failed-cell');
    const statusCell = row.querySelector('.broadcast-status-cell');
    if (sentCell) sentCell.textContent = b.sentCount;
    if (failedCell) failedCell.textContent = b.failedCount;
    if (statusCell) statusCell.innerHTML = broadcastStatusBadgeHtml(b.status);
  }

  function pollBroadcast(id) {
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/admin/broadcasts/${id}`);
        updateBroadcastRow(res.data.broadcast);
        if (res.data.broadcast.status === 'COMPLETED' || res.data.broadcast.status === 'FAILED') {
          clearInterval(interval);
        }
      } catch (err) {
        clearInterval(interval);
      }
    }, 3000);
  }

  const form = document.getElementById('broadcast-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const filter = getCurrentAudienceFilter();
    if (filter.scope === 'selected' && !filter.userIds.length) {
      return showToast('Select at least one recipient', 'error');
    }

    const countEl = document.getElementById('broadcast-audience-count');
    const count = countEl ? countEl.textContent : 'these';
    if (!confirm(`Send this email to ${count} recipient(s)? This cannot be undone.`)) return;

    const formData = new FormData(form);
    formData.set('audience', JSON.stringify(filter));

    const submitBtn = document.getElementById('broadcast-submit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await apiFetch('/api/admin/broadcasts', { method: 'POST', body: formData });
      showToast(res.message);
      prependBroadcastRow(res.data.broadcast);
      pollBroadcast(res.data.broadcast.id);
      form.reset();
      document.getElementById('audience-all-panel')?.classList.remove('hidden');
      document.getElementById('audience-selected-panel')?.classList.add('hidden');
      updateBroadcastSelectionUI();
      refreshAudienceCount();
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.querySelectorAll('#broadcast-history-table tr[data-status="SENDING"]').forEach((row) => {
    pollBroadcast(Number(row.dataset.broadcastId));
  });

  refreshAudienceCount();
}

// --- Payments dashboard (admin/payments page) ---
function paymentStatusBadgeHtml(status) {
  const styles = {
    PAID: 'badge-green',
    PENDING: 'badge-amber',
    PROCESSING: 'badge-blue',
    FAILED: 'badge-red',
    EXPIRED: 'badge-slate',
    CANCELLED: 'badge-slate',
    REFUNDED: 'badge-purple',
  };
  return `<span class="${styles[status] || 'badge-slate'}">${status}</span>`;
}

function peso(centavos) {
  return `&#8369;${(centavos / 100).toFixed(2)}`;
}

function initPaymentsModule() {
  const module = document.getElementById('payments-module');
  if (!module) return;

  const isMainAdmin = module.dataset.isMainAdmin === '1';
  const table = document.getElementById('payments-table');
  const filterForm = document.getElementById('payments-filter-form');
  const pagination = document.getElementById('payments-pagination');

  function paymentRowHtml(p) {
    const chapter = (p.user.chapter && p.user.chapter.name) || '-';
    const reference = p.gatewayPaymentId || p.gatewayCheckoutId || '-';
    const eventLabel = p.event ? p.event.title : 'Membership';
    let actions = '';
    if (isMainAdmin && p.status === 'PAID' && !p.refund) {
      actions = `<button type="button" data-refund="${p.id}" class="text-red-600 hover:underline text-sm font-medium">Refund</button>`;
    } else if (p.refund) {
      actions = `<span class="text-xs text-slate-400">Refund: ${escapeHtml(p.refund.status)}</span>`;
    }
    if (isMainAdmin && (p.status === 'PENDING' || p.status === 'PROCESSING')) {
      actions += `<button type="button" data-reconcile="${p.id}" class="text-sky-600 hover:underline text-sm font-medium ml-2">Reconcile</button>`;
    }
    return `
      <tr data-payment-id="${p.id}" class="admin-tr align-top">
        <td class="admin-td">${escapeHtml(p.user.firstName)} ${escapeHtml(p.user.lastName)}<br><span class="text-xs text-slate-400">${escapeHtml(p.user.email)}</span></td>
        <td class="admin-td max-w-[140px] truncate">${escapeHtml(chapter)}</td>
        <td class="admin-td max-w-[160px] truncate">${escapeHtml(eventLabel)}</td>
        <td class="admin-td">${peso(p.amount)}</td>
        <td class="admin-td text-slate-500">${p.status === 'PAID' ? '&minus;' + peso(p.gatewayFeeCentavos) : '-'}</td>
        <td class="admin-td font-medium">${p.status === 'PAID' ? peso(p.amount - p.gatewayFeeCentavos) : '-'}</td>
        <td class="admin-td payment-status-cell">${paymentStatusBadgeHtml(p.status)}</td>
        <td class="admin-td">${new Date(p.createdAt).toLocaleDateString()}</td>
        <td class="admin-td text-xs text-slate-500 max-w-[160px] truncate">${escapeHtml(reference)}</td>
        <td class="admin-td text-right payment-actions-cell">${actions}</td>
      </tr>`;
  }

  function renderPagination(page, totalPages) {
    if (!pagination) return;
    pagination.dataset.page = page;
    pagination.dataset.totalPages = totalPages;
    if (totalPages <= 1) {
      pagination.innerHTML = '';
      return;
    }
    let html = '';
    for (let p = 1; p <= totalPages; p += 1) {
      html += `<button type="button" data-payments-page="${p}" class="px-3 py-1.5 text-sm rounded-md border ${p === page ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}">${p}</button>`;
    }
    pagination.innerHTML = html;
  }

  async function loadPayments(page) {
    const formData = new FormData(filterForm);
    const params = new URLSearchParams();
    ['status', 'purpose', 'dateFrom', 'dateTo'].forEach((key) => {
      const value = formData.get(key);
      if (value) params.set(key, value);
    });
    params.set('page', page);

    try {
      const res = await apiFetch(`/api/admin/payments?${params.toString()}`);
      const { payments, totalPages, page: currentPage } = res.data;
      const tbody = table.querySelector('tbody');
      tbody.innerHTML = payments.map(paymentRowHtml).join('');
      document.getElementById('payments-empty-state')?.classList.toggle('hidden', payments.length > 0);
      renderPagination(currentPage, totalPages);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  filterForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    loadPayments(1);
  });

  pagination?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-payments-page]');
    if (!btn) return;
    loadPayments(Number(btn.getAttribute('data-payments-page')));
  });

  table?.addEventListener('click', async (e) => {
    const refundBtn = e.target.closest('[data-refund]');
    if (refundBtn) {
      const paymentId = refundBtn.getAttribute('data-refund');
      if (!confirm('Refund this payment? This will initiate a refund through the payment gateway.')) return;

      const notes = prompt('Optional note for this refund (visible in the audit log):', '') || '';

      refundBtn.disabled = true;
      try {
        await apiFetch(`/api/admin/payments/${paymentId}/refund`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'requested_by_customer', notes }),
        });
        showToast('Refund requested');
        const currentPage = Number(pagination?.dataset.page) || 1;
        await loadPayments(currentPage);
      } catch (err) {
        showToast(err.errors?.[0]?.msg || err.message, 'error');
        refundBtn.disabled = false;
      }
      return;
    }

    const reconcileBtn = e.target.closest('[data-reconcile]');
    if (reconcileBtn) {
      const paymentId = reconcileBtn.getAttribute('data-reconcile');
      reconcileBtn.disabled = true;
      try {
        const res = await apiFetch(`/api/admin/payments/${paymentId}/reconcile`, { method: 'POST' });
        showToast(`Reconciled: ${res.data.outcome.replace(/_/g, ' ')}`);
        const currentPage = Number(pagination?.dataset.page) || 1;
        await loadPayments(currentPage);
      } catch (err) {
        showToast(err.errors?.[0]?.msg || err.message, 'error');
        reconcileBtn.disabled = false;
      }
    }
  });
}

// --- Certificates (membership template + per-event template & generation) ---
function initCertificates() {
  initMembershipCertificateModule();
  initEventCertificateModule();
}

function initMembershipCertificateModule() {
  const module = document.getElementById('membership-certificate-module');
  if (!module) return;

  const bgForm = document.getElementById('membership-cert-bg-form');
  bgForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/admin/certificates/membership-template/background', {
        method: 'POST',
        body: new FormData(bgForm),
      });
      showToast('Background image updated');
      const preview = document.getElementById('membership-cert-bg-preview');
      const emptyState = document.getElementById('membership-cert-bg-preview-empty');
      if (preview) {
        preview.src = `${res.data.template.backgroundImage}?t=${Date.now()}`;
        preview.classList.remove('hidden');
      }
      emptyState?.classList.add('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const textForm = document.getElementById('membership-cert-text-form');
  textForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(textForm);
    try {
      await apiFetch('/api/admin/certificates/membership-template', {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      showToast('Certificate updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });
}

function certStatusBadgeHtml(r) {
  if (!r.generated) {
    return '<span class="badge-amber">Not generated</span>';
  }
  const date = r.generatedAt ? ` &middot; ${new Date(r.generatedAt).toLocaleDateString()}` : '';
  return r.released
    ? `<span class="badge-green">Generated &middot; Download allowed${date}</span>`
    : `<span class="badge-slate">Generated &middot; Locked${date}</span>`;
}

function certActionsHtml(eventId, r) {
  if (r.generated) {
    const releaseBtn = r.released
      ? `<button type="button" data-revoke-cert="${r.userId}" class="text-slate-600 hover:underline text-sm font-medium">Revoke</button>`
      : `<button type="button" data-allow-cert="${r.userId}" class="text-emerald-600 hover:underline text-sm font-medium">Allow Download</button>`;
    return `
      <a href="/api/admin/certificates/events/${eventId}/registrants/${r.userId}/download" class="text-indigo-600 hover:underline text-sm font-medium">Download</a>
      ${releaseBtn}
      <button type="button" data-regenerate-cert="${r.userId}" class="text-amber-600 hover:underline text-sm font-medium">Regenerate</button>`;
  }
  return `<button type="button" data-generate-cert="${r.userId}" class="text-emerald-600 hover:underline text-sm font-medium">Generate</button>`;
}

function initEventCertificateModule() {
  const module = document.getElementById('event-certificate-module');
  if (!module) return;

  const eventId = module.dataset.eventId;
  let activeFilter = 'all';

  const bgForm = document.getElementById('event-cert-bg-form');
  bgForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch(`/api/admin/certificates/events/${eventId}/template/background`, {
        method: 'POST',
        body: new FormData(bgForm),
      });
      showToast('Background image updated');
      const preview = document.getElementById('event-cert-bg-preview');
      const emptyState = document.getElementById('event-cert-bg-preview-empty');
      if (preview) {
        preview.src = `${res.data.template.backgroundImage}?t=${Date.now()}`;
        preview.classList.remove('hidden');
      }
      emptyState?.classList.add('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const textForm = document.getElementById('event-cert-text-form');
  textForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(textForm);
    try {
      await apiFetch(`/api/admin/certificates/events/${eventId}/template`, {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      showToast('Certificate updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });

  async function loadRegistrants(filter) {
    activeFilter = filter;
    document.querySelectorAll('.cert-filter-tab').forEach((tab) => {
      const isActive = tab.getAttribute('data-cert-filter') === filter;
      tab.classList.toggle('bg-indigo-600', isActive);
      tab.classList.toggle('text-white', isActive);
      tab.classList.toggle('hover:bg-slate-50', !isActive);
    });

    const table = document.getElementById('cert-registrants-table');
    const tbody = table?.querySelector('tbody');
    if (!tbody) return;

    try {
      const res = await apiFetch(`/api/admin/certificates/events/${eventId}/registrants?filter=${filter}`);
      const registrants = res.data.registrants;
      tbody.innerHTML = registrants.map((r) => `
        <tr data-user-id="${r.userId}" class="admin-tr align-top">
          <td class="admin-td"><input type="checkbox" class="cert-row-checkbox" value="${r.userId}"></td>
          <td class="admin-td">${escapeHtml(r.fullName)}</td>
          <td class="admin-td max-w-[220px] truncate">${escapeHtml(r.email)}</td>
          <td class="admin-td cert-status-cell">${certStatusBadgeHtml(r)}</td>
          <td class="admin-td text-right cert-actions-cell"><div class="flex flex-wrap justify-end items-center gap-2">${certActionsHtml(eventId, r)}</div></td>
        </tr>`).join('');
      document.getElementById('cert-registrants-empty')?.classList.toggle('hidden', registrants.length > 0);
      updateCertSelectionUI();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function updateCertSelectionUI() {
    const checkboxes = Array.from(document.querySelectorAll('.cert-row-checkbox'));
    const checked = checkboxes.filter((cb) => cb.checked);

    const countEl = document.getElementById('cert-selected-count');
    if (countEl) countEl.textContent = String(checked.length);

    const generateSelectedBtn = document.getElementById('generate-selected');
    if (generateSelectedBtn) generateSelectedBtn.disabled = checked.length === 0;

    const selectAll = document.getElementById('cert-select-all');
    if (selectAll) {
      selectAll.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
    }
  }

  document.getElementById('cert-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.cert-row-checkbox').forEach((cb) => { cb.checked = e.target.checked; });
    updateCertSelectionUI();
  });

  document.getElementById('cert-registrants-table')?.addEventListener('change', (e) => {
    if (e.target.classList.contains('cert-row-checkbox')) updateCertSelectionUI();
  });

  document.getElementById('generate-selected')?.addEventListener('click', () => {
    const selected = Array.from(document.querySelectorAll('.cert-row-checkbox:checked')).map((cb) => Number(cb.value));
    if (!selected.length) return showToast('Select at least one registrant', 'error');
    generateFor(selected, false);
  });

  document.getElementById('cert-filter-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-cert-filter]');
    if (!tab) return;
    loadRegistrants(tab.getAttribute('data-cert-filter'));
  });

  // Generation runs on the job worker now (PDF rendering is CPU-bound and a
  // large "generate all pending" batch could otherwise hold this request
  // open for a long time) — this starts the job, then polls
  // GET /api/admin/jobs/:jobId every 1.5s until it's COMPLETED or FAILED.
  async function pollJobStatus(jobId, { intervalMs = 1500, timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await apiFetch(`/api/admin/jobs/${jobId}`);
      if (res.data.status === 'COMPLETED' || res.data.status === 'FAILED') return res.data;
      if (Date.now() > deadline) throw new Error('Still generating — this is taking longer than expected. Check back in a bit.');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async function generateFor(userIds, force) {
    try {
      const startRes = await apiFetch(`/api/admin/certificates/events/${eventId}/generate`, {
        method: 'POST',
        body: JSON.stringify({ userIds, force }),
      });
      showToast('Generating certificate(s)…');
      const finalStatus = await pollJobStatus(startRes.data.jobId);
      if (finalStatus.status === 'FAILED') {
        showToast(finalStatus.lastError || 'Certificate generation failed', 'error');
      } else {
        const { generatedCount, skippedCount } = finalStatus.result || {};
        showToast(`${generatedCount || 0} certificate(s) generated, ${skippedCount || 0} skipped (already generated)`);
      }
      await loadRegistrants(activeFilter);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('generate-all-pending')?.addEventListener('click', () => generateFor(undefined, false));

  async function setReleased(userId, released) {
    try {
      await apiFetch(`/api/admin/certificates/events/${eventId}/registrants/${userId}/release`, {
        method: 'POST',
        body: JSON.stringify({ released }),
      });
      showToast(released ? 'Download allowed' : 'Download revoked');
      await loadRegistrants(activeFilter);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('cert-registrants-table')?.addEventListener('click', (e) => {
    const generateBtn = e.target.closest('[data-generate-cert]');
    if (generateBtn) {
      generateFor([Number(generateBtn.getAttribute('data-generate-cert'))], false);
      return;
    }
    const regenerateBtn = e.target.closest('[data-regenerate-cert]');
    if (regenerateBtn) {
      if (!confirm('Regenerate this certificate? The previously generated PDF will be replaced and download access revoked until you allow it again.')) return;
      generateFor([Number(regenerateBtn.getAttribute('data-regenerate-cert'))], true);
      return;
    }
    const allowBtn = e.target.closest('[data-allow-cert]');
    if (allowBtn) {
      setReleased(Number(allowBtn.getAttribute('data-allow-cert')), true);
      return;
    }
    const revokeBtn = e.target.closest('[data-revoke-cert]');
    if (revokeBtn) {
      setReleased(Number(revokeBtn.getAttribute('data-revoke-cert')), false);
    }
  });
}

function initSponsors() {
  const form = document.getElementById('sponsor-form');
  const list = document.getElementById('sponsor-list');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await apiFetch('/api/admin/sponsors', { method: 'POST', body: new FormData(form) }); showToast('Sponsor added'); window.location.reload(); }
    catch (err) { showToast(err.message, 'error'); }
  });
  if (list) list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-sponsor]');
    if (!button || !confirm('Remove this sponsor?')) return;
    try { await apiFetch(`/api/admin/sponsors/${button.dataset.deleteSponsor}`, { method: 'DELETE' }); button.closest('[data-sponsor-id]').remove(); showToast('Sponsor removed'); }
    catch (err) { showToast(err.message, 'error'); }
  });
}

document.addEventListener('DOMContentLoaded', initAdminPage);
// Fired by admin-nav.js after swapping in a module's fragment via AJAX.
document.addEventListener('admin:content-loaded', initAdminPage);

// Unobtrusive replacement for onsubmit="return confirm(...)" (inline event-handler
// attributes aren't authorized by the CSP's script nonce) — any plain server-rendered
// <form data-confirm="..."> gets a confirm() prompt before it's allowed to submit.
// Registered once on document so it works across AJAX-swapped admin fragments too.
document.addEventListener('submit', (e) => {
  const message = e.target.getAttribute && e.target.getAttribute('data-confirm');
  if (message && !confirm(message)) {
    e.preventDefault();
  }
});

// --- Pending user approvals (admin/users page) ---
function initUserApprovals() {
  const table = document.getElementById('users-table');
  const module = document.getElementById('users-module');
  if (!table || !module) return;

  const viewMode = module.dataset.viewMode || 'approvals';
  // organizations passed from the server fragment (dataset holds a JSON string)
  try {
    window.adminOrganizations = module.dataset.organizations ? JSON.parse(module.dataset.organizations) : (window.adminOrganizations || []);
  } catch (err) {
    window.adminOrganizations = window.adminOrganizations || [];
  }
  try {
    window.currentAdmin = module.dataset.currentUser ? JSON.parse(module.dataset.currentUser) : (window.currentAdmin || null);
  } catch (err) {
    window.currentAdmin = window.currentAdmin || null;
  }

  if (viewMode === 'approvals') {
    loadPendingUsers(table);
  } else {
    initMembersFilterAndPagination(table);
  }

  table.addEventListener('click', async (e) => {
    // Assign toggle
    const assignToggle = e.target.closest('[data-assign-toggle]');
    if (assignToggle) {
      const row = assignToggle.closest('tr');
      const panel = row.querySelector('.assign-panel');
      if (panel) panel.classList.toggle('hidden');
      return;
    }

    // Assign confirm
    const assignConfirm = e.target.closest('[data-assign-confirm]');
    if (assignConfirm) {
      const userId = assignConfirm.getAttribute('data-assign-confirm');
      const row = assignConfirm.closest('tr');
      const select = row.querySelector('.assign-select');
      const organizationId = select ? select.value : null;
      if (!organizationId) return showToast('Please select an organization to assign', 'error');

      await doAssign({ organizationId, userId, row });
      return;
    }

    // Approve/reject only present in approvals mode
    const button = e.target.closest('[data-approve], [data-reject]');
    if (button) {
      const userId = button.getAttribute('data-approve') || button.getAttribute('data-reject');
      const action = button.hasAttribute('data-approve') ? 'approve' : 'reject';

      try {
        await apiFetch(`/api/admin/users/${userId}/${action}`, { method: 'POST' });
        showToast(`User ${action}d`);
        button.closest('tr').remove();
        maybeShowEmptyState(table);
      } catch (err) {
        showToast(err.message, 'error');
      }
      return;
    }

    // Delete (list mode only)
    const del = e.target.closest('[data-delete-user]');
    if (del) {
      const id = del.getAttribute('data-delete-user');
      if (!confirm('Delete this user?')) return;
      try {
        await apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        showToast('User deleted');
        if (table.__reloadMembers) {
          await table.__reloadMembers();
        } else {
          del.closest('tr').remove();
          maybeShowEmptyState(table);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });
}

// Assign (or reassign) an organization admin. An organization may now have
// more than one admin, and a user administers at most one organization, so
// reassigning simply moves them — the old force/409 replace prompt is gone.
async function doAssign({ organizationId, userId, row }) {
  try {
    await apiFetch('/api/admin/organization-admins/assign', {
      method: 'POST',
      body: JSON.stringify({ organizationId, userId, note: 'Assigned via users page' }),
    });
    showToast('Organization admin assigned');
    const orgName = (window.adminOrganizations || []).find(c => String(c.id) === String(organizationId))?.name || '';
    const orgCell = row.querySelector('td:nth-child(4)');
    if (orgCell) orgCell.textContent = orgName;
    const panel = row.querySelector('.assign-panel');
    if (panel) panel.classList.add('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadPendingUsers(table) {
  const tbody = table.querySelector('tbody');
  try {
    const res = await apiFetch('/api/admin/users?status=PENDING');
    tbody.innerHTML = res.data.users
      .map(
        (u) => `
        <tr data-user-id="${u.id}" class="admin-tr align-top">
          <td class="admin-td">${escapeHtml(u.firstName)} ${escapeHtml(u.lastName)}</td>
          <td class="admin-td max-w-[220px] truncate" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</td>
          <td class="admin-td max-w-[160px] truncate">${escapeHtml(u.school || '-')}</td>
          <td class="admin-td max-w-[140px] truncate">${escapeHtml((u.organization && u.organization.name) || '-')}</td>
          <td class="admin-td">${u.emailVerifiedAt ? '<span class="badge-green">Verified</span>' : '<span class="badge-amber">Unverified</span>'}</td>
          <td class="admin-td">${membershipPaymentBadge(u)}</td>
          <td class="admin-td text-right">
            <div class="flex flex-wrap justify-end items-center gap-2">
              <button data-approve="${u.id}" class="text-green-600 hover:underline text-sm font-medium">Approve</button>
              <button data-reject="${u.id}" class="text-red-600 hover:underline text-sm font-medium">Reject</button>
              <button data-assign-toggle="${u.id}" class="text-indigo-600 hover:underline text-sm font-medium">Assign</button>
            </div>
            <div class="assign-panel hidden w-full mt-2 flex flex-wrap justify-end items-center gap-2">
              <select class="assign-select form-input py-1.5 w-auto">
                <option value="">Select organization</option>
                ${(window.adminOrganizations || []).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
              </select>
              <button data-assign-confirm="${u.id}" class="btn-primary px-3 py-1.5 text-sm">Confirm</button>
            </div>
          </td>
        </tr>`
      )
      .join('');
    maybeShowEmptyState(table);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function memberRowHtml(u) {
  const canEdit = (window.currentAdmin && window.currentAdmin.role === 'ADMIN') || (window.currentAdmin && window.currentAdmin.role === 'CHAPTER_ADMIN' && u.organization && Number(u.organization.id) === Number(window.currentAdmin.organizationId));
  const assignAllowed = (window.currentAdmin && window.currentAdmin.role === 'ADMIN');
  return `
    <tr data-user-id="${u.id}" class="admin-tr align-top">
      <td class="admin-td">${escapeHtml(u.firstName)} ${escapeHtml(u.lastName)}</td>
      <td class="admin-td max-w-[220px] truncate" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</td>
      <td class="admin-td max-w-[160px] truncate">${escapeHtml(u.school || '-')}</td>
      <td class="admin-td max-w-[140px] truncate">${escapeHtml((u.organization && u.organization.name) || '-')}</td>
      <td class="admin-td">${u.emailVerifiedAt ? '<span class="badge-green">Verified</span>' : '<span class="badge-amber">Unverified</span>'}</td>
      <td class="admin-td">${membershipPaymentBadge(u)}</td>
      <td class="admin-td text-right">
        <div class="flex flex-wrap justify-end items-center gap-2">
          ${canEdit ? `<a href="/admin/users/${u.id}/edit" class="text-indigo-600 hover:underline text-sm font-medium">Edit</a>` : ''}
          ${canEdit ? `<button data-delete-user="${u.id}" class="text-red-600 hover:underline text-sm font-medium">Delete</button>` : ''}
          ${assignAllowed ? `<button data-assign-toggle="${u.id}" class="text-indigo-600 hover:underline text-sm font-medium">Assign</button>` : ''}
        </div>
        ${assignAllowed ? `<div class="assign-panel hidden w-full mt-2 flex flex-wrap justify-end items-center gap-2">
          <select class="assign-select form-input py-1.5 w-auto">
            <option value="">Select organization</option>
            ${(window.adminOrganizations || []).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <button data-assign-confirm="${u.id}" class="btn-primary px-3 py-1.5 text-sm">Confirm</button>
        </div>` : ''}
      </td>
    </tr>`;
}

function renderMembersPagination(pagination, page, totalPages) {
  if (!pagination) return;
  pagination.dataset.page = page;
  pagination.dataset.totalPages = totalPages;
  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }
  let html = '';
  for (let p = 1; p <= totalPages; p += 1) {
    html += `<button type="button" data-members-page="${p}" class="px-3 py-1.5 text-sm rounded-md border ${p === page ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}">${p}</button>`;
  }
  pagination.innerHTML = html;
}

// Server-side search/filter/pagination for the "Manage Users" (list) view —
// the full member roster, the one admin table most likely to actually reach
// thousands of rows, unlike the naturally-small pending-approvals queue.
function initMembersFilterAndPagination(table) {
  const tbody = table.querySelector('tbody');
  const filterForm = document.getElementById('members-filter-form');
  const pagination = document.getElementById('members-pagination');

  async function loadMembers(page) {
    const formData = filterForm ? new FormData(filterForm) : new FormData();
    const params = new URLSearchParams();
    ['search', 'organizationId', 'status'].forEach((key) => {
      const value = formData.get(key);
      if (value) params.set(key, value);
    });
    params.set('page', page);

    try {
      const res = await apiFetch(`/api/admin/members?${params.toString()}`);
      const { users, totalPages, page: currentPage } = res.data;
      tbody.innerHTML = users.map(memberRowHtml).join('');
      maybeShowEmptyState(table);
      renderMembersPagination(pagination, currentPage, totalPages);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  filterForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    loadMembers(1);
  });

  pagination?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-members-page]');
    if (!btn) return;
    loadMembers(Number(btn.getAttribute('data-members-page')));
  });

  // Exposed so the shared users-table click handler (delete) can re-fetch
  // the current page instead of just removing the row — otherwise the page
  // is left one short of pageSize until the admin manually changes pages.
  table.__reloadMembers = () => loadMembers(Number(pagination?.dataset.page) || 1);

  loadMembers(1);
}

// Renders each user's latest membership-payment status as a small badge for
// the admin Users table — "did they pay, or not" at a glance, including a
// failed/bounced payment so the admin isn't just guessing from silence.
function membershipPaymentBadge(u) {
  const payment = u.membershipPayment;
  if (!payment) {
    return '<span class="badge-slate">Unpaid</span>';
  }
  const badges = {
    PAID: 'badge-green',
    PENDING: 'badge-amber',
    PROCESSING: 'badge-blue',
    FAILED: 'badge-red',
    EXPIRED: 'badge-slate',
    CANCELLED: 'badge-slate',
    REFUNDED: 'badge-purple',
  };
  const labels = {
    PAID: 'Paid',
    PENDING: 'Awaiting Payment',
    PROCESSING: 'Processing',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    CANCELLED: 'Cancelled',
    REFUNDED: 'Refunded',
  };
  const cls = badges[payment.status] || 'badge-slate';
  const label = labels[payment.status] || payment.status;
  const date = payment.status === 'PAID' && payment.paidAt ? ` &middot; ${new Date(payment.paidAt).toLocaleDateString()}` : '';
  return `<span class="${cls}">${label}${date}</span>`;
}

// Table rows are built from user-supplied profile data, so escape before
// injecting via innerHTML to avoid stored XSS.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function maybeShowEmptyState(table) {
  const tbody = table.querySelector('tbody');
  const emptyState = document.getElementById('users-empty-state');
  if (!emptyState) return;
  emptyState.classList.toggle('hidden', tbody.children.length > 0);
}

// --- Site logo upload (admin/settings page) ---
function initLogoUpload() {
  const form = document.getElementById('logo-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(form);

    try {
      const res = await apiFetch('/api/admin/settings/logo', { method: 'POST', body: formData });
      showToast('Logo updated');
      const preview = document.getElementById('logo-preview');
      if (preview) preview.src = `${res.data.logoUrl}?t=${Date.now()}`;
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// --- Membership fee (admin/settings page) ---
function initMembershipFeeForm() {
  const form = document.getElementById('membership-fee-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feePhp = document.getElementById('membership-fee-input').value;

    try {
      await apiFetch('/api/admin/settings/membership-fee', {
        method: 'PUT',
        body: JSON.stringify({ feePhp }),
      });
      showToast('Membership fee updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });
}

function initGatewaySurchargeForm() {
  const form = document.getElementById('gateway-surcharge-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const percent = document.getElementById('gateway-surcharge-input').value;

    try {
      await apiFetch('/api/admin/settings/gateway-surcharge-percent', {
        method: 'PUT',
        body: JSON.stringify({ percent }),
      });
      showToast('Payment processing surcharge updated');
    } catch (err) {
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    }
  });
}

// --- Payments kill switch (admin/settings page) ---
function initPaymentsEnabledToggle() {
  const module = document.getElementById('payments-enabled-module');
  if (!module) return;

  const checkbox = document.getElementById('payments-enabled-checkbox');
  const label = document.getElementById('payments-enabled-label');

  checkbox?.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      await apiFetch('/api/admin/settings/payments-enabled', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      label.textContent = enabled ? 'Payments enabled' : 'Payments disabled';
      label.classList.toggle('text-green-700', enabled);
      label.classList.toggle('text-red-700', !enabled);
      showToast(enabled ? 'Payments enabled' : 'Payments disabled');
    } catch (err) {
      checkbox.checked = !enabled;
      showToast(err.errors?.[0]?.msg || err.message, 'error');
    } finally {
      checkbox.disabled = false;
    }
  });
}

// --- Event management table (admin/events page) ---
// Creating/editing events happens on their own dedicated pages
// (event-new.ejs/event-edit.ejs, each with a self-contained submit handler) —
// this only wires up Delete, which previously had no listener attached at all
// (the old version of this function required a #event-form that never
// coexists on the same page as #events-table, so the click handler below was
// never actually reached and the Delete button silently did nothing).
function initEventsTable() {
  const table = document.getElementById('events-table');
  if (!table) return;

  table.addEventListener('click', async (e) => {
    const deleteButton = e.target.closest('[data-delete-event]');
    if (!deleteButton) return;

    const eventId = deleteButton.getAttribute('data-delete-event');
    const eventTitle = deleteButton.getAttribute('data-event-title') || 'this event';
    if (!confirm(`Delete "${eventTitle}"? This cannot be undone.`)) return;

    try {
      await apiFetch(`/api/events/${eventId}`, { method: 'DELETE' });
      showToast('Event deleted');
      deleteButton.closest('tr').remove();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// --- Articles table (admin/articles page) --- creating/editing happens on
// their own dedicated pages (article-new.ejs/article-edit.ejs), same as
// events — this only wires up Delete.
function initArticlesTable() {
  const table = document.getElementById('articles-table');
  if (!table) return;

  table.addEventListener('click', async (e) => {
    const deleteButton = e.target.closest('[data-delete-article]');
    if (!deleteButton) return;

    const articleId = deleteButton.getAttribute('data-delete-article');
    const articleTitle = deleteButton.getAttribute('data-article-title') || 'this article';
    if (!confirm(`Delete "${articleTitle}"? This cannot be undone.`)) return;

    try {
      await apiFetch(`/api/articles/${articleId}`, { method: 'DELETE' });
      showToast('Article deleted');
      deleteButton.closest('tr').remove();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// --- Event invitations (admin/events/:id/registrations page) ---
function initInvitationsModule() {
  const module = document.getElementById('invitations-module');
  if (!module) return;

  const eventId = module.dataset.eventId;
  const pendingListEl = document.getElementById('invite-pending-list');
  const sendBtn = document.getElementById('invite-send-btn');
  let pending = [];

  // Already-invited members are disabled in the picker table server-side,
  // but a manually-typed External Contact email isn't checked against
  // anything until it hits the server — this catches that case client-side
  // too, before it's even added to the pending list.
  let alreadyInvitedEmails = [];
  try {
    alreadyInvitedEmails = JSON.parse(module.dataset.invitedEmails || '[]');
  } catch (err) {
    alreadyInvitedEmails = [];
  }

  function renderPendingList() {
    if (!pending.length) {
      pendingListEl.innerHTML = '<p class="text-sm text-slate-400">No one added yet.</p>';
      sendBtn.disabled = true;
      return;
    }
    pendingListEl.innerHTML = `
      <p class="text-xs text-slate-500 mb-1">${pending.length} pending</p>
      <div class="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-72 overflow-y-auto">
        ${pending.map((p, i) => `
          <div class="flex items-center justify-between px-3 py-2 text-sm">
            <span>${escapeHtml(p.fullName)} &middot; <span class="text-slate-400">${escapeHtml(p.email)}</span></span>
            <button type="button" data-remove-pending="${i}" class="text-red-600 hover:underline text-xs font-medium">Remove</button>
          </div>
        `).join('')}
      </div>`;
    sendBtn.disabled = false;
  }

  // `quiet` suppresses the per-item "already added" toast — used by the bulk
  // "Add Selected" handler below, which reports one summary toast instead of
  // spamming one per already-added row.
  function addPending(invitee, quiet = false) {
    const email = invitee.email.trim().toLowerCase();
    if (!email || !invitee.fullName.trim()) {
      if (!quiet) showToast('Name and email are required', 'error');
      return false;
    }
    if (alreadyInvitedEmails.includes(email)) {
      if (!quiet) showToast('This email was already invited to this event', 'error');
      return false;
    }
    if (pending.some((p) => p.email === email)) {
      if (!quiet) showToast('Already added to the list', 'error');
      return false;
    }
    pending.push({ ...invitee, email });
    return true;
  }

  // --- Existing-member search + invited-status/chapter/school filters + bulk select ---
  const memberSearch = document.getElementById('invite-member-search');
  const memberFilter = document.getElementById('invite-member-filter');
  const memberChapterFilter = document.getElementById('invite-member-chapter-filter');
  const memberSchoolFilter = document.getElementById('invite-member-school-filter');
  const memberRows = Array.from(document.querySelectorAll('.invite-member-row'));
  const memberEmptyEl = document.getElementById('invite-member-empty');
  const selectAllCheckbox = document.getElementById('invite-select-all');

  function applyMemberFilters() {
    const query = memberSearch ? memberSearch.value.trim().toLowerCase() : '';
    const filter = memberFilter ? memberFilter.value : 'all';
    const chapter = memberChapterFilter ? memberChapterFilter.value : '';
    const school = memberSchoolFilter ? memberSchoolFilter.value : '';
    let visibleCount = 0;
    memberRows.forEach((row) => {
      const matchesSearch = !query || row.dataset.search.includes(query);
      const isInvited = row.dataset.invited === 'true';
      const matchesFilter = filter === 'all' || (filter === 'invited' && isInvited) || (filter === 'not-invited' && !isInvited);
      const matchesChapter = !chapter || row.dataset.chapter === chapter;
      const matchesSchool = !school || row.dataset.school === school;
      const visible = matchesSearch && matchesFilter && matchesChapter && matchesSchool;
      row.classList.toggle('hidden', !visible);
      if (visible) visibleCount += 1;
    });
    memberEmptyEl?.classList.toggle('hidden', visibleCount > 0);
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
  }

  memberSearch?.addEventListener('input', applyMemberFilters);
  memberFilter?.addEventListener('change', applyMemberFilters);
  memberChapterFilter?.addEventListener('change', applyMemberFilters);
  memberSchoolFilter?.addEventListener('change', applyMemberFilters);

  // Only affects rows currently matching the search — selecting "all" while
  // filtered should mean all of *this* view, not every member in the event.
  selectAllCheckbox?.addEventListener('change', () => {
    memberRows.forEach((row) => {
      if (row.classList.contains('hidden')) return;
      const checkbox = row.querySelector('.invite-member-checkbox');
      if (checkbox) checkbox.checked = selectAllCheckbox.checked;
    });
  });

  document.getElementById('invite-add-selected')?.addEventListener('click', () => {
    const checked = document.querySelectorAll('.invite-member-checkbox:checked');
    if (!checked.length) {
      showToast('Select at least one member first', 'error');
      return;
    }
    let added = 0;
    checked.forEach((checkbox) => {
      const wasAdded = addPending({
        userId: checkbox.value,
        fullName: checkbox.dataset.name,
        email: checkbox.dataset.email,
        chapter: checkbox.dataset.chapter,
        school: checkbox.dataset.school,
      }, true);
      if (wasAdded) added += 1;
      checkbox.checked = false;
    });
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    renderPendingList();
    showToast(added ? `Added ${added} member${added === 1 ? '' : 's'} to the list` : 'Selected members were already on the list', added ? 'success' : 'error');
  });

  document.getElementById('invite-add-external')?.addEventListener('click', () => {
    const name = document.getElementById('invite-ext-name');
    const email = document.getElementById('invite-ext-email');
    const chapter = document.getElementById('invite-ext-chapter');
    const school = document.getElementById('invite-ext-school');
    const company = document.getElementById('invite-ext-company');
    const wasAdded = addPending({ fullName: name.value, email: email.value, chapter: chapter.value, school: school.value, company: company.value });
    if (!wasAdded) return;
    renderPendingList();
    name.value = '';
    email.value = '';
    chapter.value = '';
    school.value = '';
    company.value = '';
  });

  document.getElementById('invite-fetch-sheet')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Fetching...';

    try {
      const res = await apiFetch('/api/admin/invitations/import-contacts');
      const contacts = res.data.contacts || [];
      if (!contacts.length) {
        showToast(res.message || 'No contacts found in the sheet', 'error');
        return;
      }
      let added = 0;
      contacts.forEach((c) => {
        if (addPending({ fullName: c.fullName, email: c.email, chapter: c.chapter, school: c.school, company: c.company }, true)) added += 1;
      });
      renderPendingList();
      showToast(added ? `Added ${added} contact${added === 1 ? '' : 's'} from the sheet` : 'All contacts from the sheet were already on the list', added ? 'success' : 'error');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  pendingListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-pending]');
    if (!btn) return;
    pending.splice(Number(btn.getAttribute('data-remove-pending')), 1);
    renderPendingList();
  });

  sendBtn.addEventListener('click', async () => {
    if (!pending.length) return;
    sendBtn.disabled = true;
    const originalText = sendBtn.textContent;
    sendBtn.textContent = 'Sending...';

    try {
      await apiFetch(`/api/events/${eventId}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ invitees: pending }),
      });
      showToast('Invitations sent');
      window.location.reload();
    } catch (err) {
      showToast(err.message, 'error');
      sendBtn.disabled = false;
      sendBtn.textContent = originalText;
    }
  });

  renderPendingList();

  document.getElementById('invitations-table')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-resend-invitation]');
    if (!btn) return;
    const invitationId = btn.getAttribute('data-resend-invitation');
    btn.disabled = true;
    try {
      await apiFetch(`/api/events/${eventId}/invitations/${invitationId}/resend`, { method: 'POST' });
      showToast('Invitation resent');
      const table = document.getElementById('invitations-table');
      if (table?.__reloadInvitations) {
        await table.__reloadInvitations();
      } else {
        window.location.reload();
      }
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

// --- Filter + sort + pagination for an invitations report table
// (admin/invitations page) — works for both the cross-event "All
// Invitations" table (includeEventColumn: true) and the per-event
// "Invitation Report" table (includeEventColumn: false). All three are
// server-side (filter, sort, and page all become query params on a
// GET /api/admin/invitations request) so a filter reflects the *entire*
// matching set, not just whatever page happened to already be in the DOM —
// unlike the admin Payments page, this table's data volume (an event's full
// invitee list) can realistically be large enough that "load everything,
// filter client-side" stops being viable.
function invStatusBadgeHtml(status) {
  const styles = { PENDING: 'badge-slate', SENT: 'badge-blue', DELIVERED: 'badge-green', BOUNCED: 'badge-red', FAILED: 'badge-red' };
  return `<span class="${styles[status] || 'badge-slate'}">${status}</span>`;
}
function memberOrGuestBadgeHtml(userId) {
  return userId ? '<span class="badge-blue">Member</span>' : '<span class="badge-slate">Guest</span>';
}
function sourceBadgeHtml(source) {
  return source === 'SELF_REQUESTED' ? '<span class="badge-green">Requested</span>' : '<span class="badge-slate">Admin-Sent</span>';
}
function rsvpBadgeHtml(inv) {
  if (inv.userId) return '<span class="text-slate-300">&mdash;</span>';
  const styles = { ATTENDING: 'badge-green', NOT_ATTENDING: 'badge-red', PENDING: 'badge-slate' };
  const labels = { ATTENDING: 'Attending', NOT_ATTENDING: 'Not Attending', PENDING: 'No response' };
  return `<span class="${styles[inv.rsvpStatus] || 'badge-slate'}">${labels[inv.rsvpStatus] || inv.rsvpStatus}</span>`;
}
function fmtDate(date) {
  return date ? new Date(date).toLocaleString() : '-';
}
function invitationRowHtml(inv, includeEventColumn) {
  const eventCell = includeEventColumn
    ? `<td class="admin-td max-w-[180px] truncate"><a href="/admin/invitations?eventId=${inv.event.id}" class="text-indigo-600 hover:underline">${escapeHtml(inv.event.title)}</a></td>`
    : '';
  const actionsCell = includeEventColumn ? '' : `
    <td class="admin-td text-right">
      ${(inv.status === 'FAILED' || inv.status === 'BOUNCED') && !inv.registeredAt
        ? `<button type="button" data-resend-invitation="${inv.id}" class="text-indigo-600 hover:underline text-sm font-medium">Resend</button>`
        : ''}
    </td>`;
  return `
    <tr class="admin-tr" data-invitation-row="${inv.id}">
      ${eventCell}
      <td class="admin-td">${escapeHtml(inv.fullName)}</td>
      <td class="admin-td max-w-[180px] truncate">${escapeHtml(inv.email)}</td>
      <td class="admin-td">${escapeHtml(inv.chapter) || '-'}</td>
      <td class="admin-td">${escapeHtml(inv.school) || '-'}</td>
      <td class="admin-td">${escapeHtml(inv.company) || '-'}</td>
      <td class="admin-td">${memberOrGuestBadgeHtml(inv.userId)}</td>
      <td class="admin-td">${sourceBadgeHtml(inv.source)}</td>
      <td class="admin-td">${rsvpBadgeHtml(inv)}</td>
      <td class="admin-td invitation-status-cell">${invStatusBadgeHtml(inv.status)}</td>
      <td class="admin-td whitespace-nowrap text-xs">${fmtDate(inv.sentAt)}</td>
      <td class="admin-td whitespace-nowrap text-xs">${fmtDate(inv.openedAt)}</td>
      <td class="admin-td whitespace-nowrap text-xs">${fmtDate(inv.clickedAt)}</td>
      <td class="admin-td whitespace-nowrap text-xs">${fmtDate(inv.registeredAt)}</td>
      ${actionsCell}
    </tr>`;
}

function initInvitationsReportTable({ moduleId, tableId, formId, emptyStateId, paginationId, includeEventColumn }) {
  const module = document.getElementById(moduleId);
  const table = document.getElementById(tableId);
  if (!module || !table) return;

  const eventId = module.dataset.eventId || '';
  const tbody = table.querySelector('tbody');
  const filterForm = document.getElementById(formId);
  const emptyEl = document.getElementById(emptyStateId);
  const paginationEl = document.getElementById(paginationId);
  const headers = Array.from(table.querySelectorAll('button[data-sort-key]'));

  let sort = null;
  let dir = 'desc';

  function renderPagination(page, totalPages, total) {
    if (!paginationEl) return;
    paginationEl.dataset.page = page;
    paginationEl.dataset.totalPages = totalPages;
    if (totalPages <= 1) {
      paginationEl.innerHTML = total ? `<span>${total} total</span>` : '';
      return;
    }
    paginationEl.innerHTML = `
      <span>Page ${page} of ${totalPages} (${total} total)</span>
      <div class="flex gap-2">
        <button type="button" data-page-prev class="px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" ${page === 1 ? 'disabled' : ''}>&larr; Prev</button>
        <button type="button" data-page-next class="px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" ${page === totalPages ? 'disabled' : ''}>Next &rarr;</button>
      </div>`;
    paginationEl.querySelector('[data-page-prev]')?.addEventListener('click', () => loadInvitations(page - 1)); // eslint-disable-line no-use-before-define
    paginationEl.querySelector('[data-page-next]')?.addEventListener('click', () => loadInvitations(page + 1)); // eslint-disable-line no-use-before-define
  }

  function updateSortArrows() {
    headers.forEach((h) => {
      const arrow = h.querySelector('.sort-arrow');
      if (!arrow) return;
      if (h.dataset.sortKey === sort) {
        arrow.textContent = dir === 'asc' ? '▲' : '▼';
        arrow.classList.remove('text-slate-300');
        arrow.classList.add('text-indigo-600');
      } else {
        arrow.textContent = '▲▼';
        arrow.classList.add('text-slate-300');
        arrow.classList.remove('text-indigo-600');
      }
    });
  }

  async function loadInvitations(page) {
    const formData = filterForm ? new FormData(filterForm) : new FormData();
    const params = new URLSearchParams();
    ['eventId', 'chapter', 'school', 'type', 'status', 'source'].forEach((key) => {
      const value = formData.get(key) || (key === 'eventId' ? eventId : '');
      if (value) params.set(key, value);
    });
    if (sort) {
      params.set('sort', sort);
      params.set('dir', dir);
    }
    params.set('page', page);

    try {
      const res = await apiFetch(`/api/admin/invitations?${params.toString()}`);
      const { invitations, total, page: currentPage, totalPages } = res.data;
      tbody.innerHTML = invitations.map((inv) => invitationRowHtml(inv, includeEventColumn)).join('');
      emptyEl?.classList.toggle('hidden', invitations.length > 0);
      renderPagination(currentPage, totalPages, total);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  filterForm?.addEventListener('change', () => loadInvitations(1));

  headers.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sortKey;
      dir = sort === key && dir === 'desc' ? 'asc' : 'desc';
      sort = key;
      updateSortArrows();
      loadInvitations(1);
    });
  });

  // Exposed so the resend-invitation handler (initInvitationsModule) can
  // refresh this table's current page after a resend instead of leaving a
  // stale row in place.
  table.__reloadInvitations = () => loadInvitations(Number(paginationEl?.dataset.page) || 1);
}

// --- Organization tree (admin/organizations/tree page) ---
// Expands one level at a time rather than shipping the whole hierarchy: the
// tree stays cheap to open no matter how many organizations exist, and a level
// is only fetched the first time it's opened.
function initOrganizationTree() {
  const tree = document.getElementById('org-tree');
  const modal = document.getElementById('add-child-modal');
  if (!tree || !modal) return; // not on this page

  const TYPE_LABEL = {
    NATIONAL: 'National', MOTHER_ORG: 'Mother Org', REGION: 'Region',
    ADMIN_REGION: 'Admin Region', PROVINCE: 'Province', CITY: 'City',
    CLUSTER: 'Cluster', CHAPTER: 'Chapter', STUDENT_UNIT: 'Student Unit',
  };
  const TYPE_BADGE = {
    NATIONAL: 'badge-purple', MOTHER_ORG: 'badge-emerald', REGION: 'badge-blue',
    ADMIN_REGION: 'badge-blue', PROVINCE: 'badge-sky', CITY: 'badge-sky',
    CLUSTER: 'badge-sky', CHAPTER: 'badge-green', STUDENT_UNIT: 'badge-slate',
  };

  function nodeHtml(c) {
    const badge = TYPE_BADGE[c.type] || 'badge-slate';
    const label = TYPE_LABEL[c.type] || c.type;
    return `
      <li class="org-node" data-node-id="${c.id}">
        <div class="flex items-center gap-2 py-1.5 border-b border-slate-100">
          <button type="button" class="org-toggle w-5 h-5 shrink-0 text-slate-400 hover:text-slate-700 ${c.childCount ? '' : 'invisible'}"
                  data-node-toggle="${c.id}" aria-expanded="false" aria-label="Expand">&#9656;</button>
          <span class="${badge}">${escapeHtml(label)}</span>
          <span class="font-medium text-slate-800 truncate flex-1">${escapeHtml(c.name)}</span>
          ${c.needsReview ? '<span class="badge-amber shrink-0">Needs review</span>' : ''}
          ${c.isActive ? '' : '<span class="badge-slate shrink-0">Inactive</span>'}
          <span class="text-xs text-slate-400 shrink-0 tabular-nums">
            ${c.childCount} child${c.childCount === 1 ? '' : 'ren'} &middot; ${c.memberCount} member${c.memberCount === 1 ? '' : 's'}
          </span>
          <span class="shrink-0 flex items-center gap-2">
            <button type="button" class="text-indigo-600 hover:underline text-xs font-medium"
                    data-add-child="${c.id}" data-parent-name="${escapeHtml(c.name)}">+ Child</button>
            <a href="/admin/organizations/${c.id}/edit" data-admin-link class="text-slate-500 hover:underline text-xs">Edit</a>
          </span>
        </div>
        <ul class="org-children hidden pl-6 border-l border-slate-200 ml-2.5"></ul>
      </li>`;
  }

  async function toggleNode(btn) {
    const li = btn.closest('.org-node');
    const childList = li.querySelector('.org-children');
    const expanded = btn.getAttribute('aria-expanded') === 'true';

    if (expanded) {
      childList.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '&#9656;';
      return;
    }

    // Fetch only on first open; afterwards just re-show what's already there.
    if (!childList.dataset.loaded) {
      btn.innerHTML = '&hellip;';
      try {
        const res = await apiFetch(`/api/admin/organization-tree?id=${li.dataset.nodeId}`);
        childList.innerHTML = res.data.children.map(nodeHtml).join('');
        childList.dataset.loaded = '1';
      } catch (err) {
        showToast(err.message, 'error');
        btn.innerHTML = '&#9656;';
        return;
      }
    }
    childList.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    btn.innerHTML = '&#9662;';
  }

  function openAddChild(parentId, parentName) {
    document.getElementById('add-child-parent-id').value = parentId;
    document.getElementById('add-child-parent-name').textContent = parentName;
    document.getElementById('add-child-name').value = '';
    document.getElementById('add-child-code').value = '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('add-child-name').focus();
  }

  function closeAddChild() {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-node-toggle]');
    if (toggle && tree.contains(toggle)) { toggleNode(toggle); return; }

    const add = e.target.closest('[data-add-child]');
    if (add) {
      openAddChild(add.getAttribute('data-add-child'), add.getAttribute('data-parent-name'));
    }
  });

  document.getElementById('add-child-cancel')?.addEventListener('click', closeAddChild);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAddChild(); });

  document.getElementById('add-child-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const parentId = document.getElementById('add-child-parent-id').value;
    const payload = {
      parentId,
      name: document.getElementById('add-child-name').value.trim(),
      type: document.getElementById('add-child-type').value,
      code: document.getElementById('add-child-code').value.trim() || null,
    };
    if (!payload.name) return showToast('Please enter a name', 'error');

    try {
      const res = await apiFetch('/api/admin/organizations/child', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('Created: ' + res.data.pathLabel);
      closeAddChild();

      // Drop the cached children for that parent so the next expand re-fetches
      // and shows the new node, instead of silently serving a stale level.
      const parentLi = tree.querySelector(`.org-node[data-node-id="${parentId}"]`);
      if (parentLi) {
        const list = parentLi.querySelector('.org-children');
        delete list.dataset.loaded;
        list.innerHTML = '';
        list.classList.add('hidden');
        const t = parentLi.querySelector('[data-node-toggle]');
        t.classList.remove('invisible');
        t.setAttribute('aria-expanded', 'false');
        t.innerHTML = '&#9656;';
        toggleNode(t);
      } else {
        window.location.reload(); // added under the root itself
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// --- Organization Admins (admin/organization-admins page) ---
// Assignment is by userId now: an organization may have several admins, and a
// user administers at most one organization, so reassigning just moves them —
// there's no 'this org already has an admin' conflict to resolve any more.
function initOrganizationAdmins() {
  const assignForm = document.getElementById('assign-org-admin-form');
  if (!assignForm) return; // not on this page

  assignForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const organizationId = document.getElementById('assign-organizationId').value;
    const userId = document.getElementById('assign-userId').value;
    if (!organizationId || !userId) return showToast('Please select an organization and a member', 'error');
    try {
      await apiFetch('/api/admin/organization-admins/assign', {
        method: 'POST',
        body: JSON.stringify({ organizationId, userId, note: 'Assigned via Organization Admins page' }),
      });
      showToast('Organization admin assigned');
      window.location.reload();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-remove-org-admin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.getAttribute('data-remove-org-admin');
      if (!confirm('Remove this organization admin? They will revert to a regular member.')) return;
      try {
        await apiFetch('/api/admin/organization-admins/remove', {
          method: 'POST',
          body: JSON.stringify({ userId, note: 'Removed via Organization Admins page' }),
        });
        showToast('Organization admin removed');
        window.location.reload();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

