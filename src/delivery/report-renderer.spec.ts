import { describe, expect, it } from 'vitest';
import { buildTextPart, FAKE_FIXTURES, type Segment } from '../research/provider/fake-fixtures';
import { completed } from '../../test/support/fakes';
import { extractReport, type ExtractedReport } from '../research/report';
import {
  renderReport,
  renderReportMessages,
  reportFileName,
  type RenderableReport,
  type ReportPart,
} from './report-renderer';
import { MAX_CAPTION_LENGTH, MAX_REPORT_PARTS, TELEGRAM_PART_LIMIT } from './telegram-html';

const base = {
  runId: '11111111-2222-4333-8444-555555555555',
  checkedAt: new Date('2026-10-18T12:00:00Z'),
  timeZone: 'Europe/Kyiv',
  simulated: false,
};

function renderable(report: ExtractedReport | null, overrides: Partial<RenderableReport> = {}) {
  if (!report) throw new Error('no report');
  return { ...base, ...report, ...overrides };
}

const ALLOWED_TAGS = /<\/?(?:b|i|code|a)(?:\s[^>]*)?>/g;

/** Telegram-visible text approximation: tags removed, entities decoded. */
function visible(html: string): string {
  return html
    .replace(ALLOWED_TAGS, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

describe('renderReport', () => {
  it('escapes provider text so it cannot inject markup', () => {
    const report = extractReport(
      completed([
        buildTextPart([
          'OUTCOME: FOUND\n<b>bold</b> <a href="javascript:x">x</a> & <script>alert(1)</script>',
          { cite: { url: 'https://a.example/?q=1&r="2"', title: '<i>t</i>' } },
        ]),
      ]),
    );
    const [html = ''] = renderReportMessages(renderable(report));
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('javascript:x">');
    expect(html).toContain('href="https://a.example/?q=1&amp;r=%222%22"');
    // Only the renderer's own tags remain.
    expect(html.replace(ALLOWED_TAGS, '')).not.toMatch(/[<>]/);
    expect(html).toContain('&lt;i&gt;t&lt;/i&gt;');
  });

  it('places each citation link right after its claim and replaces the markdown citation', () => {
    const report = extractReport(
      completed([
        buildTextPart([
          'OUTCOME: FOUND\nClaim A',
          { cite: { url: 'https://a.example/', title: 'Source A' } },
          '. Claim B',
          { cite: { url: 'https://b.example/', title: 'Source B' } },
          '. Claim A again',
          { cite: { url: 'https://a.example/', title: 'Source A' } },
          '.',
        ]),
      ]),
    );
    const [html = ''] = renderReportMessages(renderable(report));
    expect(html).toContain(
      'Claim A <a href="https://a.example/">[1]</a>. Claim B <a href="https://b.example/">[2]</a>.',
    );
    expect(html).toContain('Claim A again <a href="https://a.example/">[1]</a>.');
    expect(html).not.toContain('](https://');
    expect(html).toContain('[1] <a href="https://a.example/">Source A</a>');
  });

  it('keeps model-written but unannotated links as plain, non-clickable text', () => {
    const report = extractReport(
      completed([
        buildTextPart([
          'OUTCOME: FOUND\nSee [fake](https://invented.example/) and',
          { cite: { url: 'https://real.example/', title: 'Real' } },
        ]),
      ]),
    );
    const [html = ''] = renderReportMessages(renderable(report));
    expect(html).not.toContain('href="https://invented.example/');
    expect(html).toContain('[fake](https://invented.example/)');
  });

  it('labels simulated results and shows warnings', () => {
    const report = extractReport(
      completed([{ text: 'OUTCOME: FOUND\nNo sources', citations: [] }]),
    );
    const [html = ''] = renderReportMessages(renderable(report, { simulated: true }));
    expect(html).toContain('СИМУЛЯЦІЯ');
    expect(html).toContain('невизначено');
    expect(html).toContain('Немає підтверджених посилань');
  });

  it('splits long Unicode reports within limits without breaking graphemes or links', () => {
    const segments: Segment[] = ['OUTCOME: FOUND\n'];
    for (let i = 0; i < 60; i += 1) {
      segments.push(`Пункт ${i}: 👨‍👩‍👧‍👦 матч 🇺🇦 «Динамо» & <ціна> ${'текст '.repeat(12)}`);
      segments.push({ cite: { url: `https://s${i % 7}.example/p/${i}`, title: `Джерело ${i}` } });
      segments.push(i % 5 === 4 ? '\n\n' : ' ');
    }
    const report = extractReport(completed([buildTextPart(segments)]));
    const parts = renderReportMessages(renderable(report));
    expect(renderReport(renderable(report)).every((part) => part.kind === 'MESSAGE')).toBe(true);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(MAX_REPORT_PARTS);
    for (const [index, part] of parts.entries()) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_PART_LIMIT);
      expect(part.startsWith(`<i>(${index + 1}/${parts.length})</i>`)).toBe(true);
      // Balanced links: each part opens and closes the same number of anchors.
      expect(part.match(/<a /g)?.length ?? 0).toBe(part.match(/<\/a>/g)?.length ?? 0);
      // No lone surrogates and no split ZWJ family / flag sequences.
      expect(part.isWellFormed()).toBe(true);
      expect(part).not.toMatch(/‍(?![\p{Extended_Pictographic}])/u);
    }
    // Parts may split between words; rejoin without counters and normalise whitespace.
    const all = parts
      .map((part) => visible(part).replace(/^\(\d+\/\d+\)\n/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    for (let i = 0; i < 60; i += 1) {
      expect(all).toContain(`Пункт ${i}: 👨‍👩‍👧‍👦 матч 🇺🇦 «Динамо» & <ціна>`);
    }
    // Every claim keeps its marker linked to the right source.
    expect(parts.join('')).toContain(`<a href="https://s3.example/p/3">[4]</a>`);
  });

  it('never truncates: a report beyond the part limit becomes a summary and a full document', () => {
    const segments: Segment[] = ['OUTCOME: FOUND\n'];
    for (let i = 0; i < 400; i += 1) {
      segments.push(`Абзац ${i}: 👨‍👩‍👧‍👦 «Динамо» & <ціна> ${'текст '.repeat(10)}`);
      segments.push({
        cite: { url: `https://s${i % 9}.example/p?i=${i % 9}&x="y"`, title: `Джерело <${i % 9}>` },
      });
      segments.push(i % 3 === 2 ? '\n\n' : ' ');
    }
    const report = extractReport(completed([buildTextPart(segments)]));
    const scheduledFor = new Date('2026-10-18T09:00:00Z');
    const input = renderable(report, { simulated: true, scheduledFor });
    expect(renderReportMessages(input).length).toBeGreaterThan(MAX_REPORT_PARTS);

    const parts = renderReport(input);
    expect(parts.map((part) => part.kind)).toEqual(['MESSAGE', 'DOCUMENT']);
    const [summary, file] = parts as [ReportPart, Extract<ReportPart, { kind: 'DOCUMENT' }>];
    expect(summary.html.length).toBeLessThanOrEqual(TELEGRAM_PART_LIMIT);
    expect(summary.html).toContain('СИМУЛЯЦІЯ');
    expect(summary.html).toContain('файлом нижче');
    expect(summary.html.replace(ALLOWED_TAGS, '')).not.toMatch(/[<>]/);
    expect(file.fileName).toBe(`report-${base.runId}.txt`);
    expect(file.html.length).toBeLessThanOrEqual(MAX_CAPTION_LENGTH);
    expect(file.html).toContain(base.runId);

    const text = file.fileContent;
    expect(text.isWellFormed()).toBe(true);
    // Header: simulation label, run ID, actual check time, scheduled time and delay, outcome.
    expect(text).toContain('СИМУЛЯЦІЯ');
    expect(text).toContain(`Запуск: ${base.runId}`);
    expect(text).toContain('Перевірено: 2026-10-18 15:00 Europe/Kyiv (2026-10-18 12:00 UTC)');
    expect(text).toContain(
      'Заплановано на: 2026-10-18 12:00 Europe/Kyiv — виконано із затримкою 180 хв',
    );
    expect(text).toContain('Підсумок: знайдено');
    // The complete report, verbatim (no escaping in plain text), each claim with its marker.
    expect(report?.text).toBeTruthy();
    for (let i = 0; i < 400; i += 1) {
      expect(text).toContain(
        `Абзац ${i}: 👨‍👩‍👧‍👦 «Динамо» & <ціна> ${'текст '.repeat(10)} [${(i % 9) + 1}]`,
      );
    }
    // Source list maps every marker to its validated URL.
    for (let n = 0; n < 9; n += 1) {
      expect(text).toContain(
        `[${n + 1}] Джерело <${n}> — https://s${n}.example/p?i=${n}&x=%22y%22`,
      );
    }
    // Deterministic: re-rendering the stored report gives identical bytes.
    expect(renderReport(input)).toEqual(parts);
  });

  it('uses only the run ID in the file name', () => {
    expect(reportFileName(base.runId)).toBe(`report-${base.runId}.txt`);
    expect(() => reportFileName('../../etc/passwd')).toThrow();
  });

  it('renders every synthetic fixture with clickable sources', () => {
    for (const [key, fixture] of Object.entries(FAKE_FIXTURES)) {
      const report = extractReport(completed(fixture.parts, { webSearchCalls: fixture.searches }));
      const parts = renderReport(renderable(report, { simulated: true }));
      expect(parts, key).toHaveLength(1);
      expect(parts[0]?.html, key).toMatch(
        /<a href="https:\/\/[^"]+\.(com|org|net)\/[^"]*">\[1\]<\/a>/,
      );
    }
  });
});
