// The admin seat map: build a plan, then watch it fill up.
//
// Guarded by its root element like every other page script here, so the file is
// inert anywhere else.

(function () {
  const STATE_CLASS = {
    AVAILABLE: 'bg-white border-slate-300 text-slate-600 hover:border-indigo-400',
    HELD: 'bg-amber-100 border-amber-400 text-amber-800',
    ASSIGNED: 'bg-indigo-100 border-indigo-400 text-indigo-800',
    OCCUPIED: 'bg-green-600 border-green-700 text-white',
    // Theirs, but they have stepped out. The seat looks empty from across the
    // hall and is not free — which is exactly the case an organiser has to be
    // able to see before they send somebody to sit in it.
    AWAY: 'bg-orange-100 border-orange-400 text-orange-800',
    BLOCKED: 'bg-slate-300 border-slate-400 text-slate-500 line-through',
  };

  const STATE_LABEL = {
    AVAILABLE: 'Available',
    HELD: 'Held by somebody choosing',
    ASSIGNED: 'Assigned — not in the room yet',
    OCCUPIED: 'In their seat',
    AWAY: 'Stepped out — seat still theirs for now',
    BLOCKED: 'Blocked',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-seating-root]');
    if (!root) return;

    const eventId = root.dataset.eventId;
    const panel = root.querySelector('[data-seat-panel]');
    let selectedSeatId = null;

    // --- painting -----------------------------------------------------------

    // Repaints every seat from a freshly fetched map, in place. Rebuilding the
    // markup would lose the scroll position of a two-thousand-seat plan and the
    // selection with it.
    function paint(sections) {
      const totals = {};
      sections.forEach((section) => {
        Object.keys(section.counts).forEach((key) => {
          totals[key] = (totals[key] || 0) + section.counts[key];
        });
        section.rows.forEach((row) => {
          row.seats.forEach((seat) => {
            const button = root.querySelector(`[data-seat="${seat.id}"]`);
            if (!button || button.dataset.state === seat.state) return;
            button.dataset.state = seat.state;
            button.className = `h-8 w-9 shrink-0 rounded border text-[10px] font-medium tabular-nums ${STATE_CLASS[seat.state]}`;
            button.title = seat.occupant ? `${seat.label} — ${seat.occupant.name}` : seat.label;
          });
        });
      });

      Object.entries(totals).forEach(([key, value]) => {
        const el = root.querySelector(`[data-total="${key}"]`);
        if (el) el.textContent = value;
      });
      return sections;
    }

    let latest = null;

    async function refresh() {
      // Skipped in a background tab: this page is left open during an event and
      // the whole API shares a per-address budget.
      if (document.hidden) return null;
      try {
        const res = await apiFetch(`/api/events/${eventId}/seating/map`);
        latest = paint(res.data.sections || []);
        if (selectedSeatId) showSeat(selectedSeatId, { keepHistory: true });
        return latest;
      } catch (err) {
        // The last good map stays on screen. A toast per failed tick would bury
        // the page on a flaky venue connection.
        return null;
      }
    }

    // --- who has stepped out -------------------------------------------------
    //
    // The plan shows this as a colour, which answers "is that seat free" for a
    // seat you are already looking at. This answers the question an organiser
    // actually has — "which seats can I give away" — without making them scan
    // several hundred squares for orange ones.
    const awayList = root.querySelector('[data-away-list]');
    const awayCount = root.querySelector('[data-away-count]');

    function minutes(n) {
      if (n < 1) return 'just now';
      if (n < 60) return `${n} min ago`;
      const h = Math.floor(n / 60);
      return `${h}h ${n % 60}m ago`;
    }

    async function refreshAway() {
      if (!awayList || document.hidden) return;
      try {
        const res = await apiFetch(`/api/events/${eventId}/seating/stepped-out`);
        const seats = res.data.seats || [];
        awayCount.textContent = seats.length ? `${seats.length} seat${seats.length === 1 ? '' : 's'}` : 'none';

        if (!seats.length) {
          awayList.innerHTML = '<li class="py-3 text-sm text-slate-400">Nobody has left their seat.</li>';
          return;
        }

        awayList.innerHTML = seats.map((seat) => `
          <li class="flex items-start justify-between gap-3 py-3">
            <div class="min-w-0">
              <p class="font-mono text-sm font-semibold text-slate-900">${escapeHtml(seat.label)}</p>
              <p class="truncate text-sm text-slate-700">${escapeHtml(seat.name || 'Unnamed')}</p>
              <p class="text-xs ${seat.freesInMinutes <= 2 ? 'text-orange-700' : 'text-slate-500'}">
                Left ${escapeHtml(minutes(seat.minutesAway))} &middot;
                ${seat.freesInMinutes > 0 ? `frees in ${seat.freesInMinutes} min` : 'freeing now'}
              </p>
            </div>
            <button type="button" data-free-seat="${seat.seatId}"
                    class="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">Free</button>
          </li>`).join('');
      } catch (err) {
        // Same reasoning as the map: the last good list stays rather than a
        // toast per tick on a flaky venue connection.
      }
    }

    awayList.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-free-seat]');
      if (!button) return;
      // Confirmed, because it takes a seat off somebody who may be two minutes
      // from walking back into it.
      if (!window.confirm('Free this seat? Whoever it belongs to will no longer have one.')) return;
      try {
        await apiFetch(`/api/events/${eventId}/seating/seats/${button.dataset.freeSeat}/release`, { method: 'POST' });
        showToast('Seat freed.');
        await Promise.all([refresh(), refreshAway()]);
      } catch (err) {
        showToast(err.message || 'That seat could not be freed.', 'error');
      }
    });

    // Ten seconds, not one. Seat states change when somebody walks through a
    // door, which is not a thing anybody reacts to in under a minute.
    setInterval(() => { refresh(); refreshAway(); }, 10000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { refresh(); refreshAway(); }
    });
    refreshAway();

    function findSeat(seatId) {
      if (!latest) return null;
      for (const section of latest) {
        for (const row of section.rows) {
          const hit = row.seats.find((s) => String(s.id) === String(seatId));
          if (hit) return hit;
        }
      }
      return null;
    }

    // --- the seat panel -----------------------------------------------------

    async function showSeat(seatId, { keepHistory = false } = {}) {
      selectedSeatId = seatId;
      if (!latest) await refresh();
      const seat = findSeat(seatId);
      if (!seat) return;

      panel.classList.remove('hidden');
      panel.querySelector('[data-seat-label]').textContent = seat.label;
      panel.querySelector('[data-seat-state]').textContent = STATE_LABEL[seat.state] || seat.state;

      const occupant = panel.querySelector('[data-seat-occupant]');
      if (seat.occupant) {
        occupant.classList.remove('hidden');
        occupant.innerHTML = `<span class="font-medium">${escapeHtml(seat.occupant.name)}</span>
          <span class="block font-mono text-xs text-slate-500">${escapeHtml(seat.occupant.registrationNumber || '')}</span>`;
      } else {
        occupant.classList.add('hidden');
        occupant.textContent = '';
      }

      const release = panel.querySelector('[data-seat-release]');
      const block = panel.querySelector('[data-seat-block]');
      const remove = panel.querySelector('[data-seat-delete]');
      const assignBox = panel.querySelector('[data-assign-box]');

      const taken = seat.state === 'ASSIGNED' || seat.state === 'OCCUPIED';
      release.classList.toggle('hidden', !taken);
      block.textContent = seat.state === 'BLOCKED' ? 'Unblock' : 'Block';
      // A seat somebody holds is not deletable — they have it on their ticket.
      remove.classList.toggle('hidden', taken);
      assignBox.classList.toggle('hidden', taken);

      if (!keepHistory) loadHistory(seatId);
    }

    async function loadHistory(seatId) {
      const list = panel.querySelector('[data-seat-history]');
      list.innerHTML = '<li class="text-slate-400">Loading…</li>';
      try {
        const res = await apiFetch(`/api/events/${eventId}/seating/seats/${seatId}/history`);
        const history = res.data.history || [];
        list.innerHTML = history.length
          ? history.map((h) => `<li>
              <span class="font-medium">${escapeHtml(h.action)}</span>
              ${h.who ? `— ${escapeHtml(h.who)}` : ''}
              ${h.by ? `<span class="text-slate-400">by ${escapeHtml(h.by)}</span>` : ''}
              <span class="block text-slate-400">${new Date(h.at).toLocaleString()}</span>
            </li>`).join('')
          : '<li class="text-slate-400">Nothing yet.</li>';
      } catch (err) {
        list.innerHTML = '<li class="text-red-600">Could not load the history.</li>';
      }
    }

    // --- clicks -------------------------------------------------------------

    root.addEventListener('click', async (e) => {
      const seatButton = e.target.closest('[data-seat]');
      if (seatButton) {
        await showSeat(seatButton.dataset.seat);
        return;
      }

      if (e.target.closest('[data-close-seat]')) {
        panel.classList.add('hidden');
        selectedSeatId = null;
        return;
      }

      const block = e.target.closest('[data-seat-block]');
      if (block && selectedSeatId) {
        const seat = findSeat(selectedSeatId);
        try {
          const res = await apiFetch(`/api/events/${eventId}/seating/seats/${selectedSeatId}/block`, {
            method: 'POST',
            body: JSON.stringify({ blocked: seat.state !== 'BLOCKED' }),
          });
          showToast(res.message);
          await refresh();
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const release = e.target.closest('[data-seat-release]');
      if (release && selectedSeatId) {
        try {
          const res = await apiFetch(`/api/events/${eventId}/seating/seats/${selectedSeatId}/release`, { method: 'POST' });
          showToast(res.message);
          await refresh();
          loadHistory(selectedSeatId);
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const remove = e.target.closest('[data-seat-delete]');
      if (remove && selectedSeatId) {
        try {
          await apiFetch(`/api/events/${eventId}/seating/seats/${selectedSeatId}`, { method: 'DELETE' });
          showToast('Seat removed.');
          window.location.reload();
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const deleteSection = e.target.closest('[data-delete-section]');
      if (deleteSection) {
        try {
          await apiFetch(`/api/events/${eventId}/seating/sections/${deleteSection.dataset.deleteSection}`, { method: 'DELETE' });
          showToast('Section removed.');
          window.location.reload();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });

    // --- assigning ----------------------------------------------------------

    const search = root.querySelector('[data-seat-search]');
    const results = root.querySelector('[data-seat-results]');

    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        const term = search.value.trim();
        if (term.length < 2) { results.classList.add('hidden'); return; }
        // Debounced: this is the check-in search endpoint, and one request per
        // keystroke is what runs a shared address out of its API budget.
        timer = setTimeout(async () => {
          try {
            const res = await apiFetch(`/api/events/${eventId}/checkin/search?q=${encodeURIComponent(term)}`);
            const people = res.data.registrations || res.data.results || [];
            results.innerHTML = people.length
              ? people.map((p) => `<button type="button" data-assign-to="${p.id}"
                  class="block w-full px-3 py-2 text-left text-sm hover:bg-indigo-50">
                  <span class="font-medium">${escapeHtml(p.fullName || p.name)}</span>
                  <span class="block font-mono text-xs text-slate-500">${escapeHtml(p.registrationNumber || '')}</span>
                </button>`).join('')
              : '<p class="px-3 py-2 text-xs text-slate-500">Nobody matches that.</p>';
            results.classList.remove('hidden');
          } catch (err) {
            results.classList.add('hidden');
          }
        }, 250);
      });

      results.addEventListener('click', async (e) => {
        const pick = e.target.closest('[data-assign-to]');
        if (!pick || !selectedSeatId) return;
        try {
          const res = await apiFetch(`/api/events/${eventId}/seating/seats/${selectedSeatId}/assign`, {
            method: 'POST',
            body: JSON.stringify({ registrationId: Number(pick.dataset.assignTo) }),
          });
          showToast(res.message);
          search.value = '';
          results.classList.add('hidden');
          await refresh();
          loadHistory(selectedSeatId);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    // --- configuration ------------------------------------------------------

    const toggle = root.querySelector('[data-seating-enabled]');
    if (toggle) {
      toggle.addEventListener('change', async () => {
        try {
          const res = await apiFetch(`/api/events/${eventId}/seating`, {
            method: 'PUT',
            body: JSON.stringify({ enabled: toggle.checked }),
          });
          showToast(res.message);
          window.location.reload();
        } catch (err) {
          // Put back, so the switch never shows a state the server refused.
          toggle.checked = !toggle.checked;
          showToast(err.message, 'error');
        }
      });
    }

    // Attaching a room to a section that has none. The one repair this page
    // needs to offer, because the symptom — a map that never shows anybody
    // seated — gives no hint of the cause.
    root.addEventListener('change', async (e) => {
      const picker = e.target.closest('[data-section-room]');
      if (!picker || !picker.value) return;
      try {
        await apiFetch(`/api/events/${eventId}/seating/sections/${picker.dataset.sectionRoom}`, {
          method: 'PUT',
          body: JSON.stringify({ roomId: Number(picker.value) }),
        });
        showToast('Room set.');
        window.location.reload();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    const sectionForm = root.querySelector('[data-section-form]');
    if (sectionForm) {
      sectionForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(sectionForm));
        await withPending(sectionForm, 'Adding…', async () => {
          try {
            const res = await apiFetch(`/api/events/${eventId}/seating/sections`, {
              method: 'POST',
              body: JSON.stringify({ name: data.name, roomId: data.roomId || null }),
            });
            showToast(res.message);
            window.location.reload();
          } catch (err) {
            showToast(err.errors?.[0]?.msg || err.message, 'error');
          }
        });
      });
    }

    root.querySelectorAll('[data-generate-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        // Two thousand seats is one statement on the server, but the wait is
        // long enough that a second click feels reasonable — and would try to
        // generate the same rows again.
        await withPending(form, 'Generating…', async () => {
          try {
            const res = await apiFetch(
              `/api/events/${eventId}/seating/sections/${form.dataset.sectionId}/generate`,
              {
                method: 'POST',
                body: JSON.stringify({
                  rows: Number(data.rows),
                  seatsPerRow: Number(data.seatsPerRow),
                  startNumber: Number(data.startNumber) || 1,
                  rowLabelStyle: data.rowLabelStyle,
                  type: data.type,
                }),
              }
            );
            showToast(res.message);
            window.location.reload();
          } catch (err) {
            showToast(err.errors?.[0]?.msg || err.message, 'error');
          }
        });
      });
    });
  });
}());
