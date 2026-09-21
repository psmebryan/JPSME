// Motion on the home page: sections that settle in as you reach them, and
// statistics that count up rather than simply being there.
//
// The whole system is opt-in from here. Nothing in the stylesheet hides
// anything until this file puts data-motion="on" on <html> — so a reader with
// JavaScript off, a script that 404s after a bad deploy, or an error thrown
// earlier on the page all get the complete page, immediately. A reveal
// animation that fails closed leaves a blank screen, and a marketing page that
// is blank for some readers is worse than one that never animated.
//
// Two things are deliberately NOT done here:
//
//   No inline styles. style-src carries a nonce and no 'unsafe-inline', and a
//   nonce does not apply to style ATTRIBUTES — so a stagger delay written as
//   style="--i:3" is silently dropped. The stagger is nth-child in the CSS.
//
//   No library. script-src is 'self', so anything from a CDN is blocked with
//   no visible error. IntersectionObserver is in every browser this site
//   supports and is a better fit than any of them anyway.

(function () {
  const root = document.documentElement;

  // Asked for less movement, or too old for the observer: leave the page alone
  // entirely. Not setting the attribute means the CSS never hides anything, so
  // this is a complete and correct page rather than a degraded one.
  const wantsLessMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (wantsLessMotion || !('IntersectionObserver' in window)) return;

  // Set before first paint where possible, so the hidden state is in force
  // before anything is drawn. A late flip would show each section and then
  // snatch it back, which reads as a flicker.
  root.setAttribute('data-motion', 'on');

  function start() {
    // --- sections arriving ---------------------------------------------------
    const targets = document.querySelectorAll('.reveal');
    if (targets.length) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          // Once shown, stay shown. Re-animating on the way back up is the
          // thing that makes a long page feel restless.
          observer.unobserve(entry.target);
        });
      }, {
        // Fires a little before the element reaches the fold, so the movement
        // finishes about when the reader's eye arrives rather than starting
        // then.
        rootMargin: '0px 0px -12% 0px',
        threshold: 0.05,
      });
      targets.forEach((el) => observer.observe(el));
    }

    // --- numbers counting ----------------------------------------------------
    //
    // The figure is already in the HTML, so it is correct before this runs and
    // correct if this never runs. Counting only replaces the text of an element
    // that already said the right thing.
    const counters = document.querySelectorAll('[data-count-to]');
    if (!counters.length) return;

    const DURATION = 1100;
    // Decelerating, so it lands softly on the real figure instead of stopping
    // dead at it.
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

    const countObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        countObserver.unobserve(el);

        const target = Number(el.dataset.countTo);
        // Not a number, or small enough that counting to it looks silly.
        if (!Number.isFinite(target) || target <= 1) return;

        const started = performance.now();
        const tick = (now) => {
          const progress = Math.min(1, (now - started) / DURATION);
          el.textContent = String(Math.round(target * easeOut(progress)));
          if (progress < 1) requestAnimationFrame(tick);
          // The last frame writes the exact target rather than a rounded
          // approach to it, so the number on screen is the real one.
          else el.textContent = String(target);
        };
        el.textContent = '0';
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.4 });

    counters.forEach((el) => countObserver.observe(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
