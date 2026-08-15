// Minimal Sentry error-monitoring client (no SDK dependency).
// See docs/architecture/adr/ADR-0028-sentry-error-monitoring.md
//
// The shell loads as an unbundled ES module straight from source, so this
// client is hand-rolled instead of pulling in @sentry/browser: it posts plain
// envelope payloads to Sentry's ingest endpoint with fetch() and degrades to
// a no-op whenever no DSN is configured or delivery fails.

const CLIENT_NAME = "moodle-playground-monitoring";
const CLIENT_VERSION = "1.0.0";
const MAX_EVENTS_PER_SESSION = 30;
const MAX_STACK_FRAMES = 50;

/**
 * Parse a Sentry DSN (https://<publicKey>@<host>/<path?>/<projectId>) into
 * the pieces needed to build the envelope ingest URL. Returns null when the
 * DSN is missing or malformed — callers treat that as "monitoring disabled".
 */
export function parseDsn(dsn) {
  if (!dsn || typeof dsn !== "string") {
    return null;
  }

  let url;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!url.username || !projectId || !/^\d+$/.test(projectId)) {
    return null;
  }

  const basePath = segments.length ? `/${segments.join("/")}` : "";
  return {
    publicKey: url.username,
    host: url.host,
    projectId,
    envelopeUrl:
      `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/` +
      `?sentry_key=${url.username}&sentry_version=7` +
      `&sentry_client=${CLIENT_NAME}%2F${CLIENT_VERSION}`,
  };
}

/**
 * Best-effort parser for V8 ("at fn (url:line:col)") and Firefox/Safari
 * ("fn@url:line:col") stack strings. Sentry expects frames ordered from
 * oldest call to newest, so the parsed list is reversed.
 */
export function parseStackFrames(stack) {
  if (!stack || typeof stack !== "string") {
    return [];
  }

  const frames = [];
  for (const line of stack.split("\n")) {
    const text = line.trim();
    const v8 = text.match(/^at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/);
    const gecko = text.match(/^(?:(.*?)@)?(.+?):(\d+):(\d+)$/);
    const match = v8 || gecko;
    if (!match || match[2].startsWith("<")) {
      continue;
    }
    frames.push({
      function: match[1] || "?",
      filename: match[2],
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: true,
    });
    if (frames.length >= MAX_STACK_FRAMES) {
      break;
    }
  }

  return frames.reverse();
}

function generateEventId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
  }
  let id = "";
  while (id.length < 32) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

function detectEnvironment() {
  const hostname = globalThis.location?.hostname || "";
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".local")
  ) {
    return "development";
  }
  return "production";
}

/**
 * Build a Sentry event payload. Pass either an Error-like `error` or a plain
 * string `message`. Exported for tests.
 */
export function buildEvent({
  error,
  message,
  level = "error",
  release,
  environment,
  tags,
  extra,
}) {
  const event = {
    event_id: generateEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    logger: "moodle-playground",
    level,
    sdk: { name: CLIENT_NAME, version: CLIENT_VERSION },
  };

  if (release) {
    event.release = release;
  }
  event.environment = environment || detectEnvironment();
  if (tags && Object.keys(tags).length) {
    event.tags = tags;
  }
  if (extra && Object.keys(extra).length) {
    event.extra = extra;
  }

  const pageUrl = globalThis.location?.href;
  if (pageUrl) {
    event.request = { url: pageUrl };
    const userAgent = globalThis.navigator?.userAgent;
    if (userAgent) {
      event.request.headers = { "User-Agent": userAgent };
    }
  }

  if (error) {
    const value = {
      type: error.name || "Error",
      value: String(error.message ?? error),
      mechanism: { type: "generic", handled: true },
    };
    const frames = parseStackFrames(error.stack);
    if (frames.length) {
      value.stacktrace = { frames };
    }
    event.exception = { values: [value] };
  } else {
    event.message = { formatted: String(message) };
  }

  return event;
}

/** Serialize an event into a Sentry envelope body. Exported for tests. */
export function buildEnvelope(event, dsn) {
  const header = {
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    sdk: { name: CLIENT_NAME, version: CLIENT_VERSION },
  };
  if (dsn) {
    header.dsn = dsn;
  }
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

function eventSignature(event) {
  const exception = event.exception?.values?.[0];
  const detail = exception
    ? `${exception.type}:${exception.value}`
    : event.message?.formatted || "";
  return `${event.level}:${detail}`;
}

/**
 * Create a monitoring client. Returns a disabled no-op client when the DSN is
 * missing or invalid, so callers never need to branch. Capture calls must
 * never throw — monitoring failures cannot be allowed to break the shell.
 */
export function createMonitoringClient(options = {}) {
  const {
    dsn,
    release,
    environment,
    tags,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    maxEvents = MAX_EVENTS_PER_SESSION,
  } = options;

  const target = parseDsn(dsn);
  if (!target || typeof fetchImpl !== "function") {
    return {
      enabled: false,
      captureException() {},
      captureMessage() {},
    };
  }

  const seenSignatures = new Set();
  let sentCount = 0;

  function send(event) {
    const signature = eventSignature(event);
    if (sentCount >= maxEvents || seenSignatures.has(signature)) {
      return;
    }
    seenSignatures.add(signature);
    sentCount += 1;

    try {
      const result = fetchImpl(target.envelopeUrl, {
        method: "POST",
        body: buildEnvelope(event, dsn),
        // keepalive lets crash reports survive page unloads.
        keepalive: true,
      });
      // Delivery is fire-and-forget; a failed report must stay invisible.
      result?.catch?.(() => {});
    } catch {
      // Ignore — see above.
    }
  }

  return {
    enabled: true,
    captureException(error, extra) {
      try {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        send(
          buildEvent({ error: normalized, release, environment, tags, extra }),
        );
      } catch {
        // Never let monitoring break the caller.
      }
    },
    captureMessage(message, level = "info", extra) {
      try {
        send(buildEvent({ message, level, release, environment, tags, extra }));
      } catch {
        // Never let monitoring break the caller.
      }
    },
  };
}

let activeClient = null;

/**
 * Initialize the module-level client and hook uncaught errors / unhandled
 * promise rejections in window contexts. Safe to call with no DSN — the
 * exported capture helpers become no-ops.
 */
export function initMonitoring(options = {}) {
  activeClient = createMonitoringClient(options);

  const scope = options.scope || globalThis;
  if (activeClient.enabled && typeof scope.addEventListener === "function") {
    scope.addEventListener("error", (event) => {
      if (event?.error) {
        activeClient.captureException(event.error, {
          source: "window.onerror",
        });
      } else if (event?.message) {
        activeClient.captureMessage(event.message, "error", {
          source: "window.onerror",
        });
      }
    });
    scope.addEventListener("unhandledrejection", (event) => {
      activeClient.captureException(event?.reason ?? "Unhandled rejection", {
        source: "unhandledrejection",
      });
    });
  }

  return activeClient;
}

export function captureException(error, extra) {
  activeClient?.captureException(error, extra);
}

export function captureMessage(message, level = "info", extra) {
  activeClient?.captureMessage(message, level, extra);
}
