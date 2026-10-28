// User-entered names: group names and passkey labels. Pure.
export const MAX_GROUP_NAME = 80;
export const MAX_LABEL = 60;

/** The trimmed text, or null if it isn't a non-blank string of at most `max` characters. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}
