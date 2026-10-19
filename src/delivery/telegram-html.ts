/** Escaping for Telegram's HTML parse mode (text and attribute values). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Telegram limits message text to 4096 characters after entity parsing. Parts
 * are bounded by their full HTML length in UTF-16 units, which is always at
 * least the parsed length, with headroom for the part counter.
 */
export const TELEGRAM_PART_LIMIT = 3_900;

/** Maximum report messages per delivery (SPEC §5 proposed default). */
export const MAX_REPORT_PARTS = 6;
