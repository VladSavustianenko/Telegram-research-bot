import { describe, expect, it } from 'vitest';
import { buildTextPart, FAKE_FIXTURES, type Segment } from '../research/provider/fake-fixtures';
import { completed } from '../../test/support/fakes';
import { extractReport, type ExtractedReport } from '../research/report';
import { renderReport, type RenderableReport } from './report-renderer';
import { MAX_REPORT_PARTS, TELEGRAM_PART_LIMIT } from './telegram-html';

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
    const [html = ''] = renderReport(renderable(report));
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
    const [html = ''] = renderReport(renderable(report));
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
    const [html = ''] = renderReport(renderable(report));
    expect(html).not.toContain('href="https://invented.example/');
    expect(html).toContain('[fake](https://invented.example/)');
  });

  it('labels simulated results and shows warnings', () => {
    const report = extractReport(
      completed([{ text: 'OUTCOME: FOUND\nNo sources', citations: [] }]),
    );
    const [html = ''] = renderReport(renderable(report, { simulated: true }));
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
    const parts = renderReport(renderable(report));

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

  it('truncates visibly at the part limit and is deterministic', () => {
    const report = extractReport(
      completed([
        buildTextPart([
          'OUTCOME: FOUND\n',
          'Довгий абзац. '.repeat(3_000),
          { cite: { url: 'https://a.example/', title: 'A' } },
        ]),
      ]),
    );
    const first = renderReport(renderable(report));
    expect(first).toHaveLength(MAX_REPORT_PARTS);
    expect(first.at(-1)).toContain('Звіт обрізано');
    expect(first.every((part) => part.length <= TELEGRAM_PART_LIMIT)).toBe(true);
    expect(renderReport(renderable(report))).toEqual(first);
  });

  it('renders every synthetic fixture with clickable sources', () => {
    for (const [key, fixture] of Object.entries(FAKE_FIXTURES)) {
      const report = extractReport(completed(fixture.parts, { webSearchCalls: fixture.searches }));
      const parts = renderReport(renderable(report, { simulated: true }));
      expect(parts, key).toHaveLength(1);
      expect(parts[0], key).toMatch(/<a href="https:\/\/[^"]+\.(com|org|net)\/[^"]*">\[1\]<\/a>/);
    }
  });
});
