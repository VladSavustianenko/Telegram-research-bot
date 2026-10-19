import type { Citation, ReportWarning, ResearchOutcome } from '../research/report';
import { safeSourceUrl } from '../research/report';
import { formatLocal } from '../research/request-builder';
import { MAX_REPORT_PARTS, TELEGRAM_PART_LIMIT, escapeHtml } from './telegram-html';
import { OUTCOME_LABELS, WARNING_LABELS, messages } from './messages';

export interface RenderableReport {
  runId: string;
  checkedAt: Date;
  timeZone: string;
  outcome: ResearchOutcome;
  warnings: readonly ReportWarning[];
  simulated: boolean;
  text: string;
  citations: readonly Citation[];
}

/** An indivisible piece of HTML, or plain text that may be split at boundaries. */
type Atom = { kind: 'html'; html: string } | { kind: 'text'; text: string };

const MARKDOWN_CITATION = /^\s*\(?\s*\[[^\]\n]*\]\([^)\s]*\)\s*\)?\s*$/;
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
const COUNTER_RESERVE = 16; // "<i>(6/6)</i>\n"

/**
 * Deterministic Telegram HTML rendering. All provider text is escaped; only
 * provider url_citation annotations become links, placed right after the
 * claim they annotate (a model-written markdown citation span is replaced by
 * the link). Links are indivisible, so splitting never separates a claim
 * marker from its URL.
 */
export function renderReport(report: RenderableReport): string[] {
  const sourceNumbers = new Map<string, number>();
  const sourceTitles = new Map<string, string>();
  const body = bodyAtoms(report, sourceNumbers, sourceTitles);

  const header: Atom = { kind: 'html', html: headerHtml(report) };
  const footer: Atom[] = [];
  if (sourceNumbers.size > 0) {
    footer.push({ kind: 'html', html: `\n\n<b>${escapeHtml(messages.sourcesHeading)}</b>` });
    for (const [url, number] of sourceNumbers) {
      const label = sourceTitles.get(url) || new URL(url).hostname;
      footer.push({ kind: 'html', html: `\n[${number}] ${link(url, label)}` });
    }
  }
  return paginate([header, ...body, ...footer], report.runId);
}

function headerHtml(report: RenderableReport): string {
  const lines = [`<b>${escapeHtml(messages.reportTitle)}</b>`];
  if (report.simulated) lines.push(`<b>${escapeHtml(messages.simulatedBanner)}</b>`);
  lines.push(`${escapeHtml(messages.runLabel)}: <code>${escapeHtml(report.runId)}</code>`);
  lines.push(
    escapeHtml(
      `${messages.checkedAtLabel}: ${formatLocal(report.checkedAt, report.timeZone)} ${report.timeZone} ` +
        `(${report.checkedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    ),
  );
  lines.push(
    `${escapeHtml(messages.outcomeLabel)}: <b>${escapeHtml(OUTCOME_LABELS[report.outcome])}</b>`,
  );
  for (const warning of report.warnings) {
    lines.push(`⚠️ ${escapeHtml(WARNING_LABELS[warning])}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function bodyAtoms(
  report: RenderableReport,
  sourceNumbers: Map<string, number>,
  sourceTitles: Map<string, string>,
): Atom[] {
  const codePoints = Array.from(report.text);
  const removed = new Array<boolean>(codePoints.length).fill(false);
  const markersAt = new Map<number, Citation[]>();

  for (const citation of report.citations) {
    const url = safeSourceUrl(citation.url);
    if (!url || citation.end > codePoints.length || citation.start > citation.end) continue;
    const span = codePoints.slice(citation.start, citation.end).join('');
    if (MARKDOWN_CITATION.test(span)) removed.fill(true, citation.start, citation.end);
    const at = markersAt.get(citation.end) ?? [];
    at.push({ ...citation, url });
    markersAt.set(citation.end, at);
  }

  const atoms: Atom[] = [];
  let pending = '';
  const flushText = () => {
    if (pending) atoms.push({ kind: 'text', text: pending });
    pending = '';
  };
  for (let index = 0; index <= codePoints.length; index += 1) {
    const markers = markersAt.get(index);
    if (markers) {
      const numbers = new Set<number>();
      for (const citation of markers) {
        if (!sourceNumbers.has(citation.url)) {
          sourceNumbers.set(citation.url, sourceNumbers.size + 1);
          sourceTitles.set(citation.url, citation.title.trim());
        }
        numbers.add(sourceNumbers.get(citation.url) ?? 0);
      }
      flushText();
      for (const number of numbers) {
        const url = [...sourceNumbers].find(([, n]) => n === number)?.[0] ?? '';
        atoms.push({ kind: 'html', html: ` ${link(url, `[${number}]`)}` });
      }
    }
    if (index < codePoints.length && !removed[index]) pending += codePoints[index];
  }
  flushText();
  return atoms;
}

function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** Packs atoms into at most MAX_REPORT_PARTS parts, splitting text at semantic boundaries. */
function paginate(atoms: Atom[], runId: string): string[] {
  const budget = TELEGRAM_PART_LIMIT - COUNTER_RESERVE;
  const truncation = `\n\n<i>${escapeHtml(messages.truncated(runId))}</i>`;
  const parts: string[] = [];
  let current = '';
  let truncated = false;

  const lastPart = () => parts.length === MAX_REPORT_PARTS - 1;
  const capacity = () => budget - (lastPart() ? truncation.length : 0);
  const flush = (): boolean => {
    if (lastPart()) return false;
    parts.push(current);
    current = '';
    return true;
  };

  outer: for (const atom of atoms) {
    if (atom.kind === 'html') {
      if (current.length + atom.html.length > capacity()) {
        if (!flush()) {
          truncated = true;
          break;
        }
      }
      current += atom.html;
      continue;
    }
    let rest = atom.text;
    while (rest) {
      const room = capacity() - current.length;
      const escaped = escapeHtml(rest);
      if (escaped.length <= room) {
        current += escaped;
        break;
      }
      const cut = splitPoint(rest, room);
      // When the best boundary would waste more than half of the remaining room,
      // start a fresh part instead (a fresh part always has room for a boundary).
      if (current.length > 0 && escapeHtml(rest.slice(0, cut)).length < room * 0.5 && !lastPart()) {
        flush();
        continue;
      }
      if (cut === 0) {
        if (!flush()) {
          truncated = true;
          break outer;
        }
        continue;
      }
      current += escapeHtml(rest.slice(0, cut));
      rest = rest.slice(cut);
      if (!flush()) {
        truncated = true;
        break outer;
      }
    }
  }
  if (truncated) current += truncation;
  parts.push(current);

  const total = parts.filter((part) => part.trim()).length;
  return parts
    .filter((part) => part.trim())
    .map((part, index) =>
      (total > 1 ? `<i>(${index + 1}/${total})</i>\n${part.trimStart()}` : part).trimEnd(),
    );
}

/**
 * Largest prefix length (UTF-16 index) of `text` whose escaped form fits in
 * `room`, ending at the best available boundary: paragraph, line, sentence,
 * word, then grapheme. Never splits a grapheme cluster or surrogate pair.
 */
function splitPoint(text: string, room: number): number {
  if (room <= 0) return 0;
  let fit = 0;
  let used = 0;
  for (const { segment, index } of GRAPHEMES.segment(text)) {
    const size = escapeHtml(segment).length;
    if (used + size > room) break;
    used += size;
    fit = index + segment.length;
  }
  if (fit === 0) return 0;
  const window = text.slice(0, fit);
  const minimum = Math.floor(fit * 0.3);
  for (const boundary of [/\n\n(?=[^\n])/g, /\n/g, /[.!?…](?=\s)/g, /\s/g]) {
    let best = -1;
    for (const match of window.matchAll(boundary)) {
      const end = match.index + match[0].length;
      if (end <= fit) best = end;
    }
    if (best > minimum) return best;
  }
  return fit;
}
