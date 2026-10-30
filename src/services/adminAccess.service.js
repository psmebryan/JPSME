const settingsService = require('./settings.service');
const { MODULES, KEYS, DEFAULT_PRESIDENT_MODULES, modulesForPath } = require('../config/adminModules');

// What each kind of admin may open. See config/adminModules for the modules
// and the paths in each.
//
//   ADMIN       everything
//   PRESIDENT   the modules ticked in Site Settings -> National President
//               access (stored as the setting below), nothing else
//   others      handled by the existing chapter-admin and member rules

const SETTING_KEY = 'presidentModules';

async function getPresidentModules() {
  const raw = await settingsService.getSetting(SETTING_KEY, null);
  if (raw === null || raw === undefined) return [...DEFAULT_PRESIDENT_MODULES];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((k) => KEYS.includes(k)) : [...DEFAULT_PRESIDENT_MODULES];
  } catch (err) {
    return [...DEFAULT_PRESIDENT_MODULES];
  }
}

// Unknown keys are dropped, so only real modules can ever be granted.
async function setPresidentModules(keys) {
  const list = Array.from(new Set((Array.isArray(keys) ? keys : []).map(String))).filter((k) => KEYS.includes(k));
  await settingsService.setSetting(SETTING_KEY, JSON.stringify(list));
  return list;
}

// The module keys this signed-in person may open.
async function modulesFor(user) {
  if (!user) return [];
  if (user.role === 'ADMIN') return [...KEYS];
  if (user.role === 'PRESIDENT') return getPresidentModules();
  return [];
}

// Whether a President may open this path: it must belong to a module they
// have. A path in no module is refused.
async function presidentCanOpen(path) {
  const needs = modulesForPath(path);
  if (!needs) return false;
  const granted = await getPresidentModules();
  return needs.some((k) => granted.includes(k));
}

// ADMIN, or a PRESIDENT: someone who acts with national (not chapter) reach
// inside whatever module they are allowed into.
function isNationalAdmin(user) {
  return Boolean(user && (user.role === 'ADMIN' || user.role === 'PRESIDENT'));
}

module.exports = {
  MODULES,
  getPresidentModules,
  setPresidentModules,
  modulesFor,
  presidentCanOpen,
  isNationalAdmin,
};
