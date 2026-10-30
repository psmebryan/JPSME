// Searchable dropdowns for admin filters.
//
// Any <select data-searchable> becomes a button that opens a list with a
// search box: type part of a name to narrow it (every word must match), then
// click or press Enter. The real <select> stays in the form, hidden, and is
// what gets submitted; picking an option sets it and fires its "change", so
// code listening to the select (auto-submitting filters) keeps working.
// Option groups (e.g. regions) stay as headings, and a group's name matches
// its options, so typing a region shows its organizations.
(function () {
  function words(text) {
    return String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function enhance(select) {
    if (select.dataset.searchableReady) return;
    select.dataset.searchableReady = '1';

    const wrap = document.createElement('div');
    wrap.className = 'relative';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.hidden = true;
    select.tabIndex = -1;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'form-input flex w-full items-center justify-between gap-2 text-left';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    // The <label for> pointed at the select; point it at the button instead.
    if (select.id) {
      const label = document.querySelector(`label[for="${select.id}"]`);
      button.id = `${select.id}-button`;
      if (label) label.setAttribute('for', button.id);
    }
    const shown = document.createElement('span');
    shown.className = 'truncate';
    button.appendChild(shown);
    button.insertAdjacentHTML('beforeend', '<svg class="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>');
    wrap.appendChild(button);

    const panel = document.createElement('div');
    panel.className = 'absolute left-0 right-0 z-30 mt-1 hidden min-w-[16rem] rounded-md border border-slate-200 bg-white shadow-lg';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = select.dataset.searchPlaceholder || 'Search…';
    search.className = 'form-input m-2 w-[calc(100%-1rem)]';
    search.setAttribute('aria-label', search.placeholder);
    const list = document.createElement('ul');
    list.className = 'max-h-72 overflow-y-auto py-1 text-sm';
    list.setAttribute('role', 'listbox');
    const empty = document.createElement('p');
    empty.className = 'hidden px-3 py-2 text-sm text-slate-500';
    empty.textContent = 'No matches';
    panel.append(search, list, empty);
    wrap.appendChild(panel);

    // One entry per option, with its group's name for matching.
    const items = [];
    Array.from(select.children).forEach((child) => {
      const group = child.tagName === 'OPTGROUP' ? child : null;
      let heading = null;
      if (group) {
        heading = document.createElement('li');
        heading.className = 'px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400';
        heading.textContent = group.label;
        list.appendChild(heading);
      }
      (group ? Array.from(group.children) : [child]).forEach((option) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.className = `cursor-pointer px-3 py-1.5 text-slate-700 ${group ? 'pl-5' : ''}`;
        li.textContent = option.textContent;
        list.appendChild(li);
        items.push({ option, li, heading, text: `${option.textContent} ${group ? group.label : ''}`.toLowerCase() });
      });
    });

    let active = -1;
    const visible = () => items.filter((i) => !i.li.hidden);
    function highlight(index) {
      const v = visible();
      items.forEach((i) => i.li.classList.remove('bg-indigo-50', 'text-indigo-700'));
      active = v.length ? Math.max(0, Math.min(index, v.length - 1)) : -1;
      if (active >= 0) {
        v[active].li.classList.add('bg-indigo-50', 'text-indigo-700');
        v[active].li.scrollIntoView({ block: 'nearest' });
      }
    }
    function filter() {
      const q = words(search.value);
      items.forEach((i) => { i.li.hidden = !q.every((w) => i.text.includes(w)); });
      list.querySelectorAll('li:not([role])').forEach((h) => {
        h.hidden = !items.some((i) => i.heading === h && !i.li.hidden);
      });
      empty.classList.toggle('hidden', visible().length > 0);
      const current = visible().findIndex((i) => i.option.selected);
      highlight(current >= 0 && !q.length ? current : 0);
    }
    function sync() {
      const opt = select.options[select.selectedIndex];
      shown.textContent = opt ? opt.textContent : '';
      items.forEach((i) => i.li.setAttribute('aria-selected', String(i.option.selected)));
    }
    function open() {
      panel.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
      search.value = '';
      filter();
      search.focus();
    }
    function close(focusButton) {
      panel.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
      if (focusButton) button.focus();
    }
    function choose(item) {
      close(true);
      if (!item || item.option.selected) return;
      select.value = item.option.value;
      sync();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    button.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close(true)));
    search.addEventListener('input', filter);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(visible()[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
    list.addEventListener('click', (e) => choose(items.find((i) => i.li === e.target.closest('li[role="option"]'))));
    list.addEventListener('mousemove', (e) => {
      const index = visible().findIndex((i) => i.li === e.target.closest('li[role="option"]'));
      if (index >= 0 && index !== active) highlight(index);
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(false); });
    select.addEventListener('change', sync);
    sync();
  }

  function init(root) {
    (root || document).querySelectorAll('select[data-searchable]').forEach(enhance);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
  window.initSearchableSelects = init;
}());
