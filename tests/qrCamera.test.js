// Tests for reading a ticket with the device camera.
//
// Why this exists: the doors were built for a scanner gun, and there was no way
// to try them without one — "i cant scan it cause it need to be scan by the
// scanner qr can we add a option for camera??".
//
// Two things drive the design, and both are covered here.
//
// A gun fires once per trigger pull; a camera reads the same code every single
// frame. At a room door that is not merely noisy — the door toggles, so the
// second read of the same ticket checks the person straight back OUT. Hence the
// cooldown.
//
// And the browser's own decoder is not everywhere. Chrome on WINDOWS has no
// BarcodeDetector (it is Android/macOS/ChromeOS only), which is how the first
// version came to explain itself politely and never ask for a camera at all.
// Hence the vendored jsQR fallback, and hence permission being requested first.
//
// Runs the real public/js/qr-camera.js against a stub DOM, so what is checked
// is the file that ships.

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${String(err.message).split('\n').join('\n      ')}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'qr-camera.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// --- a DOM, in as few lines as the file actually touches ---------------------

function classListFor(el) {
  const parts = () => String(el.className || '').split(/\s+/).filter(Boolean);
  const list = {
    add(c) { const s = new Set(parts()); s.add(c); el.className = [...s].join(' '); },
    remove(c) { const s = new Set(parts()); s.delete(c); el.className = [...s].join(' '); },
    contains(c) { return parts().includes(c); },
    toggle(c, force) { return (force === undefined ? !list.contains(c) : force) ? (list.add(c), true) : (list.remove(c), false); },
  };
  return list;
}

function makeEl(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    srcObject: null,
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    fire(type) { (el.listeners[type] || []).forEach((fn) => fn()); },
    focus() { el.focused = true; },
    play: async () => {},
    querySelector: () => null,
  };
  el.classList = classListFor(el);
  return el;
}

// `plan` decides what the environment can do and what the lens sees.
function runPage(plan = {}) {
  const {
    secure = true,
    hasMediaDevices = true,
    hasDetector = true,          // BarcodeDetector present (Android/macOS)
    formats = ['qr_code'],
    permission = 'prompt',       // what navigator.permissions reports, or null
    getUserMediaError = null,    // fails every attempt
    gumOutcomes = null,          // per-attempt: an Error, or null to succeed
    devices = [{ kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam' }],
    jsqrLoads = true,            // whether /js/vendor/jsqr.js comes back
    reads = [],                  // one entry per DECODE: a code, or '' for none
    decodeThrowsAt = -1,
    twoForms = false,
  } = plan;

  // The form the button lives in, plus (optionally) an unrelated earlier form
  // on the same page, to prove the camera does not fill in somebody else's box.
  const input = makeEl('input');
  const form = makeEl('form');
  form.querySelector = (sel) => (sel === '[data-scan-input]' ? input : null);
  const submits = [];
  form.requestSubmit = () => submits.push(input.value);
  let insertedAfterForm = null;
  form.insertAdjacentElement = (where, node) => { insertedAfterForm = { where, node }; };

  const decoyInput = makeEl('input');
  const decoyForm = makeEl('form');
  decoyForm.querySelector = (sel) => (sel === '[data-scan-input]' ? decoyInput : null);

  const button = makeEl('button');
  button.textContent = 'Use camera';
  button.closest = (sel) => (sel === '[data-scan-form]' ? form : null);

  // The panel the file builds for itself. innerHTML is a string it never reads
  // back, so the stub just answers the four selectors it looks up afterwards.
  const video = makeEl('video');
  video.videoWidth = 1280;
  video.videoHeight = 720;
  const status = makeEl('p');
  const hint = makeEl('p');
  const close = makeEl('button');
  // Both start hidden in the markup the file builds, so the stubs must too —
  // otherwise a test can "pass" on an element that was never actually hidden.
  const recover = makeEl('div');
  recover.className = 'hidden';
  const devicePicker = makeEl('select');
  devicePicker.className = 'hidden';
  const retry = makeEl('button');
  const panel = makeEl('div');
  panel.querySelector = (sel) => ({
    '[data-qr-video]': video,
    '[data-qr-status]': status,
    '[data-qr-hint]': hint,
    '[data-qr-close]': close,
    '[data-qr-recover]': recover,
    '[data-qr-device]': devicePicker,
    '[data-qr-retry]': retry,
  }[sel] || null);

  // getSettings is how the file learns which camera it actually got, so the
  // stub has to answer it or the remembered-camera path cannot be tested.
  const track = (id) => ({ stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ deviceId: id }) });
  const tracks = [track('cam-used'), track('cam-used')];
  const gumCalls = [];
  const permissionQueries = [];
  const store = Object.assign({}, plan.storage || {});
  const scriptsAdded = [];
  const drawnSizes = [];

  // Both decoders read from one list, so a test says what the lens sees without
  // caring which decoder happens to be in play.
  let decodeCalls = 0;
  function nextRead() {
    const i = decodeCalls;
    decodeCalls += 1;
    if (i === decodeThrowsAt) throw new Error('one bad frame');
    return reads[i] || '';
  }

  function Detector() {
    return {
      detect: async () => {
        const value = nextRead();
        return value ? [{ rawValue: value }] : [];
      },
    };
  }
  Detector.getSupportedFormats = async () => formats;

  const canvas = makeEl('canvas');
  canvas.getContext = () => ({
    drawImage: (src, x, y, w, h) => { drawnSizes.push(`${w}x${h}`); },
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  });

  const frames = [];
  const docListeners = {};
  const winListeners = {};
  let nowMs = 1000;

  const sandbox = {
    document: {
      hidden: false,
      head: {
        appendChild: (el) => {
          scriptsAdded.push(el.src);
          // The browser fetches asynchronously; so does this.
          setImmediate(() => {
            if (!jsqrLoads) { el.onerror(); return; }
            sandbox.window.jsQR = (data, w, h) => {
              const value = nextRead();
              return value ? { data: value } : null;
            };
            el.onload();
          });
        },
      },
      createElement: (tag) => (tag === 'script' ? makeEl('script') : (tag === 'canvas' ? canvas : panel)),
      querySelectorAll: (sel) => (sel === '[data-qr-camera]' ? [button] : []),
      querySelector: (sel) => (sel === '[data-scan-form]' && twoForms ? decoyForm : null),
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    },
    window: {
      isSecureContext: secure,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
      addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
      BarcodeDetector: hasDetector ? Detector : undefined,
    },
    navigator: {
      mediaDevices: hasMediaDevices ? {
        getUserMedia: async (constraints) => {
          const attempt = gumCalls.length;
          gumCalls.push(constraints);
          const outcome = getUserMediaError || (gumOutcomes ? gumOutcomes[attempt] : null);
          if (outcome) throw outcome;
          return { getTracks: () => tracks };
        },
        enumerateDevices: async () => devices,
      } : undefined,
      permissions: permission === null ? undefined : {
        query: async (q) => { permissionQueries.push(q); return { state: permission }; },
      },
    },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    Date: { now: () => nowMs },
  };

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, SOURCE)(...keys.map((k) => sandbox[k]));
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());

  return {
    button, panel, video, status, hint, input, decoyInput, recover, devicePicker,
    submits, tracks, gumCalls, permissionQueries, scriptsAdded, drawnSizes,
    clickRetry: () => retry.fire('click'),
    pickDevice: (id) => { devicePicker.value = id; devicePicker.fire('change'); },
    get decodeCalls() { return decodeCalls; },
    get insertedAfterForm() { return insertedAfterForm; },
    get stored() { return store; },
    advance: (ms) => { nowMs += ms; },
    click: () => button.fire('click'),
    clickClose: () => close.fire('click'),
    hideTab: () => {
      sandbox.document.hidden = true;
      (docListeners.visibilitychange || []).forEach((fn) => fn());
    },
    // One animation frame, then let the awaited decode settle.
    async frame() {
      const fn = frames.shift();
      if (!fn) throw new Error('no frame was queued — the loop had stopped');
      fn();
      await flush();
      await flush();
    },
    get queued() { return frames.length; },
  };
}

// Opening now involves a permission check and possibly a script fetch, so give
// the microtasks room to settle before a test looks at the result.
async function open(plan) {
  const page = runPage(plan);
  page.click();
  for (let i = 0; i < 8; i += 1) await flush();
  return page;
}

// --- the tests --------------------------------------------------------------

async function main() {
  // --- the vendored decoder is real, and reads OUR tickets -------------------

  await test('the vendored decoder reads a genuine ticket payload', async () => {
    // The strongest check available offline: encode exactly what the app puts
    // on a ticket, then decode it with the copy that ships to the browser. A
    // stub cannot tell us the library works; this can.
    const QRCode = require('qrcode');
    const jsQR = require(path.join(ROOT, 'public', 'js', 'vendor', 'jsqr.js'));
    const crypto = require('crypto');

    const payload = `PSME-EVENT:${crypto.randomBytes(32).toString('hex')}`;
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const bits = qr.modules.data;

    const SCALE = 4;
    const QUIET = 4 * SCALE;
    const w = size * SCALE + QUIET * 2;
    const rgba = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!bits[y * size + x]) continue;
        for (let dy = 0; dy < SCALE; dy += 1) {
          for (let dx = 0; dx < SCALE; dx += 1) {
            const i = ((QUIET + y * SCALE + dy) * w + (QUIET + x * SCALE + dx)) * 4;
            rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0;
          }
        }
      }
    }

    const found = jsQR(rgba, w, w);
    assert(found, 'the decoder found a code at all');
    assertEqual(found.data, payload, 'and read it back exactly');
  });

  await test('the vendored decoder is present, with its licence beside it', async () => {
    const lib = path.join(ROOT, 'public', 'js', 'vendor', 'jsqr.js');
    const licence = path.join(ROOT, 'public', 'js', 'vendor', 'jsqr.LICENSE.txt');
    assert(fs.existsSync(lib), 'jsqr.js is vendored');
    assert(fs.existsSync(licence), 'its Apache-2.0 licence ships with it');
    assert(fs.statSync(lib).size > 100000, 'and it is the real library, not a stub');
  });

  // --- the ordinary path -----------------------------------------------------

  await test('a code in front of the lens goes into the scan box and is submitted', async () => {
    const page = await open({ reads: ['TICKET-AAA'] });
    await page.frame();
    assertEqual(page.input.value, 'TICKET-AAA', 'the decoded value lands in the scan input');
    assertEqual(page.submits.length, 1, 'and the form is submitted once');
  });

  await test('the same code held up for many frames is submitted only once', async () => {
    // The failure this prevents: a room door toggles, so a second submit of the
    // same ticket checks that person straight back out of the hall.
    const page = await open({ reads: Array(30).fill('TICKET-AAA') });
    for (let i = 0; i < 30; i += 1) await page.frame();
    assertEqual(page.submits.length, 1, 'thirty frames of one code is one scan');
  });

  await test('the same code again after the cooldown counts as a new scan', async () => {
    // Somebody really does leave a hall and come back, and that must work.
    const page = await open({ reads: ['TICKET-AAA', 'TICKET-AAA'] });
    await page.frame();
    page.advance(3100);
    await page.frame();
    assertEqual(page.submits.length, 2, 'a genuine second visit is not swallowed');
  });

  await test('a different code is never swallowed, however fast it follows', async () => {
    // Two people back to back at a moving queue. Holding the second one for
    // three seconds because the first was just read would be its own bug.
    const page = await open({ reads: ['TICKET-AAA', 'TICKET-BBB'] });
    await page.frame();
    await page.frame();
    assertEqual(page.submits.length, 2, 'both tickets go through');
    assertEqual(page.input.value, 'TICKET-BBB', 'the second value is the one left in the box');
  });

  await test('an empty frame is not a submit', async () => {
    const page = await open({ reads: ['', '', 'TICKET-AAA'] });
    await page.frame();
    await page.frame();
    assertEqual(page.submits.length, 0, 'nothing in view, nothing sent');
    await page.frame();
    assertEqual(page.submits.length, 1, 'and then the real one');
  });

  await test('the camera keeps looking after a scan, instead of closing itself', async () => {
    // A door has a queue. Reopening the camera per person would be worse than
    // the gun this replaces.
    const page = await open({ reads: ['TICKET-AAA'] });
    await page.frame();
    assert(page.queued > 0, 'another frame is still scheduled');
    assert(!page.panel.classList.contains('hidden'), 'and the panel is still open');
  });

  await test('a decode that throws does not kill the loop', async () => {
    const page = await open({ reads: ['', 'TICKET-AAA'], decodeThrowsAt: 0 });
    await page.frame();
    assertEqual(page.submits.length, 0, 'the bad frame sent nothing');
    await page.frame();
    assertEqual(page.submits.length, 1, 'and the next frame still works');
  });

  // --- permission, asked for first ------------------------------------------

  await test('the camera is requested before any decoder work', async () => {
    // The point of the rewrite: the prompt is what the operator is waiting on.
    const page = await open({ reads: [] });
    assertEqual(page.gumCalls.length, 1, 'the camera was requested');
    assert(/permission/i.test(page.status.textContent) || /looking/i.test(page.status.textContent),
      `the panel said what it was doing, got: ${page.status.textContent}`);
  });

  await test('it asks for the back camera', async () => {
    const page = await open({ reads: [] });
    const { video } = page.gumCalls[0];
    assert(JSON.stringify(video).includes('environment'), `the rear lens, got ${JSON.stringify(video)}`);
  });

  await test('a permission already blocked is named, without a pointless prompt', async () => {
    // Once refused, the browser never asks again and getUserMedia fails
    // instantly — which reads as "the camera is broken" unless it is spelled
    // out. This is the most likely reason a second attempt still fails.
    const page = await open({ permission: 'denied' });
    assert(/blocked/i.test(page.status.textContent), `says it is blocked, got: ${page.status.textContent}`);
    assert(/address bar/i.test(page.status.textContent), `and where to unblock it, got: ${page.status.textContent}`);
    assertEqual(page.gumCalls.length, 0, 'and does not ask for something it cannot get');
  });

  await test('a refusal at the prompt gets the same unblocking instructions', async () => {
    const err = new Error('denied');
    err.name = 'NotAllowedError';
    const page = await open({ getUserMediaError: err });
    assert(/address bar/i.test(page.status.textContent), `got: ${page.status.textContent}`);
  });

  await test('a browser with no permissions API still gets asked', async () => {
    // Firefox throws on querying the camera permission. Not knowing must not
    // stop the attempt.
    const page = await open({ permission: null, reads: ['TICKET-AAA'] });
    assertEqual(page.gumCalls.length, 1, 'the camera was still requested');
    await page.frame();
    assertEqual(page.submits.length, 1, 'and it works');
  });

  await test('a device with no camera is told apart from a refusal', async () => {
    const err = new Error('none');
    err.name = 'NotFoundError';
    const page = await open({ getUserMediaError: err });
    assert(/no camera/i.test(page.status.textContent), `got: ${page.status.textContent}`);
  });

  await test('a camera another program is holding says so, in those words', async () => {
    // The reported failure: "The camera could not start (NotReadableError)."
    // That is the API's word for "permission was fine, the hardware said no",
    // and on Windows it nearly always means Zoom, Teams or the Camera app has
    // the webcam. The old message named the exception, which sends people to
    // the browser's permission settings, where there is nothing to fix.
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({ getUserMediaError: err });

    assert(/used by something else/i.test(page.status.textContent), `names the cause, got: ${page.status.textContent}`);
    assert(/Zoom|Teams|Camera app/.test(page.status.textContent), `and what to close, got: ${page.status.textContent}`);
    assert(!/NotReadableError/.test(page.status.textContent), 'without making them read an exception name');
  });

  await test('a rear-lens request that fails falls back to whatever camera exists', async () => {
    // A laptop has no environment-facing camera, and some drivers answer that
    // request with a device that then refuses to start. A plain request works.
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({ gumOutcomes: [err], reads: ['TICKET-AAA'] });

    assertEqual(page.gumCalls.length, 2, 'it tried twice');
    assert(JSON.stringify(page.gumCalls[0].video).includes('environment'), 'the rear lens first');
    assertEqual(page.gumCalls[1].video, true, 'then plain video');
    await page.frame();
    assertEqual(page.submits.length, 1, 'and it scans');
  });

  await test('a definitive refusal is not retried with other constraints', async () => {
    // Asking again in a different way cannot un-block a permission, and the
    // second prompt would be pure noise.
    const err = new Error('denied');
    err.name = 'NotAllowedError';
    const page = await open({ getUserMediaError: err, permission: 'prompt' });
    assertEqual(page.gumCalls.length, 1, 'asked once, stopped');
  });

  await test('Try again retries in place, without a reload', async () => {
    // The fix is usually "close the other program", and a reload would lose the
    // station name and whatever is already in the scan box.
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({ getUserMediaError: err });
    assert(!page.recover.classList.contains('hidden'), 'a way out is offered');

    const before = page.gumCalls.length;
    page.clickRetry();
    for (let i = 0; i < 6; i += 1) await flush();
    assert(page.gumCalls.length > before, 'it tried the camera again');
  });

  await test('an idle OBS virtual camera does not stop the real one being used', async () => {
    // The reported case, exactly: the browser opened OBS Virtual Camera rather
    // than the laptop webcam. OBS sits in the device list permanently and hands
    // over no frames unless OBS itself is running, so it fails NotReadableError
    // and looks for all the world like a broken camera.
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({
      // The browser's own choices fail — that is OBS being picked for us.
      gumOutcomes: [err, err],
      devices: [
        { kind: 'videoinput', deviceId: 'obs-1', label: 'OBS Virtual Camera' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam' },
      ],
      reads: ['TICKET-AAA'],
    });

    const named = page.gumCalls.filter((c) => c.video && c.video.deviceId);
    assert(named.length > 0, 'it went on to name cameras itself');
    assertEqual(named[0].video.deviceId.exact, 'cam-1', 'trying the real camera before the virtual one');
    await page.frame();
    assertEqual(page.submits.length, 1, 'and it scans');
  });

  await test('a virtual camera is still offered, just not preferred', async () => {
    // Somebody may genuinely want to scan through OBS. Ranking it last is not
    // the same as refusing it.
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({
      getUserMediaError: err,
      devices: [
        { kind: 'videoinput', deviceId: 'obs-1', label: 'OBS Virtual Camera' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam' },
      ],
    });
    const options = page.devicePicker.innerHTML;
    assert(/OBS Virtual Camera/.test(options), 'it is in the list');
    assert(options.indexOf('Integrated Webcam') < options.indexOf('OBS Virtual Camera'), 'below the real camera');
  });

  await test('the camera that worked is remembered for next time', async () => {
    const page = await open({ reads: [] });
    assertEqual(page.stored['jpsme.qr.camera'], 'cam-used', 'the working device was stored');
  });

  await test('a remembered camera is tried first, and is not a dead end if it is gone', async () => {
    // An unplugged USB camera raises OverconstrainedError. Treating that as
    // final would leave the operator stuck with a camera that no longer exists.
    const gone = new Error('no such device');
    gone.name = 'OverconstrainedError';
    const page = await open({ storage: { 'jpsme.qr.camera': 'old-cam' }, gumOutcomes: [gone], reads: ['TICKET-AAA'] });

    assertEqual(page.gumCalls[0].video.deviceId.exact, 'old-cam', 'the remembered one first');
    assert(page.gumCalls.length > 1, 'and it kept going when that failed');
    await page.frame();
    assertEqual(page.submits.length, 1, 'landing on a camera that works');
  });

  await test('a camera chosen by hand is not silently swapped for another', async () => {
    // If they pick "Integrated Webcam" and it fails, opening OBS instead would
    // be worse than saying so.
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({
      getUserMediaError: err,
      devices: [
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam' },
        { kind: 'videoinput', deviceId: 'obs-1', label: 'OBS Virtual Camera' },
      ],
    });
    const before = page.gumCalls.length;
    page.pickDevice('cam-1');
    for (let i = 0; i < 8; i += 1) await flush();

    const after = page.gumCalls.slice(before);
    assert(after.length > 0, 'it tried');
    assert(after.every((c) => c.video && c.video.deviceId && c.video.deviceId.exact === 'cam-1'),
      `only the chosen camera, got ${JSON.stringify(after)}`);
  });

  await test('a blocked permission is not offered a pointless Try again', async () => {
    // It would fail identically every time and make the page look broken.
    const page = await open({ permission: 'denied' });
    assert(page.recover.classList.contains('hidden'), 'no retry row');
  });

  await test('a machine with two cameras gets to choose between them', async () => {
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({
      getUserMediaError: err,
      devices: [
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam' },
        { kind: 'videoinput', deviceId: 'cam-2', label: 'USB Camera' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone' },
      ],
    });
    assert(!page.devicePicker.classList.contains('hidden'), 'the picker is shown');
    assert(/USB Camera/.test(page.devicePicker.innerHTML), 'listing the cameras by name');
    assert(!/Microphone/.test(page.devicePicker.innerHTML), 'and nothing that is not a camera');
  });

  await test('one camera means no picker to choose from', async () => {
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({ getUserMediaError: err });
    assert(page.devicePicker.classList.contains('hidden'), 'a choice of one is not a choice');
  });

  await test('choosing a camera asks for that exact device', async () => {
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const page = await open({
      getUserMediaError: err,
      devices: [
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam' },
        { kind: 'videoinput', deviceId: 'cam-2', label: 'USB Camera' },
      ],
    });
    page.pickDevice('cam-2');
    for (let i = 0; i < 6; i += 1) await flush();

    const last = page.gumCalls[page.gumCalls.length - 1];
    assertEqual(last.video.deviceId.exact, 'cam-2', 'the chosen one, exactly');
  });

  await test('an insecure page explains that, rather than failing silently', async () => {
    // The exact trap when testing from a phone: http://192.168.x.x gives no
    // camera, with no error anyone would connect to the cause.
    const page = await open({ secure: false });
    assert(/https/i.test(page.status.textContent), `points at https, got: ${page.status.textContent}`);
    assertEqual(page.gumCalls.length, 0, 'nothing was attempted');
  });

  await test('a browser with no getUserMedia at all says so', async () => {
    const page = await open({ hasMediaDevices: false });
    assert(/will not give/i.test(page.status.textContent), `got: ${page.status.textContent}`);
  });

  // --- the decoder fallback, which is why Windows works now ------------------

  await test('a browser without BarcodeDetector still scans, via the vendored decoder', async () => {
    // Chrome on Windows. This is the whole bug: the first version stopped here
    // and never opened the camera.
    const page = await open({ hasDetector: false, reads: ['TICKET-AAA'] });
    assertEqual(page.gumCalls.length, 1, 'the camera was opened anyway');
    await page.frame();
    assertEqual(page.input.value, 'TICKET-AAA', 'and a code was read');
    assertEqual(page.submits.length, 1, 'and submitted');
  });

  await test('the fallback decoder is fetched from our own origin', async () => {
    // script-src is 'self'. A CDN copy would be blocked with no visible error.
    const page = await open({ hasDetector: false, reads: [] });
    assertEqual(page.scriptsAdded.length, 1, 'one script was added');
    assertEqual(page.scriptsAdded[0], '/js/vendor/jsqr.js', 'same-origin, root-relative');
  });

  await test('the fallback is not downloaded when the browser has its own decoder', async () => {
    // 250KB that an Android phone on mobile data should never pay for.
    const page = await open({ hasDetector: true, reads: [] });
    assertEqual(page.scriptsAdded.length, 0, 'nothing was fetched');
  });

  await test('a detector that cannot do QR falls through instead of giving up', async () => {
    const page = await open({ formats: ['ean_13'], reads: ['TICKET-AAA'] });
    assertEqual(page.scriptsAdded.length, 1, 'the vendored decoder was used instead');
    await page.frame();
    assertEqual(page.submits.length, 1, 'and it scans');
  });

  await test('a fallback that will not load releases the camera and says so', async () => {
    // Leaving the lens open behind an error message would be the worst of both.
    const page = await open({ hasDetector: false, jsqrLoads: false });
    assert(/QR reader/i.test(page.status.textContent), `got: ${page.status.textContent}`);
    assert(page.tracks.every((t) => t.stopped), 'the camera was released');
  });

  await test('the fallback decodes a downscaled frame, not the full sensor', async () => {
    // A 1280x720 frame decoded in JavaScript thirty times a second would cook
    // the phone for no gain.
    const page = await open({ hasDetector: false, reads: [''] });
    await page.frame();
    assertEqual(page.drawnSizes[0], '480x270', 'scaled down, aspect kept');
  });

  await test('the fallback is not run more than ten times a second', async () => {
    const page = await open({ hasDetector: false, reads: [] });
    const before = page.decodeCalls;
    await page.frame();
    await page.frame();
    await page.frame();
    assertEqual(page.decodeCalls - before, 1, 'frames inside the interval are skipped');
    page.advance(150);
    await page.frame();
    assertEqual(page.decodeCalls - before, 2, 'and it resumes after it');
  });

  // --- closing down ----------------------------------------------------------

  await test('closing stops every track, so the camera light goes out', async () => {
    const page = await open({ reads: [] });
    page.clickClose();
    await flush();
    assert(page.tracks.every((t) => t.stopped), 'both tracks stopped');
    assert(page.panel.classList.contains('hidden'), 'and the panel is put away');
  });

  await test('a hidden tab stops the camera', async () => {
    const page = await open({ reads: [] });
    page.hideTab();
    await flush();
    assert(page.tracks.every((t) => t.stopped), 'a page nobody is looking at does not keep the lens open');
  });

  await test('the loop stops once the camera is closed', async () => {
    const page = await open({ reads: ['TICKET-AAA', 'TICKET-BBB'] });
    page.clickClose();
    await flush();
    await page.frame();
    assertEqual(page.submits.length, 0, 'a frame that arrives after closing does nothing');
  });

  await test('the button toggles, so one control both opens and closes', async () => {
    const page = await open({ reads: [] });
    assertEqual(page.button.textContent, 'Close camera', 'open state');
    page.click();
    await flush();
    assertEqual(page.button.textContent, 'Use camera', 'and back again');
    assert(page.tracks.every((t) => t.stopped), 'closing by the same button also releases the lens');
  });

  await test('the button also dismisses an error panel', async () => {
    const page = await open({ secure: false });
    page.click();
    await flush();
    assert(page.panel.classList.contains('hidden'), 'the message can be put away');
  });

  // --- wiring ----------------------------------------------------------------

  await test('it fills in its own form, not the first one on the page', async () => {
    // The room screens carry other forms. A camera that types into the wrong
    // box would be a silent, baffling bug.
    const page = await open({ reads: ['TICKET-AAA'], twoForms: true });
    await page.frame();
    assertEqual(page.input.value, 'TICKET-AAA', "the scan box in the button's own form");
    assertEqual(page.decoyInput.value, '', 'and nothing in the unrelated one');
  });

  await test('the panel is placed directly under the scan form', async () => {
    const page = await open({ reads: [] });
    assert(page.insertedAfterForm, 'the panel was inserted');
    assertEqual(page.insertedAfterForm.where, 'afterend', 'right below the input it feeds');
  });

  await test('nothing is loaded from off-origin, because the CSP forbids it', async () => {
    assert(!/cdnjs|jsdelivr|unpkg|https?:\/\/[a-z]/i.test(SOURCE.replace(/^\s*\/\/.*$/gm, '')),
      'no off-origin URL outside the comments');
    const src = (SOURCE.match(/JSQR_SRC\s*=\s*'([^']+)'/) || [])[1];
    assertEqual(src, '/js/vendor/jsqr.js', 'the only script it loads is our own copy');
  });

  await test('every scanner page offers the camera and loads the file', async () => {
    // Two stations now: the desk and the hall door. There was a third, a venue
    // entrance, and it was removed as a scan that answered nothing the hall
    // door had not already answered. Both remaining ones are unusable without a
    // gun until they carry this.
    ['room-scan', 'event-desk'].forEach((name) => {
      const view = fs.readFileSync(path.join(ROOT, 'views', 'admin', `${name}.ejs`), 'utf8');
      assert(/data-qr-camera/.test(view), `${name}.ejs has the button`);
      assert(/\/js\/qr-camera\.js/.test(view), `${name}.ejs loads the script`);
      assert(/data-scan-input/.test(view), `${name}.ejs has a scan input to fill`);
    });
  });

  await test('the typed box survives, so a scanner gun still works everywhere', async () => {
    // The camera is an option, never a replacement: a gun is faster at a busy
    // door, and some machine somewhere will always refuse the lens.
    ['room-scan', 'event-desk'].forEach((name) => {
      const view = fs.readFileSync(path.join(ROOT, 'views', 'admin', `${name}.ejs`), 'utf8');
      assert(/type="submit"/.test(view), `${name}.ejs keeps its submit button`);
    });
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
