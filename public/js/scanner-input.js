// Making a scanner gun work, wherever there is a scan box.
//
// This was written for the venue entrance, which no longer exists — an event is
// now the registration desk and the hall doors, and the entrance was a third
// scan that answered nothing the hall door did not already answer. The station
// went; this did not, because it is the part that makes a gun work at all, and
// the hall door is now the station that needs it most.
//
// Three problems, none of them obvious until a door is busy:
//
//   The suffix.   A gun's suffix is configurable — Enter, Tab, or nothing —
//                 and a page that only listens for Enter looks broken on the
//                 other two: the code lands in the box and nothing happens.
//                 So the page stops waiting to be told and works it out, by
//                 firing as soon as a complete, well-formed code appears.
//   Focus.        A gun types into whatever holds focus. Losing it means the
//                 next scan silently goes nowhere, which reads as a broken
//                 scanner rather than a focus problem.
//   Noise.        An operator watches the queue, not the screen. A door needs
//                 to be heard as well as seen.
//
// Usage: attachScanner({ input, onScan, isTypingElsewhere }) — returns { beep }.

/* exported attachScanner */
// eslint-disable-next-line no-unused-vars
function attachScanner({ input, onScan, isTypingElsewhere = () => false }) {
  if (!input) return { beep: () => {} };

  // What a finished ticket looks like, with or without the prefix the gun may
  // have been configured to strip.
  const COMPLETE = /^(?:PSME-EVENT:)?[0-9a-fA-F]{64}$/;
  let settleTimer = null;

  function fire() {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    const value = input.value.trim();
    if (value) onScan(value);
  }

  input.addEventListener('input', () => {
    if (settleTimer) clearTimeout(settleTimer);
    if (!COMPLETE.test(input.value.trim())) return;
    // A short settle before firing. A gun types its characters in a burst, and
    // this waits for the burst to stop rather than racing a suffix still on its
    // way — otherwise a trailing Enter submits the same code a second time.
    settleTimer = setTimeout(fire, 80);
  });

  // Tab would move focus off the input, which is the one thing a door screen
  // cannot afford. Swallowed so a Tab-suffixed gun behaves like an Enter one.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && COMPLETE.test(input.value.trim())) {
      e.preventDefault();
      fire();
    }
  });

  // --- focus ---------------------------------------------------------------
  function refocus() {
    if (isTypingElsewhere()) return;
    input.focus();
  }
  document.addEventListener('click', (e) => {
    // Never out from under somebody deliberately using a control.
    if (e.target.closest('input, select, textarea, button, summary, a')) return;
    refocus();
  });
  window.addEventListener('focus', refocus);
  // If focus has drifted for any reason this file did not anticipate, this puts
  // it back rather than leaving the next scan to vanish.
  setInterval(refocus, 1500);
  refocus();

  // --- sound ---------------------------------------------------------------
  // Two tones, generated rather than loaded: a door is noisy, and an operator
  // watching a queue needs to hear the difference between "in" and "stop".
  // Built lazily because browsers refuse audio before a user gesture, and
  // wrapped because sound is a nicety that must never break a scan.
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

  return { beep, refocus };
}
