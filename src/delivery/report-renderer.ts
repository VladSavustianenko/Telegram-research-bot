import { createHash } from 'node:crypto';
import type { Citation, ReportWarning, ResearchOutcome } from '../research/report';
import { safeSourceUrl } from '../research/report';
import { formatLocal } from '../research/request-builder';
import {
  MAX_CAPTION_LENGTH,
  MAX_DOCUMENT_BYTES,
  MAX_REPORT_PARTS,
  TELEGRAM_PART_LIMIT,
  escapeHtml,
} from './telegram-html';
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
  /** Scheduled runs: the planned occurrence; the header discloses any delay (TRB-070). */
  scheduledFor?: Date;
}

/** A stored report part: a Telegram HTML message, or the full-text document (TRB-080). */
export type ReportPart =
  | { kind: 'MESSAGE'; html: string }
  | { kind: 'DOCUMENT'; html: string; fileName: string; fileContent: string };

/** A scheduled report started later than this is labelled as delayed. */
export const DELAY_NOTICE_MINUTES = 5;

/** An indivisible piece of HTML, or plain text that may be split at boundaries. */
type Atom = { kind: 'html'; html: string } | { kind: 'text'; text: string };

/** Body element: report text, or the marker of a validated source right after its claim. */
type BodyItem = { kind: 'text'; text: string } | { kind: 'marker'; number: number; url: string };

interface ReportModel {
  /** Header lines; `strong` lines are bold in HTML. */
  header: { text: string; strong?: boolean; code?: { label: string; value: string } }[];
  body: BodyItem[];
  sources: { number: number; url: string; label: string }[];
}

const MARKDOWN_CITATION = /^\s*\(?\s*\[[^\]\n]*\]\([^)\s]*\)\s*\)?\s*$/;
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
const COUNTER_RESERVE = 16; // "<i>(6/6)</i>\n"

/**
 * Deterministic rendering of a stored report (docs/DELIVERY.md).
 *
 * All provider text is escaped; only validated provider url_citation
 * annotations become links, placed right after the claim they annotate (a
 * model-written markdown citation span is replaced by the link). Links are
 * indivisible, so splitting never separates a claim marker from its URL.
 *
 * Nothing is cut off: when the messages would exceed MAX_REPORT_PARTS, the
 * report becomes one summary message (header and a pointer to the file) plus a
 * UTF-8 plain-text document with the complete report, the same claim-linked
 * markers and the source list. Both renderings come from the same model, so
 * the citation association is identical, and the output depends only on the
 * stored report, so it can be recreated identically.
 */
export function renderReport(report: RenderableReport): ReportPart[] {
  const messagesHtml = renderReportMessages(report);
  if (messagesHtml.length <= MAX_REPORT_PARTS) {
    return messagesHtml.map((html) => ({ kind: 'MESSAGE', html }));
  }
  const model = reportModel(report);
  const fileContent = renderReportDocument(model);
  if (Buffer.byteLength(fileContent) > MAX_DOCUMENT_BYTES) {
    // Unreachable with bounded provider output; never send a document Telegram would refuse.
    throw new Error('report document exceeds the Telegram upload limit');
  }
  const caption = escapeHtml(messages.documentCaption(report.runId));
  if (caption.length > MAX_CAPTION_LENGTH) throw new Error('document caption too long');
  return [
    {
      kind: 'MESSAGE',
      html: `${headerHtml(model)}<i>${escapeHtml(messages.documentFallback(MAX_REPORT_PARTS))}</i>`,
    },
    { kind: 'DOCUMENT', html: caption, fileName: reportFileName(report.runId), fileContent },
  ];
}

/** Every Telegram message of the report, without the part bound (tests and fallback decision). */
export function renderReportMessages(report: RenderableReport): string[] {
  const model = reportModel(report);
  const atoms: Atom[] = [{ kind: 'html', html: headerHtml(model) }];
  for (const item of model.body) {
    atoms.push(
      item.kind === 'text'
        ? { kind: 'text', text: item.text }
        : { kind: 'html', html: ` ${link(item.url, `[${item.number}]`)}` },
    );
  }
  if (model.sources.length > 0) {
    atoms.push({ kind: 'html', html: `\n\n<b>${escapeHtml(messages.sourcesHeading)}</b>` });
    for (const source of model.sources) {
      atoms.push({ kind: 'html', html: `\n[${source.number}] ${link(source.url, source.label)}` });
    }
  }
  return paginate(atoms);
}

/** Safe, fixed file name: only the run ID (a UUID), never user or model text. */
export function reportFileName(runId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('unexpected run ID');
  return `report-${runId}.txt`;
}

/** SHA-256 of a part's exact payload (message HTML, or caption and document bytes). */
export function partContentHash(part: {
  html: string;
  fileName?: string | null;
  fileContent?: string | null;
}): string {
  const hash = createHash('sha256').update(part.html);
  if (part.fileContent !== undefined && part.fileContent !== null) {
    hash
      .update('\u0000')
      .update(part.fileName ?? '')
      .update('\u0000')
      .update(part.fileContent);
  }
  return hash.digest('hex');
}

function reportModel(report: RenderableReport): ReportModel {
  const header: ReportModel['header'] = [{ text: messages.reportTitle, strong: true }];
  if (report.simulated) header.push({ text: messages.simulatedBanner, strong: true });
  header.push({ text: '', code: { label: messages.runLabel, value: report.runId } });
  header.push({
    text:
      `${messages.checkedAtLabel}: ${formatLocal(report.checkedAt, report.timeZone)} ${report.timeZone} ` +
      `(${report.checkedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
  });
  if (report.scheduledFor) {
    const minutes = Math.round(
      (report.checkedAt.getTime() - report.scheduledFor.getTime()) / 60_000,
    );
    header.push({
      text:
        `${messages.scheduledForLabel}: ${formatLocal(report.scheduledFor, report.timeZone)} ${report.timeZone}` +
        (minutes > DELAY_NOTICE_MINUTES ? ` — ${messages.delayedBy(minutes)}` : ''),
    });
  }
  header.push({ text: `${messages.outcomeLabel}: ${OUTCOME_LABELS[report.outcome]}` });
  for (const warning of report.warnings) header.push({ text: `⚠️ ${WARNING_LABELS[warning]}` });

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

  const numbers = new Map<string, number>();
  const sources: ReportModel['sources'] = [];
  const body: BodyItem[] = [];
  let pending = '';
  const flush = () => {
    if (pending) body.push({ kind: 'text', text: pending });
    pending = '';
  };
  for (let index = 0; index <= codePoints.length; index += 1) {
    const markers = markersAt.get(index);
    if (markers) {
      flush();
      const seen = new Set<number>();
      for (const citation of markers) {
        let number = numbers.get(citation.url);
        if (number === undefined) {
          number = numbers.size + 1;
          numbers.set(citation.url, number);
          sources.push({
            number,
            url: citation.url,
            label: citation.title.trim() || new URL(citation.url).hostname,
          });
        }
        if (seen.has(number)) continue;
        seen.add(number);
        body.push({ kind: 'marker', number, url: citation.url });
      }
    }
    if (index < codePoints.length && !removed[index]) pending += codePoints[index];
  }
  flush();
  return { header, body, sources };
}

function headerHtml(model: ReportModel): string {
  const lines = model.header.map((line) => {
    if (line.code)
      return `${escapeHtml(line.code.label)}: <code>${escapeHtml(line.code.value)}</code>`;
    if (line.strong) return `<b>${escapeHtml(line.text)}</b>`;
    // The outcome value is bold, as before.
    const outcome = `${messages.outcomeLabel}: `;
    return line.text.startsWith(outcome)
      ? `${escapeHtml(outcome)}<b>${escapeHtml(line.text.slice(outcome.length))}</b>`
      : escapeHtml(line.text);
  });
  return `${lines.join('\n')}\n\n`;
}

/**
 * The full-text document (UTF-8 plain text, LF line endings, no BOM): header,
 * the complete report with "[n]" right after each claim, and the source list
 * mapping each marker to its validated URL. Plain text needs no escaping and
 * cannot carry markup or active content.
 */
function renderReportDocument(model: ReportModel): string {
  const header = model.header.map((line) =>
    line.code ? `${line.code.label}: ${line.code.value}` : line.text,
  );
  const body = model.body
    .map((item) => (item.kind === 'text' ? item.text : ` [${item.number}]`))
    .join('');
  const lines = [...header, '', body.trimEnd()];
  if (model.sources.length > 0) {
    lines.push('', messages.sourcesHeading);
    for (const source of model.sources) {
      lines.push(`[${source.number}] ${source.label} — ${source.url}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** Packs atoms into parts, splitting text at semantic boundaries; nothing is dropped. */
function paginate(atoms: Atom[]): string[] {
  const capacity = TELEGRAM_PART_LIMIT - COUNTER_RESERVE;
  const parts: string[] = [];
  let current = '';
  const flush = () => {
    parts.push(current);
    current = '';
  };

  for (const atom of atoms) {
    if (atom.kind === 'html') {
      if (current.length + atom.html.length > capacity) flush();
      current += atom.html;
      continue;
    }
    let rest = atom.text;
    while (rest) {
      const room = capacity - current.length;
      const escaped = escapeHtml(rest);
      if (escaped.length <= room) {
        current += escaped;
        break;
      }
      const cut = splitPoint(rest, room);
      // When the best boundary would waste more than half of the remaining room,
      // start a fresh part instead (a fresh part always has room for a boundary).
      if (current.length > 0 && (cut === 0 || escapeHtml(rest.slice(0, cut)).length < room * 0.5)) {
        flush();
        continue;
      }
      current += escapeHtml(rest.slice(0, cut));
      rest = rest.slice(cut);
      flush();
    }
  }
  parts.push(current);

  const kept = parts.filter((part) => part.trim());
  return kept.map((part, index) =>
    (kept.length > 1
      ? `<i>(${index + 1}/${kept.length})</i>\n${part.trimStart()}`
      : part
    ).trimEnd(),
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
