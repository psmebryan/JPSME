// Minimal structured (JSON-lines) logger — no external dependency, since the
// only thing actually needed here is "every log line carries whatever
// correlation id started it" (a request id, a job id), not log shipping,
// rotation, or multiple transports. child() attaches context once (e.g. the
// request id) so every subsequent call on that child logger includes it
// automatically, instead of repeating it at every call site.

function serializeMeta(meta) {
  if (!meta) return {};
  const out = { ...meta };
  if (out.err instanceof Error) {
    // Error objects serialize to "{}" under plain JSON.stringify (their
    // properties aren't enumerable) — pull out the parts worth keeping.
    out.err = { name: out.err.name, message: out.err.message, stack: out.err.stack };
  }
  return out;
}

function write(level, baseMeta, message, meta) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...baseMeta,
    ...serializeMeta(meta),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function createLogger(baseMeta = {}) {
  return {
    debug: (message, meta) => write('debug', baseMeta, message, meta),
    info: (message, meta) => write('info', baseMeta, message, meta),
    warn: (message, meta) => write('warn', baseMeta, message, meta),
    error: (message, meta) => write('error', baseMeta, message, meta),
    child: (extraMeta) => createLogger({ ...baseMeta, ...extraMeta }),
  };
}

const logger = createLogger();
logger.createLogger = createLogger;

module.exports = logger;
