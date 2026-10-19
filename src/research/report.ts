import type { ProviderCitation, ProviderSnapshot } from './provider/provider.types';

export type ResearchOutcome = 'FOUND' | 'PARTIAL' | 'NO_MATCHES' | 'INCONCLUSIVE';

export type ReportWarning =
  | 'OUTCOME_NOT_DECLARED'
  | 'NO_CITATIONS'
  | 'NO_WEB_SEARCH'
  | 'UNSAFE_CITATION_DROPPED'
  | 'INVALID_CITATION_DROPPED';

/** Citation with offsets in Unicode code points into `ExtractedReport.text`. */
export interface Citation {
  start: number;
  end: number;
  url: string;
  title: string;
}

export interface ExtractedReport {
  text: string;
  citations: Citation[];
  outcome: ResearchOutcome;
  declaredOutcome: ResearchOutcome | null;
  warnings: ReportWarning[];
}

const OUTCOME_LINE = /^[\s*_]*OUTCOME\s*:\s*(FOUND|PARTIAL|NO_MATCHES|INCONCLUSIVE)\b[^\n]*(\n|$)/i;
const PART_SEPARATOR = '\n\n';
const MAX_URL_LENGTH = 2_048;

/** Safe, absolute http(s) URL without credentials, or null. */
export function safeSourceUrl(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.toString();
}

/**
 * Builds the stored report from a completed provider response. The outcome is
 * classified deterministically: the declared OUTCOME line is accepted only
 * when web search ran and at least one valid citation exists; otherwise the
 * result is INCONCLUSIVE with a visible warning. Returns null for empty text.
 */
export function extractReport(snapshot: ProviderSnapshot): ExtractedReport | null {
  const warnings = new Set<ReportWarning>();
  let text = '';
  let citations: Citation[] = [];
  let offset = 0; // code points

  for (const part of snapshot.textParts) {
    if (!part.text) continue;
    if (text) {
      text += PART_SEPARATOR;
      offset += PART_SEPARATOR.length;
    }
    for (const citation of part.citations) {
      const resolved = resolveCitation(part.text, citation);
      if (resolved === 'invalid') warnings.add('INVALID_CITATION_DROPPED');
      else if (resolved === 'unsafe') warnings.add('UNSAFE_CITATION_DROPPED');
      else
        citations.push({ ...resolved, start: resolved.start + offset, end: resolved.end + offset });
    }
    text += part.text;
    offset += codePointLength(part.text);
  }
  if (!text.trim()) return null;

  let declaredOutcome: ResearchOutcome | null = null;
  const match = OUTCOME_LINE.exec(text);
  if (match) {
    declaredOutcome = (match[1] ?? '').toUpperCase() as ResearchOutcome;
    const removed = codePointLength(match[0]);
    text = text.slice(match[0].length);
    citations = citations
      .filter((citation) => citation.start >= removed)
      .map((citation) => ({
        ...citation,
        start: citation.start - removed,
        end: citation.end - removed,
      }));
  } else {
    warnings.add('OUTCOME_NOT_DECLARED');
  }

  if (snapshot.webSearchCalls === 0) warnings.add('NO_WEB_SEARCH');
  if (citations.length === 0) warnings.add('NO_CITATIONS');

  const evidenceMissing = warnings.has('NO_WEB_SEARCH') || warnings.has('NO_CITATIONS');
  const outcome = declaredOutcome && !evidenceMissing ? declaredOutcome : 'INCONCLUSIVE';

  citations.sort((a, b) => a.start - b.start || a.end - b.end);
  return { text, citations, outcome, declaredOutcome, warnings: [...warnings] };
}

/**
 * The Responses API documents start/end indices but not their unit. Indices
 * are tried as code points first, then as UTF-16 units; the interpretation
 * whose span contains the cited URL (or its host) wins. Otherwise code points
 * are used. Returns code-point offsets.
 */
function resolveCitation(
  text: string,
  citation: ProviderCitation,
): Citation | 'invalid' | 'unsafe' {
  const url = safeSourceUrl(citation.url);
  if (!url) return 'unsafe';
  const { startIndex: start, endIndex: end } = citation;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return 'invalid';
  }
  const codePoints = Array.from(text);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const mentions = (span: string) => span.includes(citation.url) || span.includes(host);

  const asCodePoints =
    end <= codePoints.length ? { start, end, span: codePoints.slice(start, end).join('') } : null;
  const asUtf16 =
    end <= text.length && !splitsSurrogate(text, start) && !splitsSurrogate(text, end)
      ? {
          start: codePointLength(text.slice(0, start)),
          end: codePointLength(text.slice(0, end)),
          span: text.slice(start, end),
        }
      : null;

  const chosen =
    (asCodePoints && mentions(asCodePoints.span) && asCodePoints) ||
    (asUtf16 && mentions(asUtf16.span) && asUtf16) ||
    asCodePoints;
  if (!chosen) return 'invalid';
  return { start: chosen.start, end: chosen.end, url, title: citation.title.slice(0, 300) };
}

function splitsSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const previous = text.charCodeAt(index - 1);
  return previous >= 0xd800 && previous <= 0xdbff;
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}
