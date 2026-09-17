// Reading a ticket with the device's own camera, for the doors that have no
// scanner gun.
//
// Order of operations matters here, and it is not the obvious one: ask for the
// camera FIRST, then work out how to decode. The first version checked for a
// decoder up front and refused before ever prompting, which on Windows meant
// the button explained itself and never asked for anything — indistinguishable,
// from the operator's side, from a camera that simply does not work.
//
// Two decoders, in order of preference:
//
//   BarcodeDetector  the browser's own, hardware-backed, nothing to download.
//                    Android, macOS and ChromeOS have it. Chrome on WINDOWS
//                    and Linux does not, and neither does Safari or Firefox —
//                    so this cannot be the only path, which was the earlier bug.
//   jsQR             vendored at /js/vendor/jsqr.js, fetched only when the
//                    native one is missing. script-src is 'self', so a CDN copy
//                    would be blocked with no visible error; it has to be ours.
//
// Self-wiring: any page with a [data-qr-camera] button inside a [data-scan-form]
// containing a [data-scan-input] gets this. The three door screens each add one
// button; nothing else on them changes, and the typed field still works.

(function () {
  // One code sits in front of the lens for a second or more and is read every
  // frame. Without this the same ticket would be submitted thirty times, and at
  // a room door every other one of those is a check-OUT.
  const SAME_CODE_COOLDOWN_MS = 3000;

  const JSQR_SRC = '/js/vendor/jsqr.js';

  // jsQR is pure JavaScript over the raw pixels, so unlike the native decoder
  // it costs real CPU. Ten looks a second is far more than a hand holding a
  // ticket needs, and leaves the phone cool and the video smooth.
  const DECODE_INTERVAL_MS = 100;

  // Decoding a 1080p frame is mostly wasted work; a QR fills a good part of the
  // frame by the time anyone is holding it up to be read.
  const DECODE_WIDTH = 480;

  const MESSAGES = {
    insecure: 'The camera needs a secure page. localhost works, or any https:// address — a phone opening this by its 192.168.x.x address will never get a camera.',
    noApi: 'This browser will not give the page a camera. Use the box above, or a scanner gun.',
    denied: 'Camera permission is blocked for this site. Click the camera or padlock icon in the address bar, allow it, then reload the page.',
    noDecoder: 'The camera is on, but the QR reader could not be loaded. Use the box above, or a scanner gun.',
    // NotReadableError means permission was given and the hardware still would
    // not hand the camera over. On Windows that is nearly always another
    // program holding it — the OS gives one app the webcam and refuses the
    // rest. Naming the cause is the whole value of this message, because
    // "could not start" sends people to the wrong settings page.
    inUse: 'The camera is being used by something else. Close Zoom, Teams, the Camera app, and any other browser tab using it — then press Try again.',
  };

  // Software cameras that present themselves as ordinary video devices and then
  // hand over no frames unless their app is running. OBS is the one that bit us
  // here: its virtual camera sits in the device list permanently, and picking it
  // fails with NotReadableError, which reads as "your camera is broken".
  //
  // Matching on the label is crude, and it is what there is — nothing in the
  // API says "this device is synthetic". Being wrong is survivable in both
  // directions: a real camera mistaken for a virtual one is merely tried later,
  // and a virtual one mistaken for real is still offered in the picker.
  const VIRTUAL_CAMERA = /\b(obs|virtual|manycam|xsplit|snap ?camera|droidcam|epoccam|iriun|camo|ndi|nvidia broadcast|streamlabs)\b/i;

  function isVirtual(camera) {
    return VIRTUAL_CAMERA.test(camera.label || '');
  }

  // Real cameras first, virtual ones last, order otherwise untouched.
  function realFirst(cameras) {
    return cameras.filter((c) => !isVirtual(c)).concat(cameras.filter(isVirtual));
  }

  async function listCameras() {
    try {
      if (!navigator.mediaDevices.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch (err) {
      return [];
    }
  }

  // Constraints to try, in order. The rear lens first, which is right on a phone
  // or tablet at a door; then a plain request, which is right on a desktop. If
  // both fail, start() falls back to naming real cameras one by one — that is
  // what gets past a virtual camera the browser picked on its own.
  //
  // `exactOnly` is the difference between a camera the operator chose by hand
  // and one we merely remembered. A remembered camera that has been unplugged
  // should quietly fall back to whatever is there; a chosen one should not, or
  // picking "Integrated Webcam" and silently getting OBS is the result.
  function attemptsFor(deviceId, exactOnly) {
    const exact = deviceId ? [{ video: { deviceId: { exact: deviceId } }, audio: false }] : [];
    if (exactOnly && deviceId) return exact;
    return exact.concat([
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false },
    ]);
  }

  // Definitive: retrying these with different constraints cannot help.
  //
  // OverconstrainedError is deliberately NOT here. It means "nothing satisfies
  // exactly these constraints", which is the one failure a looser request does
  // fix — it is what an unplugged remembered camera raises.
  const FINAL_ERRORS = ['NotAllowedError', 'SecurityError', 'NotFoundError'];

  // Which camera worked last time, so an operator who had to pick one does not
  // pick it again every shift. Per browser, and never fatal if storage is off.
  const REMEMBERED = 'jpsme.qr.camera';
  function rememberCamera(id) {
    try { if (id) window.localStorage.setItem(REMEMBERED, id); } catch (err) { /* private mode */ }
  }
  function rememberedCamera() {
    try { return window.localStorage.getItem(REMEMBERED) || ''; } catch (err) { return ''; }
  }

  // --- the decoders ----------------------------------------------------------

  let jsqrPromise = null;

  // Same-origin, so 'self' admits it; injected rather than put in a <script>
  // tag on the page so the 250KB is never fetched on the devices that have a
  // native decoder, and never at all unless somebody opens the camera.
  function loadJsQr() {
    if (jsqrPromise) return jsqrPromise;
    jsqrPromise = new Promise((resolve, reject) => {
      if (typeof window.jsQR === 'function') { resolve(window.jsQR); return; }
      const el = document.createElement('script');
      el.src = JSQR_SRC;
      el.onload = () => (typeof window.jsQR === 'function'
        ? resolve(window.jsQR)
        : reject(new Error('the decoder loaded but registered nothing')));
      el.onerror = () => reject(new Error('the decoder could not be fetched'));
      document.head.appendChild(el);
    });
    return jsqrPromise;
  }

  async function nativeDecoder() {
    if (typeof window.BarcodeDetector !== 'function') return null;
    // getSupportedFormats is the honest test: the constructor exists on some
    // builds that cannot actually do qr_code.
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    return {
      kind: 'native',
      throttle: false,
      read: async (video) => {
        const codes = await detector.detect(video);
        return codes.length ? String(codes[0].rawValue || '').trim() : '';
      },
    };
  }

  async function jsqrDecoder() {
    const jsQR = await loadJsQr();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      kind: 'jsqr',
      throttle: true,
      read: (video) => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        // Zero until the first frame arrives; drawing that is an exception.
        if (!vw || !vh) return '';
        const scale = Math.min(1, DECODE_WIDTH / vw);
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h);
        // dontInvert: our tickets are always dark-on-light, and trying the
        // inverse doubles the work of every frame that finds nothing.
        const found = jsQR(frame.data, w, h, { inversionAttempts: 'dontInvert' });
        return found ? String(found.data || '').trim() : '';
      },
    };
  }

  async function makeDecoder() {
    try {
      const native = await nativeDecoder();
      if (native) return native;
    } catch (err) {
      // A browser that claims BarcodeDetector and then throws is not worth
      // arguing with; jsQR works everywhere.
    }
    return jsqrDecoder();
  }

  // --- permission ------------------------------------------------------------

  function environmentProblem() {
    // getUserMedia exists only in a secure context. Localhost counts; a phone
    // pointed at http://192.168.x.x does NOT, and the failure there is silent
    // and baffling unless it is named.
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'noApi';
    return null;
  }

  // A refusal is remembered: the browser never prompts again, and getUserMedia
  // rejects instantly. Read that up front so the message can say "unblock it"
  // rather than "permission was refused", which is useless once there is no
  // prompt left to answer.
  async function priorPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return null;
      const status = await navigator.permissions.query({ name: 'camera' });
      return (status && status.state) || null;
    } catch (err) {
      // Firefox throws on name:'camera'. Not knowing is fine — asking is next.
      return null;
    }
  }

  // --- the panel -------------------------------------------------------------

  function attach(button) {
    // Scoped to the form the button sits in, not the first one on the page:
    // the room screens carry other forms, and a camera that fills in somebody
    // else's field is worse than no camera.
    const form = button.closest('[data-scan-form]') || document.querySelector('[data-scan-form]');
    const input = form && form.querySelector('[data-scan-input]');
    if (!input || !form) return;

    // Built here rather than in three templates, so the markup lives in one
    // place and the pages only declare that they want it.
    const panel = document.createElement('div');
    panel.className = 'mt-3 hidden rounded-lg border border-slate-300 bg-slate-900 p-3';
    panel.innerHTML = `
      <div class="flex items-center justify-between gap-2 pb-2">
        <p class="text-xs font-medium text-slate-300" data-qr-status>Starting the camera…</p>
        <button type="button" class="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800" data-qr-close>Close</button>
      </div>
      <video data-qr-video playsinline muted class="mx-auto block max-h-72 w-full rounded bg-black object-cover"></video>
      <p class="pt-2 text-center text-xs text-slate-400" data-qr-hint>Hold the ticket steady inside the frame.</p>
      <div class="hidden items-center justify-center gap-2 pt-2" data-qr-recover>
        <select class="hidden rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200" data-qr-device></select>
        <button type="button" class="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800" data-qr-retry>Try again</button>
      </div>`;
    form.insertAdjacentElement('afterend', panel);

    const video = panel.querySelector('[data-qr-video]');
    const status = panel.querySelector('[data-qr-status]');
    const hint = panel.querySelector('[data-qr-hint]');
    const recover = panel.querySelector('[data-qr-recover]');
    const devicePicker = panel.querySelector('[data-qr-device]');
    const retryButton = panel.querySelector('[data-qr-retry]');

    // Set once the operator picks a camera by hand, and then preferred over
    // any guess about which lens is wanted.
    let chosenDeviceId = rememberedCamera();
    // True only once the operator has picked from the list themselves.
    let deviceIsExplicit = false;

    let stream = null;
    let decoder = null;
    let running = false;
    let lastValue = null;
    let lastAt = 0;
    let lastDecodeAt = 0;

    function say(text, tone) {
      status.textContent = text;
      status.className = `text-xs font-medium ${tone === 'bad' ? 'text-red-300' : (tone === 'good' ? 'text-green-300' : 'text-slate-300')}`;
    }

    // `recoverable` decides whether Try again is offered. A blocked permission is
    // not one of those — the fix is in the address bar, and a button beside it
    // would fail identically and make the page look broken.
    function refuse(message, recoverable) {
      panel.classList.remove('hidden');
      video.classList.add('hidden');
      say(message, 'bad');
      hint.textContent = '';
      showControls({ retry: Boolean(recoverable) });
    }

    // The picker is offered whenever there is a genuine choice, working or not —
    // a machine with OBS installed can open the WRONG camera perfectly happily,
    // and then the operator needs to switch, not to retry.
    async function showControls({ retry }) {
      retryButton.classList.toggle('hidden', !retry);

      const cameras = await listCameras();
      const choose = cameras.length > 1;
      if (choose) {
        devicePicker.innerHTML = realFirst(cameras)
          .map((cam, i) => `<option value="${cam.deviceId}">${cam.label || `Camera ${i + 1}`}</option>`)
          .join('');
        if (chosenDeviceId) devicePicker.value = chosenDeviceId;
      }
      devicePicker.classList.toggle('hidden', !choose);

      const anything = retry || choose;
      recover.classList.toggle('hidden', !anything);
      recover.classList.toggle('flex', anything);
    }

    function releaseCamera() {
      if (!stream) return;
      // Every track, explicitly: leaving one open keeps the camera light on
      // after the panel is closed, which people reasonably read as the page
      // still watching them.
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }

    function stop() {
      running = false;
      releaseCamera();
      video.srcObject = null;
      panel.classList.add('hidden');
      button.textContent = button.dataset.labelOpen || 'Use camera';
      input.focus();
    }

    async function tick() {
      if (!running) return;
      const now = Date.now();

      // The native decoder is cheap enough to run every frame; jsQR is not.
      if (!decoder.throttle || now - lastDecodeAt >= DECODE_INTERVAL_MS) {
        lastDecodeAt = now;
        let value = '';
        try {
          value = await decoder.read(video);
        } catch (err) {
          // One bad frame is not worth stopping for; the next usually reads.
        }

        if (value && !(value === lastValue && now - lastAt < SAME_CODE_COOLDOWN_MS)) {
          lastValue = value;
          lastAt = now;
          say('Read — submitting…', 'good');
          input.value = value;
          // Through the form, so the page's own handler decides what a scan
          // means. This file knows how to read a code and nothing else.
          if (form.requestSubmit) form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          hint.textContent = 'Ready for the next one — keep the camera open.';
        } else if (!value) {
          say('Looking for a code…');
        }
      }

      requestAnimationFrame(tick);
    }

    async function start() {
      const problem = environmentProblem();
      if (problem) { refuse(MESSAGES[problem]); return; }

      panel.classList.remove('hidden');
      video.classList.remove('hidden');
      say('Asking for permission to use the camera…');
      hint.textContent = 'Your browser will ask once. Choose Allow.';

      if (await priorPermission() === 'denied') { refuse(MESSAGES.denied); return; }

      // Permission first, decoder second. The prompt is the thing the operator
      // is waiting on, and nothing below it can run without a camera anyway.
      //
      // Each constraint set is tried in turn, because the first failure is
      // often about WHICH camera was asked for rather than about cameras being
      // unavailable: asking for a rear lens on a desktop can land on a device
      // that will not start, where a plain request succeeds immediately.
      let lastError = null;
      for (const constraints of attemptsFor(chosenDeviceId, deviceIsExplicit)) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (FINAL_ERRORS.includes(err && err.name)) break;
        }
      }

      // Still nothing, and the failure was not a definitive one. The likely
      // cause is that the browser chose a camera that cannot actually start —
      // an idle OBS virtual camera being the usual culprit — so now name the
      // real ones explicitly instead of letting it choose again.
      if (!stream && lastError && !deviceIsExplicit && !FINAL_ERRORS.includes(lastError.name)) {
        const cameras = realFirst(await listCameras());
        for (const camera of cameras) {
          if (!camera.deviceId) continue;
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: camera.deviceId } },
              audio: false,
            });
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }
      }

      if (lastError) {
        const name = lastError.name || 'unknown';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          refuse(MESSAGES.denied, false);
        } else if (name === 'NotFoundError') {
          refuse('No camera was found on this device.', false);
        } else if (name === 'NotReadableError' || name === 'AbortError') {
          // Permission was given and the hardware still said no.
          refuse(MESSAGES.inUse, true);
        } else {
          refuse(`The camera could not start (${name}). Close anything else using it and try again.`, true);
        }
        return;
      }

      // srcObject, never URL.createObjectURL(stream): a blob: URL in a <video>
      // is fetched, and media-src falls back to default-src 'self', which would
      // block it silently. Assigning the stream is not a fetch.
      video.srcObject = stream;
      try {
        await video.play();
      } catch (err) {
        // Autoplay policies vary; a muted inline video is normally fine, and
        // the frames still arrive for the decoder either way.
      }

      say('Starting the QR reader…');
      try {
        decoder = await makeDecoder();
      } catch (err) {
        releaseCamera();
        video.srcObject = null;
        refuse(MESSAGES.noDecoder, false);
        return;
      }

      running = true;
      // Remember what actually worked, so the next shift starts on it.
      try {
        const track = stream.getTracks()[0];
        const settings = track && track.getSettings ? track.getSettings() : null;
        if (settings && settings.deviceId) {
          chosenDeviceId = settings.deviceId;
          rememberCamera(settings.deviceId);
        }
      } catch (err) { /* the stream works; which device it is, is a nicety */ }

      showControls({ retry: false });
      button.textContent = 'Close camera';
      say('Looking for a code…');
      hint.textContent = 'Hold the ticket steady inside the frame.';
      requestAnimationFrame(tick);
    }

    // Retrying in place rather than making them reload: the usual fix is to
    // close another program, and a page reload would lose the station name and
    // whatever is already typed in the scan box.
    retryButton.addEventListener('click', () => {
      releaseCamera();
      start();
    });
    devicePicker.addEventListener('change', () => {
      chosenDeviceId = devicePicker.value || '';
      deviceIsExplicit = Boolean(chosenDeviceId);
      rememberCamera(chosenDeviceId);
      releaseCamera();
      start();
    });

    button.dataset.labelOpen = button.textContent.trim();
    button.addEventListener('click', () => (running || !panel.classList.contains('hidden') ? stop() : start()));
    panel.querySelector('[data-qr-close]').addEventListener('click', stop);

    // A camera left running on a page nobody is looking at is a camera nobody
    // asked to keep on.
    document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop(); });
    window.addEventListener('pagehide', stop);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-qr-camera]').forEach(attach);
  });
}());
