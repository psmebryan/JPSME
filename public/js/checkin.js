// The door screen's behaviour. One rule shapes all of it: between two scans the
// operator must not have to touch anything. The input keeps focus, the scanner's
// own Enter submits, and the result clears itself out of the way.
//
// This file renders verdicts; it never decides them. Every question about
// whether someone may come in is answered by POST /api/events/:id/checkin, and
// the only thing sent is the string the scanner typed.

document.addEventListener('DOMContentLoaded', () => {
  const root = document.querySelector('[data-checkin-root]');
  if (!root) return;

  const eventId = root.dataset.eventId;
  const form = root.querySelector('[data-scan-form]');
  const input = root.querySelector('[data-scan-input]');
  const stationInput = root.querySelector('[data-station]');
  const resultPanel = root.querySelector('[data-result]');
  const manual = root.querySelector('[data-manual]');
  const manualSearch = root.querySelector('[data-manual-search]');
  const manualResults = root.querySelector('[data-manual-results]');
  const recentList = root.querySelector('[data-recent]');

  const STATION_KEY = 'jpsme.checkin.station';
  let busy = false;
  let clearTimer = null;

  // --- station ---------------------------------------------------------------
  // Remembered per browser so a station set once at the start of a shift is
  // still set after a refresh or an accidental back-navigation. Per-viewer
  // convenience only; the value that counts is the one sent with each scan.
  try {
    const saved = localStorage.getItem(STATION_KEY);
    if (saved) stationInput.value = saved;
  } catch (err) { /* private mode, blocked storage — the field just starts empty */ }

  stationInput.addEventListener('change', () => {
    stationInput.value = stationInput.value.trim().toUpperCase();
    try { localStorage.setItem(STATION_KEY, stationInput.value); } catch (err) { /* not worth surfacing */ }
  });

  // --- focus -----------------------------------------------------------------
  // A gun scanner types into whatever holds focus, so losing focus means the
  // next scan silently goes nowhere — the single worst failure this screen can
  // have, because it looks like the scanner broke. Focus is therefore taken back
  // aggressively, but never out from under someone who is deliberately typing
  // somewhere else.
  function isTypingElsewhere() {
    const el = document.activeElement;
    if (!el || el === input) return false;
    return el === stationInput || el === manualSearch || el.tagName === 'SUMMARY';
  }

  function refocus() {
    if (isTypingElsewhere()) return;
    input.focus();
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-manual]') || e.target.closest('[data-station]')) return;
    refocus();
  });
  window.addEventListener('focus', refocus);
  // A scanner fires whenever it fires. If focus has drifted for any reason this
  // file did not anticipate, this quietly puts it back.
  setInterval(refocus, 1500);
  refocus();

  // --- sound -----------------------------------------------------------------
  // Two tones, generated rather than loaded: a door is noisy and an operator
  // watching a queue rather than a screen needs to hear the difference between
  // "in" and "stop". Built lazily because browsers refuse audio before a user
  // gesture, and wrapped because audio is a nicety — it must never break a scan.
  let audio = null;
  function beep(ok) {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.frequency.value = ok ? 880 : 220;
      osc.type = ok ? 'sine' : 'square';
      gain.gain.setValueAtTime(0.12, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (ok ? 0.15 : 0.4));
      osc.start();
      osc.stop(audio.currentTime + (ok ? 0.15 : 0.4));
    } catch (err) { /* muted, blocked, unsupported — the screen still says it */ }
  }

  // --- the verdict panel -----------------------------------------------------
  // Built with textContent throughout: every string below except the fixed
  // headline comes from the database, and a registrant's own name must never be
  // able to become markup on a screen an admin is staring at all day.
  const TONE = {
    SUCCESS: { border: 'border-green-500', bg: 'bg-green-50', text: 'text-green-800', head: 'CHECKED IN' },
    ALREADY_CHECKED_IN: { border: 'border-amber-500', bg: 'bg-amber-50', text: 'text-amber-800', head: 'ALREADY CHECKED IN' },
    WRONG_EVENT: { border: 'border-red-500', bg: 'bg-red-50', text: 'text-red-800', head: 'WRONG EVENT' },
    INVALID_QR: { border: 'border-red-500', bg: 'bg-red-50', text: 'text-red-800', head: 'INVALID CODE' },
    CANCELLED: { border: 'border-red-500', bg: 'bg-red-50', text: 'text-red-800', head: 'CANCELLED' },
    UNPAID: { border: 'border-red-500', bg: 'bg-red-50', text: 'text-red-800', head: 'PAYMENT NOT CONFIRMED' },
    REJECTED: { border: 'border-red-500', bg: 'bg-red-50', text: 'text-red-800', head: 'ACCOUNT REJECTED' },
    NOT_REGISTERED: { border: 'border-red-500', bg: 'bg-red-50', text: 'text-red-800', head: 'NOT REGISTERED' },
    // Neither green nor red. Removing a check-in is a correction that worked,
    // not an admission and not a refusal, and colouring it like either would
    // tell the operator the wrong thing at a glance.
    UNDONE: { border: 'border-slate-400', bg: 'bg-slate-50', text: 'text-slate-800', head: 'CHECK-IN REMOVED' },
    NOT_CHECKED_IN: { border: 'border-amber-500', bg: 'bg-amber-50', text: 'text-amber-800', head: 'NOTHING TO REMOVE' },
  };

  function line(cls, text) {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    return p;
  }

  function render(data) {
    const tone = TONE[data.result] || TONE.INVALID_QR;
    resultPanel.className = `mt-4 rounded-xl border-2 ${tone.border} ${tone.bg} p-8 text-center`;
    resultPanel.replaceChildren();

    resultPanel.appendChild(line(`text-2xl font-bold tracking-wide ${tone.text}`, tone.head));

    if (data.participant) {
      resultPanel.appendChild(line('mt-3 text-3xl font-semibold text-slate-900 break-words', data.participant.name));
      if (data.participant.registrationNumber) {
        resultPanel.appendChild(line('mt-1 font-mono text-base text-slate-600', data.participant.registrationNumber));
      }
      if (data.participant.organizationPath) {
        resultPanel.appendChild(line('mt-1 text-sm text-slate-500 break-words', data.participant.organizationPath));
      }
    }

    if (data.checkedInAt) {
      const at = new Date(data.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      resultPanel.appendChild(line('mt-3 text-lg tabular-nums text-slate-700',
        data.result === 'SUCCESS' ? at : `First checked in at ${at}`));
    }

    if (data.message && data.result !== 'SUCCESS') {
      resultPanel.appendChild(line('mt-2 text-sm text-slate-600', data.message));
    }

    beep(data.ok === true);

    // A refusal stays up longer than an admission. A success is confirmed by the
    // person walking past; a refusal has to be read, understood, and acted on at
    // the desk, and clearing it early would lose the reason.
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(reset, data.ok ? 4000 : 9000);
  }

  function renderFault(message) {
    resultPanel.className = 'mt-4 rounded-xl border-2 border-red-500 bg-red-50 p-8 text-center';
    resultPanel.replaceChildren(
      line('text-2xl font-bold tracking-wide text-red-800', 'NOT CHECKED IN'),
      line('mt-2 text-sm text-slate-700', message),
    );
    beep(false);
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(reset, 9000);
  }

  function reset() {
    resultPanel.className = 'mt-4 rounded-xl border-2 border-dashed border-slate-200 bg-white p-8 text-center';
    resultPanel.replaceChildren(line('text-slate-400 text-sm', 'Scan a ticket to begin.'));
  }

  // --- scanning --------------------------------------------------------------
  async function submitScan(rawValue) {
    const value = (rawValue || '').trim();
    if (!value || busy) return;
    busy = true;
    input.value = '';

    try {
      const res = await apiFetch(`/api/events/${eventId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({ qrToken: value, scannerIdentifier: stationInput.value || undefined }),
      });
      render(res.data);
      refreshStats();
    } catch (err) {
      // A thrown error here is a real fault — no access, session expired,
      // network gone — not a refused scan, which comes back as a normal
      // response. Said plainly so nobody at a door mistakes a dropped
      // connection for a rejected ticket.
      renderFault(err.status === 401 ? 'Your session expired. Reload and sign in again.' : err.message);
    } finally {
      busy = false;
      refocus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitScan(input.value);
  });

  // --- making the scanner's suffix irrelevant ---------------------------------
  //
  // A form only submits on Enter, and a gun scanner's suffix is configurable —
  // Enter, Tab, or nothing at all, depending on how it was set up. On a scanner
  // sending Tab or nothing, the code would land in the box and absolutely
  // nothing would happen, which at a door reads as "the scanner is broken"
  // rather than "the scanner is configured differently".
  //
  // So the page stops waiting to be told the scan finished and works it out: a
  // complete, well-formed code is submitted the moment it appears. Enter still
  // works, Tab now works, and no suffix at all works.
  const COMPLETE = /^(?:PSME-EVENT:)?[0-9a-fA-F]{64}$/;
  let settleTimer = null;

  input.addEventListener('input', () => {
    const value = input.value.trim();
    if (settleTimer) clearTimeout(settleTimer);
    if (!COMPLETE.test(value)) return;

    // A short settle before firing. A scanner types its characters in a burst
    // of keystrokes, and this waits for the burst to stop rather than racing a
    // suffix that may still be on its way — otherwise a trailing Enter would
    // submit a second time.
    settleTimer = setTimeout(() => submitScan(input.value), 80);
  });

  // Tab would move focus off the input, which is the one thing this screen
  // cannot afford: the next scan would be typed into nothing. Swallowed here so
  // a Tab-suffixed scanner behaves exactly like an Enter-suffixed one.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && COMPLETE.test(input.value.trim())) {
      e.preventDefault();
      if (settleTimer) clearTimeout(settleTimer);
      submitScan(input.value);
    }
  });

  // --- removing a check-in ---------------------------------------------------
  //
  // The correction the door has always needed. Somebody scans the person behind
  // the one they meant, or one code is held up by two people and the wrong one
  // walks through — without this the only fix is a database edit, which during
  // an event means no fix at all.
  //
  // Confirmed first, and named in the prompt, because this is the one control
  // on a screen built for speed that should NOT be fast: it frees a spent
  // ticket to be scanned again, and an accidental click would do that silently.
  async function submitUndo(registrationId, name) {
    if (busy) return;
    const who = name || 'this person';
    const question = `Remove ${who}'s check-in? Their ticket can then be scanned again. `
      + 'The original check-in stays in the report.';
    // eslint-disable-next-line no-alert, no-restricted-globals
    if (!confirm(question)) {
      refocus();
      return;
    }

    busy = true;
    try {
      const res = await apiFetch(`/api/events/${eventId}/checkin/undo`, {
        method: 'POST',
        body: JSON.stringify({ registrationId: Number(registrationId), scannerIdentifier: stationInput.value || undefined }),
      });
      render(res.data);
      refreshStats();
      // The lookup list, if it is open, is now showing stale state for exactly
      // the person just changed.
      if (manualSearch.value.trim().length >= 2) runSearch();
    } catch (err) {
      renderFault(err.status === 401 ? 'Your session expired. Reload and sign in again.' : err.message);
    } finally {
      busy = false;
      refocus();
    }
  }

  // Delegated, because the recent list is replaced wholesale on every refresh —
  // a listener bound per button would be lost the moment somebody else scanned.
  recentList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-undo]');
    if (!btn) return;
    submitUndo(btn.dataset.undo, btn.dataset.undoName);
  });

  function undoButton(registrationId, name) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-red-600 hover:text-red-700 hover:underline font-medium';
    btn.textContent = 'Remove';
    btn.dataset.undo = String(registrationId);
    btn.dataset.undoName = name || '';
    return btn;
  }

  // --- stats and recent list -------------------------------------------------
  async function refreshStats() {
    try {
      const res = await apiFetch(`/api/events/${eventId}/checkin/stats`);
      const { stats, recent } = res.data;
      Object.keys(stats).forEach((key) => {
        const el = root.querySelector(`[data-stat="${key}"]`);
        if (el) el.textContent = stats[key];
      });

      recentList.replaceChildren();
      if (!recent.length) {
        const li = document.createElement('li');
        li.className = 'py-2 text-slate-400';
        li.textContent = 'Nobody has been checked in yet.';
        recentList.appendChild(li);
        return;
      }
      recent.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'py-2 flex items-center justify-between gap-3';
        const name = document.createElement('span');
        name.className = 'truncate';
        name.textContent = r.eventRegistration ? r.eventRegistration.fullName : 'Unknown';

        const right = document.createElement('span');
        right.className = 'flex items-center gap-3 shrink-0';
        const time = document.createElement('span');
        time.className = 'text-slate-500 tabular-nums';
        time.textContent = new Date(r.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        right.appendChild(time);

        // checkedInAt is the registration's state now, not what it was when
        // this scan happened — so a row whose admission was already taken back
        // says so instead of offering to remove it a second time.
        if (r.eventRegistration && r.eventRegistration.checkedInAt) {
          right.appendChild(undoButton(r.eventRegistration.id, r.eventRegistration.fullName));
        } else if (r.eventRegistration) {
          right.appendChild(line('text-slate-400 text-xs', 'Removed'));
        }

        li.append(name, right);
        recentList.appendChild(li);
      });
    } catch (err) { /* the counts are informational; a failed refresh must not disturb the door */ }
  }

  // --- manual lookup ---------------------------------------------------------
  let searchTimer = null;
  manualSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });

  async function runSearch() {
    const term = manualSearch.value.trim();
    manualResults.replaceChildren();
    if (term.length < 2) return;

    try {
      const res = await apiFetch(`/api/events/${eventId}/checkin/search?q=${encodeURIComponent(term)}`);
      const rows = res.data.results;
      if (!rows.length) {
        manualResults.appendChild(line('py-3 text-sm text-slate-500', 'Nobody matches that.'));
        return;
      }
      rows.forEach((r) => manualResults.appendChild(manualRow(r)));
    } catch (err) {
      manualResults.appendChild(line('py-3 text-sm text-red-600', err.message));
    }
  }

  function manualRow(r) {
    const wrap = document.createElement('div');
    wrap.className = 'py-3 flex items-center justify-between gap-3';

    const left = document.createElement('div');
    left.className = 'min-w-0';
    const name = document.createElement('p');
    name.className = 'font-medium text-slate-900 truncate';
    name.textContent = r.fullName;
    const meta = document.createElement('p');
    meta.className = 'text-xs text-slate-500 font-mono';
    meta.textContent = [r.registrationNumber || '—', r.status].join(' · ');
    left.append(name, meta);

    const right = document.createElement('div');
    if (r.checkedInAt) {
      // The other way to reach a correction: when the mis-scan has scrolled off
      // the recent list, staff search the person up and remove it here.
      right.className = 'flex items-center gap-3 shrink-0';
      right.appendChild(line('text-xs text-green-700', 'Already in'));
      right.appendChild(undoButton(r.id, r.fullName));
      right.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-undo]');
        if (btn) submitUndo(btn.dataset.undo, btn.dataset.undoName);
      });
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary text-sm';
      btn.textContent = 'Check in';
      // Goes through the manual endpoint, which applies the identical rules —
      // this button cannot admit someone the scanner would refuse.
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await apiFetch(`/api/events/${eventId}/checkin/manual`, {
            method: 'POST',
            body: JSON.stringify({ registrationId: r.id, scannerIdentifier: stationInput.value || undefined }),
          });
          render(res.data);
          refreshStats();
          runSearch();
        } catch (err) {
          renderFault(err.message);
        } finally {
          btn.disabled = false;
        }
      });
      right.appendChild(btn);
    }

    wrap.append(left, right);
    return wrap;
  }
});
