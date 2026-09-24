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

    // "Recently admitted" is the EVENT's list, not this tab's.
    //
    // It used to be built only from admissions made in this browser, by a
    // prepend inside the check-in handler. Three consequences, all of which
    // read as the panel being broken:
    //
    //   Reloading the page emptied it, even though the server knew perfectly
    //   well who had been admitted.
    //
    //   Anybody admitted at another station never appeared, so two desks at one
    //   door each saw half the picture.
    //
    //   Scanning somebody ALREADY checked in added nothing — that branch
    //   renders no "Check in" button, so the prepend it lived in never ran. A
    //   person genuinely admitted five minutes ago was simply missing.
    //
    // The stats endpoint has been returning `recent` all along; this code was
    // throwing it away and reading only the counts.
    function renderRecent(rows) {
      if (!recent) return;
      recent.innerHTML = '';
      if (!rows || !rows.length) {
        const empty = document.createElement('li');
        empty.className = 'text-slate-400';
        empty.textContent = 'Nobody admitted yet.';
        recent.appendChild(empty);
        return;
      }
      rows.slice(0, 8).forEach((row) => {
        const reg = row.eventRegistration || {};
        const seatLabel = reg.seat ? reg.seat.label : null;
        const when = row.scannedAt
          ? new Date(row.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';

        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-3';

        const label = document.createElement('span');
        // textContent, not innerHTML: these are attendee names straight off the
        // database, and this list is rebuilt on every scan.
        label.textContent = `${reg.fullName || 'Unknown'}${seatLabel ? ` — ${seatLabel}` : ''}${when ? ` · ${when}` : ''}`;
        li.appendChild(label);

        if (reg.checkedInAt) {
          // Reversing an admission. The endpoint has existed all along and
          // nothing in the UI ever called it, so the only way to undo a
          // mis-scan was to edit the database — which, at a live door, means
          // no way at all.
          //
          // Offered to anyone who can run this door rather than to main admins
          // only, matching the service: the person who needs it is the operator
          // who just scanned the wrong ticket, with a queue waiting.
          const undo = document.createElement('button');
          undo.type = 'button';
          undo.dataset.undo = reg.id;
          undo.className = 'shrink-0 text-xs font-semibold text-red-600 hover:underline';
          undo.textContent = 'Remove';
          li.appendChild(undo);
        } else {
          // Already reversed. The row stays: "nobody was ever admitted on this
          // ticket" and "somebody was admitted and then removed" are different
          // facts, and a list that cannot tell them apart is worse than none.
          label.className = 'text-slate-400 line-through';
          const note = document.createElement('span');
          note.className = 'shrink-0 text-xs text-slate-400';
          note.textContent = 'removed';
          li.appendChild(note);
        }

        recent.appendChild(li);
      });
    }

    // Shown immediately on a successful check-in so the operator gets an
    // instant acknowledgement, then replaced wholesale by the server's list a
    // moment later. Same person at the top either way, so there is no flicker.
    function addRecent(name, seatLabel) {
      if (!recent) return;
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
        const counts = res.data.stats || res.data.counts || res.data;
        ['registered', 'checkedIn'].forEach((key) => {
          const el = root.querySelector(`[data-stat="${key}"]`);
          if (el && counts[key] != null) el.textContent = counts[key];
        });
        // The same response carries the event's recent admissions. Reading it
        // is what makes the panel show other stations' work, survive a reload,
        // and include somebody who was already checked in before this scan.
        if (res.data.recent) renderRecent(res.data.recent);
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

    // Delegated, not bound per button: renderRecent replaces the whole list on
    // every refresh, so per-row listeners would be discarded and re-created
    // constantly — and any that leaked would fire against detached nodes.
    if (recent) {
      recent.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-undo]');
        if (!btn) return;
        const registrationId = Number(btn.dataset.undo);
        if (!registrationId) return;
        if (!window.confirm('Remove this check-in? They will be able to check in again.')) return;

        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          await apiFetch(`/api/events/${eventId}/checkin/undo`, {
            method: 'POST',
            body: JSON.stringify({
              registrationId,
              scannerIdentifier: station ? station.value.trim().toUpperCase() : null,
            }),
          });
          showToast('Check-in removed');
          // Re-read rather than patch the row: the counters move too, and the
          // server is the thing that knows what the list is now.
          refreshStats();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Remove';
        } finally {
          refocus();
        }
      });
    }

    // On load, not only after a scan. A desk opened part-way through an event
    // was showing "Nothing yet this session" over a door that had already
    // admitted two hundred people.
    refreshStats();

    // Clicking anywhere that is not a control puts focus back on the input, so
    // the next scan lands somewhere useful.
    root.addEventListener('click', (e) => {
      if (!e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) refocus();
    });
  });
}());
