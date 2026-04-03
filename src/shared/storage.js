const SCOPE_PREFIX = "moodle-playground:";
let scopeCounter = 0;

export function buildScopeKey(scopeId, suffix) {
  return `${SCOPE_PREFIX}${scopeId}:${suffix}`;
}

function createScopeId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `tab-${randomId}`;
  }

  const randomWords =
    globalThis.crypto?.getRandomValues?.(new Uint32Array(2)) || null;
  if (randomWords) {
    return `tab-${Array.from(randomWords, (value) => value.toString(16).padStart(8, "0")).join("")}`;
  }

  scopeCounter += 1;
  const timestamp = Date.now().toString(36);
  const monotonic = Math.floor(globalThis.performance?.now?.() || 0).toString(
    36,
  );
  return `tab-${timestamp}-${monotonic}-${scopeCounter.toString(36)}`;
}

export function getOrCreateScopeId() {
  const url = new URL(window.location.href);
  const existing =
    url.searchParams.get("scope") ||
    window.sessionStorage.getItem(`${SCOPE_PREFIX}active`);

  if (existing) {
    window.sessionStorage.setItem(`${SCOPE_PREFIX}active`, existing);
    return existing;
  }

  const next = createScopeId();
  window.sessionStorage.setItem(`${SCOPE_PREFIX}active`, next);
  return next;
}

export function saveSessionState(scopeId, data) {
  window.sessionStorage.setItem(
    buildScopeKey(scopeId, "state"),
    JSON.stringify(data),
  );
}

export function loadSessionState(scopeId) {
  const raw = window.sessionStorage.getItem(buildScopeKey(scopeId, "state"));
  return raw ? JSON.parse(raw) : null;
}

export function clearScopeSession(scopeId) {
  const prefix = buildScopeKey(scopeId, "");
  const keys = Object.keys(window.sessionStorage);

  for (const key of keys) {
    if (key.startsWith(prefix)) {
      window.sessionStorage.removeItem(key);
    }
  }
}
