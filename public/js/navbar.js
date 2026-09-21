// The site bar: solid-on-scroll, the phone menu, and the two desktop dropdowns.
//
// Extracted from an inline block in views/partials/navbar.ejs so the scroll
// logic below can be tested. It had a bug that no amount of reading the markup
// would have caught, and it is the kind that comes back — see SHRINK_AT.
//
// Nothing here is EJS-interpolated, so it is a plain static file: cached once
// rather than re-sent inside the HTML of every page.

(function () {
  var nav = document.getElementById('siteNav');
  if (!nav) return;

  // --- solid-on-scroll -------------------------------------------------------
  //
  // THE BUG THIS GUARDS AGAINST, because a single threshold looks obviously
  // correct and is not:
  //
  // The bar is sticky, which means it is still in the document's flow, which
  // means its height is part of the document's height. Shrinking it on scroll
  // takes 16px off the page. On a page only a little taller than the viewport
  // that 16px is enough to reduce the maximum scroll position, so the browser
  // pulls scrollY back — under the very threshold that shrank the bar. The
  // class comes off, the 16px returns, the scroll position returns, and the
  // class goes back on. That loop runs at frame rate and looks like the bar
  // vibrating in place.
  //
  // It only appears at certain widths because the content height has to land in
  // that narrow band for the shrink to move scrollY across the threshold at all
  // — which is exactly what makes it look intermittent and random.
  //
  // Two thresholds with a gap WIDER THAN THE HEIGHT CHANGE break the loop: the
  // most the shrink can take off scrollY is the 16px it removed from the page,
  // and 36 - 8 is more than 16, so it can never fall back across. Keep that
  // inequality true if either the gap or the bar's heights ever change.
  var SHRINK_AT = 36;   // grows solid above this
  var GROW_BELOW = 8;   // returns to tall below this

  var ticking = false;
  function syncScrolled() {
    ticking = false;
    var y = window.scrollY || window.pageYOffset || 0;
    if (y > SHRINK_AT) nav.classList.add('is-scrolled');
    else if (y < GROW_BELOW) nav.classList.remove('is-scrolled');
    // Between the two thresholds: whatever it already is. That gap is the
    // hysteresis, and leaving the class alone in it is the entire fix.
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(syncScrolled);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  syncScrolled();

  // --- phone menu ------------------------------------------------------------
  var toggle = document.getElementById('navToggle');
  var panel = document.getElementById('mobileNav');
  var iconOpen = document.getElementById('navIconOpen');
  var iconClose = document.getElementById('navIconClose');

  function setMobileNav(open) {
    panel.classList.toggle('hidden', !open);
    iconOpen.classList.toggle('hidden', open);
    iconClose.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    // Stops the page behind the menu scrolling under a thumb drag.
    document.documentElement.classList.toggle('overflow-hidden', open);
  }
  if (toggle && panel) {
    toggle.addEventListener('click', function () {
      setMobileNav(panel.classList.contains('hidden'));
    });
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !toggle.contains(e.target)) {
        setMobileNav(false);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.classList.contains('hidden')) setMobileNav(false);
    });
    // A menu left open across a resize would keep the page locked once the
    // desktop bar took over and the toggle disappeared.
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1024 && !panel.classList.contains('hidden')) setMobileNav(false);
      // A resize changes the content height, so the bar's state can be stale.
      // Re-read rather than assume — and the hysteresis above means re-reading
      // here cannot start the loop either.
      onScroll();
    }, { passive: true });
  }

  var mAboutBtn = document.getElementById('mobileAboutBtn');
  var mAbout = document.getElementById('mobileAbout');
  var mChevron = document.getElementById('mobileAboutChevron');
  if (mAboutBtn && mAbout) {
    mAboutBtn.addEventListener('click', function () {
      var open = mAbout.classList.contains('hidden');
      mAbout.classList.toggle('hidden', !open);
      mAbout.classList.toggle('flex', open);
      if (mChevron) mChevron.classList.toggle('rotate-180', open);
      mAboutBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // --- desktop dropdowns -----------------------------------------------------
  // Click and hover both open them; Escape and an outside click close them.
  // Hover alone is not enough — it is unreachable from a keyboard, and from a
  // touch screen wide enough to still be showing the desktop bar.
  function wireMenu(wrapId, btnId, menuId, chevronId) {
    var wrap = document.getElementById(wrapId);
    var btn = document.getElementById(btnId);
    var menu = document.getElementById(menuId);
    var chevron = chevronId ? document.getElementById(chevronId) : null;
    if (!wrap || !btn || !menu) return;

    function set(open) {
      menu.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (chevron) chevron.classList.toggle('rotate-180', open);
    }
    btn.addEventListener('click', function () { set(menu.classList.contains('hidden')); });
    wrap.addEventListener('mouseenter', function () { set(true); });
    wrap.addEventListener('mouseleave', function () { set(false); });
    wrap.addEventListener('focusout', function (e) {
      if (!wrap.contains(e.relatedTarget)) set(false);
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) set(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  }
  wireMenu('aboutDropdown', 'aboutDropdownBtn', 'aboutDropdownMenu', 'aboutChevron');
  wireMenu('userMenuDropdown', 'userMenuBtn', 'userMenuList', null);
}());
