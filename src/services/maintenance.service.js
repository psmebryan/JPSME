// Maintenance mode: the public site shows a "down for maintenance" page (with a
// countdown when an end time is set) while the main admin keeps working.
//
// Stored as one site setting (JSON). Read on every request, so it is cached in
// memory for a few seconds; turning it on or off from Settings clears the
// cache at once in this process, and other processes catch up within
// CACHE_MS.
//
// MAINTENANCE_MODE=on in the environment forces it on without the database,
// for the case where the database is what is being worked on. An optional
// MAINTENANCE_UNTIL (an ISO date-time) gives that a countdown too.

const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

const KEY = 'maintenance';
const CACHE_MS = 5000;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_MESSAGE = 300;

let cached = null;
let cachedAt = 0;

const OFF = Object.freeze({ on: false, until: null, message: '', startedAt: null, fromEnv: false });

function fromEnv() {
  const flag = String(process.env.MAINTENANCE_MODE || '').trim().toLowerCase();
  if (!['on', 'true', '1', 'yes'].includes(flag)) return null;
  const until = new Date(process.env.MAINTENANCE_UNTIL || '');
  return {
    on: true,
    until: Number.isNaN(until.getTime()) ? null : until.toISOString(),
    message: String(process.env.MAINTENANCE_MESSAGE || '').slice(0, MAX_MESSAGE),
    startedAt: null,
    fromEnv: true,
  };
}

function parse(value) {
  try {
    const v = JSON.parse(value);
    return {
      on: v.on === true,
      until: v.until && !Number.isNaN(new Date(v.until).getTime()) ? new Date(v.until).toISOString() : null,
      message: typeof v.message === 'string' ? v.message.slice(0, MAX_MESSAGE) : '',
      startedAt: v.startedAt || null,
      fromEnv: false,
    };
  } catch (err) {
    return { ...OFF };
  }
}

// The current state. Never throws: if the database cannot be read, the site
// stays open (unless the environment says otherwise), because a settings
// lookup failing is not a reason to close the whole site.
async function getState() {
  const env = fromEnv();
  if (env) return env;
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
    cached = row ? parse(row.value) : { ...OFF };
  } catch (err) {
    cached = cached || { ...OFF };
  }
  cachedAt = Date.now();
  return cached;
}

// Turns maintenance on or off. durationMinutes (optional) sets the countdown;
// leave it empty for no countdown.
async function setState({ on, durationMinutes, message }) {
  if (fromEnv()) throw new AppError('Maintenance is switched on by the server (MAINTENANCE_MODE). Change it there.', 409);
  const turnOn = on === true || on === 'true';
  let until = null;
  if (turnOn && durationMinutes !== undefined && durationMinutes !== null && durationMinutes !== '') {
    const m = Number(durationMinutes);
    if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) {
      throw new AppError(`Enter a duration from 1 minute to ${MAX_MINUTES / 1440} days, or leave it empty.`, 422);
    }
    until = new Date(Date.now() + Math.round(m) * 60000).toISOString();
  }
  const text = String(message || '').trim();
  if (text.length > MAX_MESSAGE) throw new AppError(`Keep the message under ${MAX_MESSAGE} characters.`, 422);
  const previous = await getState();
  const state = {
    on: turnOn,
    until: turnOn ? until : null,
    message: turnOn ? text : '',
    startedAt: turnOn ? (previous.on && previous.startedAt ? previous.startedAt : new Date().toISOString()) : null,
  };
  await prisma.siteSetting.upsert({
    where: { key: KEY },
    update: { value: JSON.stringify(state) },
    create: { key: KEY, value: JSON.stringify(state) },
  });
  cached = { ...state, fromEnv: false };
  cachedAt = Date.now();
  return cached;
}

function clearCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getState, setState, clearCache, MAX_MINUTES, MAX_MESSAGE };
