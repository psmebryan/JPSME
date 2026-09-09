const net = require('net');

// Reports which outbound ports this host can actually open.
//
// Worth having because the answer is invisible from anywhere else. A managed
// platform rarely documents its egress policy, and every failure looks the same
// from inside the app: a connection that never completes. We established by
// accident, over several hours, that port 3306 is blocked here while 443 works
// — a two-line probe would have said so in one deploy.
//
// Gated behind an environment variable and off by default: it makes outbound
// connections to third-party hosts, which is not something a web server should
// do on every boot unattended.
//
// Set EGRESS_PROBE=host:port,host:port to run it. The results go to the log and
// nothing else; nothing here changes how the app behaves.

const TIMEOUT_MS = 8000;

function probe(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, result, ms: Date.now() - started });
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => done('open'));
    // A timeout and a refusal mean different things: nothing answered at all
    // (a firewall silently dropping the packets, which is what a platform block
    // looks like) versus something answered and said no (the port is reachable
    // but closed). Only the first rules out using that port entirely.
    socket.once('timeout', () => done('blocked (no answer)'));
    socket.once('error', (err) => done(`refused (${err.code || err.message})`));
    socket.connect(port, host);
  });
}

// "host:port,host:port" — or "1" / "true" for a default set covering the
// questions that actually come up: is HTTPS the only thing allowed out, is
// SSH available for a tunnel, can we reach MySQL directly.
function parseTargets(raw) {
  const value = String(raw).trim().replace(/^["']|["']$/g, '');
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    return [
      { host: 'api.brevo.com', port: 443 },        // known-good control
      { host: 'github.com', port: 22 },            // is SSH allowed out at all
      { host: 'sg2plzcpnl508783.prod.sin2.secureserver.net', port: 22 },
      { host: 'sg2plzcpnl508783.prod.sin2.secureserver.net', port: 3306 },
    ];
  }
  return value.split(',').map((pair) => {
    const idx = pair.lastIndexOf(':');
    if (idx < 1) return null;
    const host = pair.slice(0, idx).trim();
    const port = Number(pair.slice(idx + 1).trim());
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }).filter(Boolean);
}

async function runEgressProbeIfRequested(log = console) {
  const raw = process.env.EGRESS_PROBE;
  if (!raw) return null;

  const targets = parseTargets(raw);
  if (!targets.length) {
    log.error('EGRESS_PROBE is set but no valid host:port targets were parsed from it.');
    return null;
  }

  log.log(`egress probe: testing ${targets.length} target(s), ${TIMEOUT_MS / 1000}s timeout each`);
  // Together rather than in sequence: a blocked port costs the full timeout,
  // and four of those in a row is half a minute added to every boot.
  const results = await Promise.all(targets.map((t) => probe(t.host, t.port)));
  results.forEach((r) => log.log(`  ${r.host}:${r.port} — ${r.result} (${r.ms}ms)`));
  log.log('  egress probe done. Unset EGRESS_PROBE to stop running it on boot.');
  return results;
}

module.exports = { runEgressProbeIfRequested, parseTargets };
