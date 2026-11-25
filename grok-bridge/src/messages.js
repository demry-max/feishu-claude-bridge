/** Light helpers for inbound Feishu text from lark-cli event consume. */

export function stripMentions(text) {
  return String(text ?? '')
    .replace(/@_user_\d+/g, '')
    .replace(/@_all/g, '')
    .trim();
}

/**
 * Normalize content from an lark-cli event row.
 * lark-cli already pre-renders most types to human-readable text.
 */
export function parseEventContent(ev) {
  const raw = ev?.content;
  if (raw == null) return { text: '' };
  if (typeof raw === 'string') return { text: stripMentions(raw) };
  if (typeof raw === 'object') {
    if (typeof raw.text === 'string') return { text: stripMentions(raw.text) };
    try {
      return { text: stripMentions(JSON.stringify(raw)) };
    } catch {
      return { text: '' };
    }
  }
  return { text: stripMentions(String(raw)) };
}
