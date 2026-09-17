// The attendee's seat plan.
//
// A seat map is one of the few screens in this app where what you are looking
// at is being changed by other people while you look at it. Three things follow
// from that, and they are most of this file:
//
//   * Taking a seat is two steps, hold then confirm, because a plan you tapped
//     five minutes ago is not a plan you can trust. The hold is what makes the
//     second step honest.
//   * A refusal is normal, not an error. "Somebody just took that seat" comes
//     back 200 with ok:false, and the right response is to redraw and let them
//     pick again — not to show a failure.
//   * The map is re-fetched on a timer, but never while a hold is running with
//     its own countdown on screen: repainting under someone's finger mid-choice
//     is how you get the wrong seat confirmed.

(function () {
  // How often the plan is refreshed when nothing is being held. Long enough to
  // be cheap for a hall of several hundred people all watching at once, short
  // enough that a seat someone took a moment ago stops looking free.
  const REFRESH_MS = 20000;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  function mmss(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-seat-picker]');
    if (!root) return;

    const map = root.querySelector('[data-map]');
    // Absent when the page rendered a blocked state — there is nothing to draw.
    if (!map) return;

    const eventId = root.dataset.eventId;
    const message = root.querySelector('[data-message]');
    const holdPanel = root.querySelector('[data-hold-panel]');
    const holdLabel = root.querySelector('[data-hold-label]');
    const holdCountdown = root.querySelector('[data-hold-countdown]');
    const confirmBtn = root.querySelector('[data-confirm]');
    const giveUpBtn = root.querySelector('[data-give-up]');
    const hasSeat = root.querySelector('[data-has-seat]');
    const noSeat = root.querySelector('[data-no-seat]');
    const seatLabel = root.querySelector('[data-seat-label]');
    const seatWhere = root.querySelector('[data-seat-where]');

    // The live hold: { seatId, label, until }. Null whenever nothing is held.
    let hold = null;
    let countdownTimer = null;
    let refreshTimer = null;

    function say(text, tone) {
      if (!text) { message.classList.add('hidden'); return; }
      message.textContent = text;
      message.className = `mt-4 rounded-lg px-4 py-3 text-sm ${
        tone === 'bad'
          ? 'border border-red-300 bg-red-50 text-red-800'
          : 'border border-green-300 bg-green-50 text-green-800'}`;
    }

    // --- the map ------------------------------------------------------------

    function seatClass(seat) {
      if (hold && seat.id === hold.seatId) return 'seat seat-holding';
      if (seat.mine) return 'seat seat-mine';
      if (seat.state === 'BLOCKED') return 'seat seat-blocked';
      if (seat.state === 'AVAILABLE') return 'seat seat-available';
      // HELD, ASSIGNED, OCCUPIED and AWAY are all "not yours to take", and which
      // one it is would leak something about another attendee — including, for
      // AWAY, that they are out of the room right now.
      return 'seat seat-taken';
    }

    function seatTitle(seat) {
      if (seat.mine) return `${seat.label} — yours`;
      if (hold && seat.id === hold.seatId) return `${seat.label} — holding for you`;
      if (seat.state === 'BLOCKED') return `${seat.label} — not in use`;
      if (seat.state === 'AVAILABLE') return `${seat.label} — free`;
      return `${seat.label} — taken`;
    }

    function draw(sections) {
      if (!sections.length) {
        map.innerHTML = '<p class="text-sm text-slate-500">No seat plan has been published for this event yet.</p>';
        return;
      }

      map.innerHTML = sections.map((section) => {
        const rows = section.rows.map((row) => `
          <div class="flex items-start gap-1.5">
            <span class="seat-row-label">${escapeHtml(row.label)}</span>
            <div class="seat-map">
              ${row.seats.map((seat) => {
    const free = seat.state === 'AVAILABLE' && !seat.mine;
    // Only a seat that can actually be taken is a button. Everything else
    // is a span, so it is not a tab stop and cannot be activated.
    return free
      ? `<button type="button" class="${seatClass(seat)}" data-seat-id="${seat.id}" title="${escapeHtml(seatTitle(seat))}">${escapeHtml(seat.label)}</button>`
      : `<span class="${seatClass(seat)}" title="${escapeHtml(seatTitle(seat))}" aria-label="${escapeHtml(seatTitle(seat))}">${escapeHtml(seat.label)}</span>`;
  }).join('')}
            </div>
          </div>`).join('');

        return `
          <section>
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="text-sm font-semibold text-slate-900">${escapeHtml(section.name)}</h2>
              <p class="text-xs text-slate-500">
                ${section.counts.available} of ${section.counts.total} free${
  section.room ? ` &middot; ${escapeHtml(section.room.name)}` : ''}
              </p>
            </div>
            <div class="seat-stage mt-2">Front / Stage</div>
            <div class="mt-2 space-y-1.5 overflow-x-auto pb-1">${rows}</div>
          </section>`;
      }).join('');
    }

    function showSeat(seat) {
      if (seat) {
        seatLabel.textContent = seat.label;
        seatWhere.textContent = [seat.section, seat.room].filter(Boolean).join(' · ');
        hasSeat.classList.remove('hidden');
        noSeat.classList.add('hidden');
      } else {
        hasSeat.classList.add('hidden');
        noSeat.classList.remove('hidden');
      }
    }

    async function load() {
      const res = await apiFetch(`/api/events/${eventId}/seating/my-map`);
      draw(res.data.sections || []);
      showSeat(res.data.mySeat);
    }

    // --- the hold -----------------------------------------------------------

    function stopCountdown() {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }

    function clearHold() {
      hold = null;
      stopCountdown();
      holdPanel.classList.add('hidden');
    }

    function tickCountdown() {
      if (!hold) return;
      const left = hold.until - Date.now();
      if (left <= 0) {
        // Expired in the browser. The server already treats it as expired, so
        // the honest thing is to drop it here too and redraw — otherwise the
        // Confirm button sits there promising something it can no longer do.
        clearHold();
        say('Your hold expired. Pick a seat again.', 'bad');
        load().catch(() => {});
        return;
      }
      holdCountdown.textContent = mmss(left);
    }

    function startHold(seatId, label, until) {
      hold = { seatId, label, until };
      holdLabel.textContent = label;
      holdPanel.classList.remove('hidden');
      tickCountdown();
      stopCountdown();
      countdownTimer = setInterval(tickCountdown, 1000);
    }

    // --- acting -------------------------------------------------------------

    map.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-seat-id]');
      if (!button) return;
      const seatId = button.dataset.seatId;

      try {
        const res = await withPending(button, '…', () => apiFetch(
          `/api/events/${eventId}/seating/seats/${seatId}/hold`,
          { method: 'POST' },
        ));
        if (!res) return; // a second click while the first was in flight

        if (!res.data.ok) {
          // Somebody beat them to it. Redraw so the plan matches reality, and
          // say so plainly rather than dressing it up as a failure.
          say(res.data.message || 'That seat has gone. Please pick another.', 'bad');
          clearHold();
          await load();
          return;
        }

        say('');
        startHold(Number(seatId), res.data.label, new Date(res.data.heldUntil).getTime());
        await load();
      } catch (err) {
        say(err.message || 'That seat could not be held.', 'bad');
      }
    });

    confirmBtn.addEventListener('click', async () => {
      if (!hold) return;
      const seatId = hold.seatId;
      try {
        const res = await withPending(confirmBtn, 'Confirming…', () => apiFetch(
          `/api/events/${eventId}/seating/seats/${seatId}/confirm`,
          { method: 'POST' },
        ));
        if (!res) return;

        if (!res.data.ok) {
          say(res.data.message || 'That seat could not be confirmed.', 'bad');
          clearHold();
          await load();
          return;
        }

        clearHold();
        say(`${res.data.label} is yours.`, 'good');
        await load();
      } catch (err) {
        say(err.message || 'That seat could not be confirmed.', 'bad');
      }
    });

    giveUpBtn.addEventListener('click', async () => {
      if (!hold) return;
      const seatId = hold.seatId;
      try {
        await withPending(giveUpBtn, 'Releasing…', () => apiFetch(
          `/api/events/${eventId}/seating/seats/${seatId}/give-up`,
          { method: 'POST' },
        ));
        clearHold();
        say('');
        await load();
      } catch (err) {
        say(err.message || 'That seat could not be released.', 'bad');
      }
    });

    // --- keeping up -----------------------------------------------------------

    refreshTimer = setInterval(() => {
      // Never mid-choice: redrawing the plan under somebody's finger while they
      // are deciding is how the wrong seat gets confirmed.
      if (hold) return;
      if (document.hidden) return;
      load().catch(() => {});
    }, REFRESH_MS);

    window.addEventListener('pagehide', () => {
      clearInterval(refreshTimer);
      stopCountdown();
    });

    load().catch((err) => {
      map.innerHTML = `<p class="text-sm text-red-700">${escapeHtml(err.message || 'The seat plan could not be loaded.')}</p>`;
    });
  });
}());
