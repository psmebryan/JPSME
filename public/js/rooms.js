// Rooms: the occupancy board and the door screen.
//
// Both pages load this file; each half is guarded by a lookup for its own root
// element, so the one that is not on screen does nothing. Same pattern as
// auth.js, which the profile page loads only for the organization picker.

(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  function timeOnly(value) {
    if (!value) return '—';
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Rendered into a table shared by both pages.
  function insideRow(person, eventId, roomId) {
    return `
      <tr class="border-t border-slate-100">
        <td class="py-2 pr-4 font-medium text-slate-800">${escapeHtml(person.name)}</td>
        <td class="py-2 pr-4 font-mono text-xs text-slate-500">${escapeHtml(person.registrationNumber || '—')}</td>
        <td class="py-2 pr-4 tabular-nums text-slate-600">${timeOnly(person.since)}</td>
        <td class="py-2 pr-4 tabular-nums text-slate-600">${person.entryCount}</td>
        <td class="py-2 text-right">
          <button type="button" class="text-sm text-red-600 hover:underline"
                  data-mark-outside="${person.registrationId}">Mark as left</button>
        </td>
      </tr>`;
  }

  async function loadInside(eventId, roomId, tbody) {
    const res = await apiFetch(`/api/events/${eventId}/rooms/${roomId}/inside`);
    const people = res.data.inside || [];
    tbody.innerHTML = people.length
      ? people.map((p) => insideRow(p, eventId, roomId)).join('')
      : '<tr><td colspan="5" class="py-4 text-slate-400">Nobody inside.</td></tr>';
    return people.length;
  }

  // --- the occupancy board --------------------------------------------------

  function initRoomsBoard() {
    const root = document.querySelector('[data-rooms-root]');
    if (!root) return;
    const eventId = root.dataset.eventId;

    // The bar widths cannot be inline styles — styleSrc carries a nonce and no
    // 'unsafe-inline', so a style attribute written from script is dropped with
    // no error. Setting the width property through the CSSOM is not blocked.
    function paintBars(scope) {
      scope.querySelectorAll('[data-room-bar]').forEach((bar) => {
        bar.style.width = `${Number(bar.dataset.pct) || 0}%`;
      });
    }
    paintBars(root);

    // --- polling ---
    //
    // Not websockets: this host is shared Node, and a socket per open board is
    // not something to rely on. Not a tight interval either — the whole API
    // shares a per-address budget, and an event is exactly when several staff
    // are on one venue connection with this page open. Six seconds is fast
    // enough for a number nobody acts on in under a minute.
    const POLL_MS = 6000;

    async function refresh() {
      // Skipped while the tab is in the background. A board left open on a
      // laptop overnight would otherwise spend the whole budget on nobody.
      if (document.hidden) return;
      try {
        const res = await apiFetch(`/api/events/${eventId}/rooms`);
        (res.data.rooms || []).forEach((room) => {
          const card = root.querySelector(`[data-room-card="${room.id}"]`);
          if (!card) return;

          const occupancy = card.querySelector('[data-room-occupancy]');
          if (occupancy) occupancy.textContent = room.occupancy;

          const available = card.querySelector('[data-room-available]');
          if (available) available.textContent = room.available;

          const state = card.querySelector('[data-room-state]');
          if (state) {
            state.textContent = room.isOpen ? 'Open' : 'Closed';
            state.className = `shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
              room.isOpen ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`;
          }

          const bar = card.querySelector('[data-room-bar]');
          if (bar && room.capacity) {
            const pct = Math.min(100, Math.round((room.occupancy / room.capacity) * 100));
            bar.style.width = `${pct}%`;
            bar.className = `h-full rounded-full ${
              pct >= 90 ? 'bg-red-500' : (pct >= 70 ? 'bg-amber-500' : 'bg-green-500')}`;
          }
        });

        const total = root.querySelector('[data-total-inside]');
        if (total) {
          total.textContent = (res.data.rooms || []).reduce((n, r) => n + r.occupancy, 0);
        }
      } catch (err) {
        // A failed refresh leaves the last good numbers on screen. Shouting
        // about it would bury the board in toasts on a flaky venue connection,
        // and the next tick usually succeeds.
      }
    }

    setInterval(refresh, POLL_MS);
    // Caught up immediately on returning to the tab, rather than after a wait.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

    // --- who's inside, on demand ---
    const panel = root.querySelector('[data-inside-panel]');
    const rows = root.querySelector('[data-inside-rows]');
    const title = root.querySelector('[data-inside-title]');

    root.addEventListener('click', async (e) => {
      const show = e.target.closest('[data-show-inside]');
      if (show && panel) {
        const roomId = show.dataset.showInside;
        const card = root.querySelector(`[data-room-card="${roomId}"]`);
        panel.dataset.roomId = roomId;
        if (title) title.textContent = `Inside ${card ? card.querySelector('p').textContent.trim() : 'room'}`;
        panel.classList.remove('hidden');
        rows.innerHTML = '<tr><td colspan="5" class="py-4 text-slate-400">Loading…</td></tr>';
        try {
          await loadInside(eventId, roomId, rows);
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      if (e.target.closest('[data-close-inside]') && panel) {
        panel.classList.add('hidden');
        return;
      }

      // Marking somebody out from the board, same endpoint the door uses.
      const mark = e.target.closest('[data-mark-outside]');
      if (mark && panel) {
        const roomId = panel.dataset.roomId;
        try {
          await apiFetch(`/api/events/${eventId}/rooms/${roomId}/override`, {
            method: 'POST',
            body: JSON.stringify({ registrationId: Number(mark.dataset.markOutside), state: 'OUTSIDE' }),
          });
          showToast('Marked as left.');
          await loadInside(eventId, roomId, rows);
          refresh();
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const toggle = e.target.closest('[data-toggle-room]');
      if (toggle) {
        const isOpen = toggle.dataset.open === 'true';
        try {
          await apiFetch(`/api/events/${eventId}/rooms/${toggle.dataset.toggleRoom}`, {
            method: 'PUT',
            body: JSON.stringify({ isOpen: !isOpen }),
          });
          showToast(isOpen ? 'Room closed.' : 'Room opened.');
          window.location.reload();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });

    // --- configuration ---
    const roomForm = root.querySelector('[data-room-form]');
    if (roomForm) {
      roomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(roomForm));
        await withPending(roomForm, 'Adding…', async () => {
          try {
            const res = await apiFetch(`/api/events/${eventId}/rooms`, {
              method: 'POST',
              body: JSON.stringify({
                name: data.name,
                // Empty means uncapped, which is a real choice — sent as null
                // rather than dropped, so the server is not left guessing.
                capacity: data.capacity === '' ? null : Number(data.capacity),
                location: data.location || null,
              }),
            });
            showToast(res.message);
            window.location.reload();
          } catch (err) {
            showToast(err.errors?.[0]?.msg || err.message, 'error');
          }
        });
      });
    }

    const sessionForm = root.querySelector('[data-session-form]');
    if (sessionForm) {
      sessionForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(sessionForm));
        await withPending(sessionForm, 'Adding…', async () => {
          try {
            const res = await apiFetch(`/api/events/${eventId}/sessions`, {
              method: 'POST',
              body: JSON.stringify({
                name: data.name,
                roomId: data.roomId || null,
                // datetime-local has no timezone; new Date() reads it as local
                // time, which is what the person typing it meant.
                startTime: data.startTime ? new Date(data.startTime).toISOString() : null,
                endTime: data.endTime ? new Date(data.endTime).toISOString() : null,
              }),
            });
            showToast(res.message);
            window.location.reload();
          } catch (err) {
            showToast(err.errors?.[0]?.msg || err.message, 'error');
          }
        });
      });
    }

    root.addEventListener('click', async (e) => {
      const remove = e.target.closest('[data-delete-session]');
      if (!remove) return;
      try {
        await apiFetch(`/api/events/${eventId}/sessions/${remove.dataset.deleteSession}`, { method: 'DELETE' });
        showToast('Session removed.');
        window.location.reload();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // --- the door screen ------------------------------------------------------

  function initRoomScanner() {
    const root = document.querySelector('[data-room-scan-root]');
    if (!root) return;

    const eventId = root.dataset.eventId;
    const roomId = root.dataset.roomId;
    const form = root.querySelector('[data-scan-form]');
    const input = root.querySelector('[data-scan-input]');
    const station = root.querySelector('[data-station]');
    const result = root.querySelector('[data-result]');
    const occupancy = root.querySelector('[data-occupancy]');
    const available = root.querySelector('[data-available]');
    const rows = root.querySelector('[data-inside-rows]');

    // The station name is typed once at the start of a shift and wanted again
    // after every reload. Per-browser, so two tablets at two doors keep their
    // own — which is the point of recording it per scan.
    const STATION_KEY = `jpsme.room.station.${roomId}`;
    try {
      const saved = localStorage.getItem(STATION_KEY);
      if (saved && station) station.value = saved;
    } catch (err) { /* private windows throw on read; the field just starts empty */ }

    if (station) {
      station.addEventListener('change', () => {
        try { localStorage.setItem(STATION_KEY, station.value.trim().toUpperCase()); } catch (err) { /* not worth failing a shift over */ }
      });
    }

    // Focus, the gun's suffix, and the beep — all of it shared with any other
    // scan box rather than reimplemented here. This screen is now the busiest
    // station at an event, so it gets the handling that was written for the
    // entrance before that station was removed.
    const scanner = attachScanner({
      input,
      onScan: (value) => submit(value),
      isTypingElsewhere: () => document.activeElement === station,
    });
    const refocus = scanner.refocus;

    function render(data) {
      const entered = data.ok && data.action === 'CHECK_IN';
      const left = data.ok && data.action === 'CHECK_OUT';

      // Three outcomes, three looks. A duplicate is neither: nothing went
      // wrong, so it must not be red, and nothing changed, so it must not
      // repeat ENTERED as though it had. Amber, and it says what the person's
      // state actually is.
      const tone = data.duplicate
        ? 'border-amber-400 bg-amber-50'
        : (data.ok
          ? (entered ? 'border-green-500 bg-green-50' : 'border-sky-500 bg-sky-50')
          : 'border-red-500 bg-red-50');
      const headline = data.duplicate
        ? `ALREADY ${data.state === 'INSIDE' ? 'INSIDE' : 'OUT'}`
        : (data.ok ? (entered ? 'ENTERED' : 'LEFT') : 'REFUSED');

      // Heard as well as seen: an operator watching the queue rather than the
      // screen still knows whether to wave somebody through.
      scanner.beep(data.ok === true);
      const headlineTone = data.duplicate
        ? 'text-amber-700'
        : (data.ok ? (entered ? 'text-green-700' : 'text-sky-700') : 'text-red-700');

      const person = data.participant;
      result.className = `mt-4 rounded-xl border-2 p-8 text-center ${tone}`;
      result.innerHTML = `
        <p class="text-4xl font-bold tracking-tight ${headlineTone}">${headline}</p>
        ${person ? `<p class="mt-3 text-2xl font-semibold text-slate-900">${escapeHtml(person.name)}</p>` : ''}
        ${person && person.registrationNumber ? `<p class="font-mono text-sm text-slate-500">${escapeHtml(person.registrationNumber)}</p>` : ''}
        ${person && person.organizationPath ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(person.organizationPath)}</p>` : ''}
        <p class="mt-4 text-sm text-slate-600">${escapeHtml(data.message || '')}</p>
        ${data.alsoMarkedArrived ? '<p class="mt-2 text-xs font-medium text-amber-700">Also marked as arrived at the event — they had not checked in at the entrance.</p>' : ''}
        ${data.session ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(data.session.name)}</p>` : ''}`;

      if (data.ok && typeof data.occupancy === 'number') {
        if (occupancy) occupancy.textContent = data.occupancy;
        // Capacity comes off the element the server rendered it on, so an
        // uncapped room (empty string) leaves the dash alone rather than
        // computing a number out of NaN.
        const cap = occupancy ? Number(occupancy.dataset.capacity) : NaN;
        if (available && occupancy && occupancy.dataset.capacity !== '' && !Number.isNaN(cap)) {
          available.textContent = Math.max(0, cap - data.occupancy);
          available.className = `mt-1 text-3xl font-semibold tabular-nums ${
            cap - data.occupancy <= 0 ? 'text-red-600' : 'text-slate-900'}`;
        }
      }

      if ((left || entered) && !data.duplicate) {
        loadInside(eventId, roomId, rows).then((count) => {
          if (occupancy) occupancy.textContent = count;
        }).catch(() => {});
      }
    }

    async function submit(value) {
      const code = String(value || '').trim();
      if (!code) return;

      try {
        const res = await apiFetch(`/api/events/${eventId}/rooms/${roomId}/scan`, {
          method: 'POST',
          body: JSON.stringify({
            qrToken: code,
            scannerIdentifier: station ? station.value.trim().toUpperCase() : null,
          }),
        });
        render(res.data);
      } catch (err) {
        // A thrown error here is a real fault — no access, no such room, the
        // network. Refusals come back 200 with ok:false and are rendered above.
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
      submit(input.value);
    });

    root.addEventListener('click', async (e) => {
      const mark = e.target.closest('[data-mark-outside]');
      if (mark) {
        try {
          await apiFetch(`/api/events/${eventId}/rooms/${roomId}/override`, {
            method: 'POST',
            body: JSON.stringify({ registrationId: Number(mark.dataset.markOutside), state: 'OUTSIDE' }),
          });
          showToast('Marked as left.');
          const count = await loadInside(eventId, roomId, rows);
          if (occupancy) occupancy.textContent = count;
        } catch (err) {
          showToast(err.message, 'error');
        }
        refocus();
        return;
      }

      if (e.target.closest('[data-refresh-inside]')) {
        try {
          const count = await loadInside(eventId, roomId, rows);
          if (occupancy) occupancy.textContent = count;
        } catch (err) {
          showToast(err.message, 'error');
        }
        refocus();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initRoomsBoard();
    initRoomScanner();
  });
}());
