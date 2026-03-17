/**
 * Deep-walk an object and replace {{KEY}} placeholders in string values.
 *
 * @param {*} obj - Value to process (object, array, string, or primitive).
 * @param {Record<string, string>} constants - Map of constant names to values.
 * @returns {*} A new object/array/string with placeholders replaced.
 */
export function substituteConstants(obj, constants) {
  if (!constants || typeof constants !== "object") {
    return obj;
  }

  if (typeof obj === "string") {
    return obj.replace(/\{\{(\w+)\}\}/gu, (match, key) =>
      Object.hasOwn(constants, key) ? String(constants[key]) : match,
    );
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => substituteConstants(item, constants));
  }

  if (obj !== null && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteConstants(value, constants);
    }
    return result;
  }

  return obj;
}
