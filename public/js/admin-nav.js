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

function openSubmenuForPath(path) {
  if (path.startsWith('/admin/chapters') || path.startsWith('/admin/chapter-members')) {
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
}

document.addEventListener('DOMContentLoaded', () => {
  const nav = document.getElementById('admin-nav');
  const content = document.getElementById('admin-content');
  if (!nav || !content) return;

  setActiveLink(nav, window.location.pathname + window.location.search);
  openSubmenuForPath(window.location.pathname);

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
    if (link.getAttribute('href') !== window.location.pathname) {
      loadAdminPage(link.getAttribute('href'), true);
    }
  });

  window.addEventListener('popstate', () => {
    loadAdminPage(window.location.pathname, false);
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
