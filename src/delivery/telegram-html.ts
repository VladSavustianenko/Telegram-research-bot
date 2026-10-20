/** Escaping for Telegram's HTML parse mode (text and attribute values). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Telegram limits message text to 4096 characters after entity parsing
 * (Bot API, sendMessage `text`). Parts are bounded by their full HTML length in
 * UTF-16 units, which is always at least the parsed length, with headroom for
 * the part counter.
 */
export const TELEGRAM_PART_LIMIT = 3_900;

/** Document caption: 0-1024 characters after entity parsing (Bot API, sendDocument `caption`). */
export const MAX_CAPTION_LENGTH = 1_024;

/** Files sent by multipart upload: at most 50 MB (Bot API, "Sending files"). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * Maximum report messages per delivery (SPEC §5 proposed default). A longer
 * report is sent as a summary message and a full-text document instead.
 */
export const MAX_REPORT_PARTS = 6;
