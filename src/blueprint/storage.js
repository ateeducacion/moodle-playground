const BLUEPRINT_KEY_PREFIX = "moodle-playground:blueprint";

function hasWindow() {
  return typeof window !== "undefined";
}

function getBlueprintStorageKey(scopeId) {
  return `${BLUEPRINT_KEY_PREFIX}:${scopeId}`;
}

export function saveBlueprint(scopeId, blueprint) {
  if (!hasWindow()) {
    return;
  }
  window.sessionStorage.setItem(
    getBlueprintStorageKey(scopeId),
    JSON.stringify(blueprint),
  );
}

export function loadBlueprint(scopeId) {
  if (!hasWindow()) {
    return null;
  }
  const raw = window.sessionStorage.getItem(getBlueprintStorageKey(scopeId));
  return raw ? JSON.parse(raw) : null;
}

export function clearBlueprint(scopeId) {
  if (!hasWindow()) {
    return;
  }
  window.sessionStorage.removeItem(getBlueprintStorageKey(scopeId));
}
