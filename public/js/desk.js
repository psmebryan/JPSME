// The registration desk: scan, look, choose a seat, admit.
//
// The order matters and is the whole reason this page is separate from the
// entrance scanner. Scanning here calls a lookup that admits nobody — so a seat
// can be handed out while the person is standing there — and admission is a
// second, deliberate action.

(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-desk-root]');
    if (!root) return;

    const eventId = root.dataset.eventId;
    const seatingOn = root.dataset.seating === 'on';
    const form = root.querySelector('[data-scan-form]');
    const input = root.querySelector('[data-scan-input]');
    const station = root.querySelector('[data-station]');
    const result = root.querySelector('[data-result]');
    const recent = root.querySelector('[data-recent]');

    // Whoever is on screen right now. The seat and admit buttons act on this
    // rather than on anything in the DOM, so a stale button cannot admit
    // somebody who has since been replaced by the next scan.
    let current = null;
    let availableSeats = [];

    // Kept per browser, per event: two desks at one venue each keep their own
    // name, which is the point of recording it against the scan.
    const STATION_KEY = `jpsme.desk.station.${eventId}`;
    try {
      const saved = localStorage.getItem(STATION_KEY);
      if (saved && station) station.value = saved;
    } catch (err) { /* a private window throws on read; the field just starts empty */ }
    if (station) {
      station.addEventListener('change', () => {
        try { localStorage.setItem(STATION_KEY, station.value.trim().toUpperCase()); } catch (err) { /* not worth failing a shift over */ }
      });
    }

    const refocus = () => { if (input) input.focus(); };
    refocus();

    // --- rendering ----------------------------------------------------------

    function refusal(data) {
      current = null;
      result.className = 'mt-4 rounded-xl border-2 border-red-500 bg-red-50 p-8 text-center';
      result.innerHTML = `
        <p class="text-3xl font-bold text-red-700">REFUSED</p>
        ${data.participant ? `<p class="mt-3 text-xl font-semibold text-slate-900">${escapeHtml(data.participant.name)}</p>` : ''}
        <p class="mt-3 text-sm text-slate-700">${escapeHtml(data.message || 'This registration cannot be admitted.')}</p>`;
    }

    function seatPicker() {
      if (!seatingOn) return '';
      if (current.seat) {
        return `
          <div class="mt-5 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
            <p class="text-xs font-semibold uppercase tracking-wide text-indigo-700">Seat</p>
            <p class="mt-1 font-mono text-2xl font-bold text-indigo-900">${escapeHtml(current.seat.label)}</p>
            <p class="text-xs text-slate-600">${escapeHtml(current.seat.section)}${current.seat.room ? ` · ${escapeHtml(current.seat.room)}` : ''}</p>
            <button type="button" class="mt-2 text-xs text-indigo-700 hover:underline" data-change-seat>Change seat</button>
          </div>`;
      }
      return `
        <div class="mt-5 text-left">
          <label class="form-label" for="desk-seat">Pick a seat</label>
          <select id="desk-seat" class="form-input w-full" data-seat-select>
            <option value="">${availableSeats.length ? 'Choose…' : 'No seats available'}</option>
            ${availableSeats.map((s) => `<option value="${s.id}">${escapeHtml(s.sectionName)} — ${escapeHtml(s.label)}</option>`).join('')}
          </select>
          <p class="mt-1 text-xs text-slate-500">${availableSeats.length} free right now.</p>
        </div>`;
    }

    function render() {
      const person = current.participant;
      const arrived = Boolean(current.checkedInAt);

      result.className = 'mt-4 rounded-xl border-2 border-slate-300 bg-white p-6 text-center';
      result.innerHTML = `
        <p class="text-2xl font-semibold text-slate-900">${escapeHtml(person.name)}</p>
        ${person.registrationNumber ? `<p class="font-mono text-sm text-slate-500">${escapeHtml(person.registrationNumber)}</p>` : ''}
        ${person.organizationPath ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(person.organizationPath)}</p>` : ''}
        <p class="mt-3 text-sm ${arrived ? 'text-green-700' : 'text-slate-600'}">
          ${arrived ? `Already arrived at ${new Date(current.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not yet arrived'}
        </p>
        <div class="mx-auto max-w-sm">${seatPicker()}</div>
        <div class="mt-5 flex flex-wrap justify-center gap-2">
          ${arrived
    ? '<p class="text-xs text-slate-500">Already admitted — the seat above can still be changed.</p>'
    : '<button type="button" class="btn-primary px-6 py-3 text-base" data-admit>Check in</button>'}
        </div>`;
    }

    function addRecent(name, seatLabel) {
      const li = document.createElement('li');
      li.textContent = `${name}${seatLabel ? ` — ${seatLabel}` : ''} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (recent.firstElementChild && recent.firstElementChild.classList.contains('text-slate-400')) {
        recent.innerHTML = '';
      }
      recent.prepend(li);
      while (recent.children.length > 8) recent.lastElementChild.remove();
    }

    async function loadAvailableSeats() {
      if (!seatingOn) { availableSeats = []; return; }
      try {
        const res = await apiFetch(`/api/events/${eventId}/seating/available`);
        availableSeats = res.data.seats || [];
      } catch (err) {
        availableSeats = [];
      }
    }

    async function refreshStats() {
      try {
        const res = await apiFetch(`/api/events/${eventId}/checkin/stats`);
        const counts = res.data.counts || res.data;
        ['registered', 'checkedIn'].forEach((key) => {
          const el = root.querySelector(`[data-stat="${key}"]`);
          if (el && counts[key] != null) el.textContent = counts[key];
        });
      } catch (err) { /* the numbers are a comfort, not the job */ }
    }

    // --- the scan -----------------------------------------------------------

    async function lookup(value) {
      const code = String(value || '').trim();
      if (!code) return;

      try {
        const [res] = await Promise.all([
          apiFetch(`/api/events/${eventId}/checkin/lookup`, {
            method: 'POST',
            body: JSON.stringify({ qrToken: code, scannerIdentifier: station ? station.value.trim().toUpperCase() : null }),
          }),
          loadAvailableSeats(),
        ]);

        if (!res.data.ok) { refusal(res.data); return; }

        current = { ...res.data, scannedValue: code, seat: null };
        // Their seat, if they already chose one online or at another desk.
        try {
          const seatRes = await apiFetch(`/api/events/${eventId}/seating/registrations/${current.registrationId}/seat`);
          current.seat = seatRes.data.seat;
        } catch (err) { /* no seat is a normal answer */ }

        render();
      } catch (err) {
        result.className = 'mt-4 rounded-xl border-2 border-red-500 bg-red-50 p-8 text-center';
        result.innerHTML = `<p class="text-2xl font-bold text-red-700">ERROR</p>
          <p class="mt-2 text-sm text-slate-700">${escapeHtml(err.message)}</p>`;
      } finally {
        input.value = '';
        refocus();
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      lookup(input.value);
    });

    // --- acting on the person on screen --------------------------------------

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-change-seat]') && current) {
        // Freeing it first, so the picker below offers it again if they want it
        // back — and so the map never shows them holding two.
        try {
          await apiFetch(`/api/events/${eventId}/seating/seats/${current.seat.id}/release`, { method: 'POST' });
          current.seat = null;
          await loadAvailableSeats();
          render();
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const admit = e.target.closest('[data-admit]');
      if (!admit || !current) return;

      const select = root.querySelector('[data-seat-select]');
      const seatId = select ? select.value : '';

      // Seat first, then admission. If the seat is taken in the moment between
      // choosing and pressing, the person is not admitted seatless — the whole
      // step is stopped and the picker refreshed, which is the one order that
      // cannot leave a half-done arrival.
      admit.disabled = true;
      try {
        if (seatingOn && !current.seat && seatId) {
          await apiFetch(`/api/events/${eventId}/seating/seats/${seatId}/assign`, {
            method: 'POST',
            body: JSON.stringify({ registrationId: current.registrationId }),
          });
          current.seat = availableSeats.find((s) => String(s.id) === String(seatId)) || null;
          if (current.seat) current.seat.section = current.seat.sectionName;
        }

        const res = await apiFetch(`/api/events/${eventId}/checkin`, {
          method: 'POST',
          body: JSON.stringify({
            qrToken: current.scannedValue,
            scannerIdentifier: station ? station.value.trim().toUpperCase() : null,
          }),
        });

        const seatLabel = current.seat ? current.seat.label : null;
        result.className = 'mt-4 rounded-xl border-2 border-green-500 bg-green-50 p-8 text-center';
        result.innerHTML = `
          <p class="text-4xl font-bold text-green-700">CHECKED IN</p>
          <p class="mt-3 text-2xl font-semibold text-slate-900">${escapeHtml(current.participant.name)}</p>
          ${seatLabel ? `<p class="mt-2 font-mono text-3xl font-bold text-indigo-800">${escapeHtml(seatLabel)}</p>` : ''}
          <p class="mt-3 text-sm text-slate-600">${escapeHtml(res.message || '')}</p>`;

        addRecent(current.participant.name, seatLabel);
        current = null;
        refreshStats();
      } catch (err) {
        admit.disabled = false;
        showToast(err.message, 'error');
        // The seat may have gone in the meantime; offer the current truth.
        await loadAvailableSeats();
        if (current) render();
      } finally {
        refocus();
      }
    });

    // Clicking anywhere that is not a control puts focus back on the input, so
    // the next scan lands somewhere useful.
    root.addEventListener('click', (e) => {
      if (!e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) refocus();
    });
  });
}());
