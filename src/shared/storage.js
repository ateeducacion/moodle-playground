const SCOPE_PREFIX = "moodle-playground:";

export function buildScopeKey(scopeId, suffix) {
  return `${SCOPE_PREFIX}${scopeId}:${suffix}`;
}

export function getOrCreateScopeId() {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get("scope") || window.sessionStorage.getItem(`${SCOPE_PREFIX}active`);

  if (existing) {
    window.sessionStorage.setItem(`${SCOPE_PREFIX}active`, existing);
    return existing;
  }

  const next = "main";
  window.sessionStorage.setItem(`${SCOPE_PREFIX}active`, next);
  return next;
}

export function saveSessionState(scopeId, data) {
  window.sessionStorage.setItem(buildScopeKey(scopeId, "state"), JSON.stringify(data));
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
