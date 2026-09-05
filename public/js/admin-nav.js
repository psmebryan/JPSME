// Loads admin sidebar modules via AJAX so navigating between Dashboard/Users/Events/Settings
// doesn't do a full page reload, while still keeping normal URLs (back/forward/refresh work).

function makeSubmenuToggle(toggleId, submenuId, chevronId) {
  const toggle = document.getElementById(toggleId);
  const submenu = document.getElementById(submenuId);
  const chevron = document.getElementById(chevronId);

  return function setOpen(open) {
    if (!submenu || !toggle) return;
    submenu.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (chevron) {
      chevron.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
    }
  };
}

// Module scope so both the DOMContentLoaded wiring below and loadAdminPage()
// (called from the popstate/link-click handlers, outside that closure) can reach them.
const openChapterSubmenu = makeSubmenuToggle('chapter-management-toggle', 'chapter-submenu', 'chapter-management-chevron');
const openUserSubmenu = makeSubmenuToggle('user-management-toggle', 'user-submenu', 'user-management-chevron');
const openCertificateSubmenu = makeSubmenuToggle('certificate-management-toggle', 'certificate-submenu', 'certificate-management-chevron');
const openEmailSubmenu = makeSubmenuToggle('email-management-toggle', 'email-submenu', 'email-management-chevron');
const openInvitationSubmenu = makeSubmenuToggle('invitation-management-toggle', 'invitation-submenu', 'invitation-management-chevron');
const openCheckinSubmenu = makeSubmenuToggle('checkin-management-toggle', 'checkin-submenu', 'checkin-management-chevron');

function openSubmenuForPath(path) {
  if (path.startsWith('/admin/organizations') || path.startsWith('/admin/organization-members') || path.startsWith('/admin/organization-admins')) {
    openChapterSubmenu(true);
  }
  if (path.startsWith('/admin/users')) {
    openUserSubmenu(true);
  }
  if (path.startsWith('/admin/certificates') || path.startsWith('/admin/event-certificates') || /^\/admin\/events\/\d+\/certificate$/.test(path)) {
    openCertificateSubmenu(true);
  }
  if (path.startsWith('/admin/emails') || path.startsWith('/admin/event-emails') || path.startsWith('/admin/broadcasts') || /^\/admin\/events\/\d+\/email$/.test(path)) {
    openEmailSubmenu(true);
  }
  if (path.startsWith('/admin/invitations')) {
    openInvitationSubmenu(true);
  }
  // Also opens on the per-event scanner and report pages, which live under
  // /admin/events/:id/ but belong to this module as far as a reader is
  // concerned — the sidebar should show where they actually are.
  if (path.startsWith('/admin/check-in') || /^\/admin\/events\/\d+\/check-in/.test(path)) {
    openCheckinSubmenu(true);
  }
}

// The sidebar is a slide-over below lg and an ordinary column from lg up, so
// all of this only ever runs on small screens. Kept here rather than inline in
// the layout because the layout has a script nonce and no unsafe-inline.
function setupMobileSidebar() {
  const sidebar = document.querySelector('[data-admin-sidebar]');
  const backdrop = document.querySelector('[data-admin-backdrop]');
  const toggle = document.querySelector('[data-sidebar-toggle]');
  if (!sidebar || !backdrop || !toggle) return;

  function setOpen(open) {
    sidebar.classList.toggle('-translate-x-full', !open);
    backdrop.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Stops the page behind the drawer scrolling under a thumb that meant to
    // scroll the menu.
    document.body.classList.toggle('overflow-hidden', open);
  }

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  // Close after navigating. Admin links load their page over AJAX, so without
  // this the drawer would stay open on top of the page it just opened.
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('a[href]')) setOpen(false);
  });

  // Returning to a wide viewport must not leave the drawer state stuck: the
  // sidebar becomes a normal column again and the backdrop would otherwise
  // hang over it.
  window.matchMedia('(min-width: 1024px)').addEventListener('change', (e) => {
    if (e.matches) setOpen(false);
  });
}
document.addEventListener('DOMContentLoaded', () => {
  setupMobileSidebar();
  const nav = document.getElementById('admin-nav');
  const content = document.getElementById('admin-content');
  if (!nav || !content) return;

  setActiveLink(nav, window.location.pathname + window.location.search);
  openSubmenuForPath(window.location.pathname);

  document.getElementById('checkin-management-toggle')?.addEventListener('click', (e) => {
    openCheckinSubmenu(e.currentTarget.getAttribute('aria-expanded') !== 'true');
  });
  document.getElementById('chapter-management-toggle')?.addEventListener('click', (e) => {
    openChapterSubmenu(e.currentTarget.getAttribute('aria-expanded') !== 'true');
  });
  document.getElementById('user-management-toggle')?.addEventListener('click', (e) => {
    openUserSubmenu(e.currentTarget.getAttribute('aria-expanded') !== 'true');
  });
  document.getElementById('certificate-management-toggle')?.addEventListener('click', (e) => {
    openCertificateSubmenu(e.currentTarget.getAttribute('aria-expanded') !== 'true');
  });
  document.getElementById('email-management-toggle')?.addEventListener('click', (e) => {
    openEmailSubmenu(e.currentTarget.getAttribute('aria-expanded') !== 'true');
  });
  document.getElementById('invitation-management-toggle')?.addEventListener('click', (e) => {
    openInvitationSubmenu(e.currentTarget.getAttribute('aria-expanded') !== 'true');
  });

  nav.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-admin-link]');
    if (!link) return;

    e.preventDefault();
    // Compare against pathname+search, not pathname alone — two different
    // sidebar links can share a pathname and differ only by query string
    // (e.g. "Manage Invitations" vs "Invitation Requests" both live at
    // /admin/invitations), and pathname-only comparison treated those as the
    // same page, silently no-op'ing the click.
    const currentUrl = window.location.pathname + window.location.search;
    if (link.getAttribute('href') !== currentUrl) {
      loadAdminPage(link.getAttribute('href'), true);
    }
  });

  window.addEventListener('popstate', () => {
    // pathname alone would drop a query-string-differentiated page (e.g.
    // "Invitation Requests" at /admin/invitations?source=SELF_REQUESTED) when
    // navigating back/forward to it — same bug as the click handler above.
    loadAdminPage(window.location.pathname + window.location.search, false);
  });
});

async function loadAdminPage(url, pushState) {
  const nav = document.getElementById('admin-nav');
  const content = document.getElementById('admin-content');

  try {
    const response = await fetch(url, {
      headers: { 'X-Requested-With': 'fragment' },
      credentials: 'same-origin',
    });

    // Session likely expired or user was redirected to the login page; do a full navigation.
    if (response.redirected || !response.ok) {
      window.location.href = response.url || url;
      return;
    }

    const html = await response.text();
    content.innerHTML = html;

    const encodedTitle = response.headers.get('X-Page-Title');
    if (encodedTitle) {
      const decodedTitle = decodeURIComponent(encodedTitle);
      document.title = `${decodedTitle} | JPSME Admin`;
      const pageTitleEl = document.getElementById('admin-page-title');
      if (pageTitleEl) pageTitleEl.textContent = decodedTitle;
    }

    if (pushState) {
      window.history.pushState({}, '', url);
    }
    setActiveLink(nav, url);
    openSubmenuForPath(url);

    content.scrollIntoView({ block: 'start' });

    // Let admin.js (re-)attach handlers for whatever module just got loaded.
    document.dispatchEvent(new CustomEvent('admin:content-loaded'));
  } catch (err) {
    window.location.href = url;
  }
}

function setActiveLink(nav, path) {
  nav.querySelectorAll('a[data-admin-link]').forEach((link) => {
    const isActive = link.getAttribute('href') === path;
    link.classList.toggle('bg-indigo-600/10', isActive);
    link.classList.toggle('text-white', isActive);
    link.classList.toggle('border-indigo-500', isActive);
    link.classList.toggle('border-transparent', !isActive);
  });
}
