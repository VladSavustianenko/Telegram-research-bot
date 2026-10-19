import { describe, expect, it } from 'vitest';
import { completed } from '../../test/support/fakes';
import { buildTextPart } from './provider/fake-fixtures';
import { extractReport, safeSourceUrl } from './report';

const cite = (url: string, title = 'Title') => ({ cite: { url, title } });

describe('extractReport', () => {
  it('accepts the declared outcome when search ran and citations exist', () => {
    const report = extractReport(
      completed([
        buildTextPart(['OUTCOME: FOUND\nКлуб грає 20 жовтня.', cite('https://a.example/x')]),
      ]),
    );
    expect(report).toMatchObject({ outcome: 'FOUND', declaredOutcome: 'FOUND', warnings: [] });
    expect(report?.text.startsWith('Клуб грає')).toBe(true);
    const [citation] = report?.citations ?? [];
    expect(
      Array.from(report?.text ?? '')
        .slice(citation?.start, citation?.end)
        .join(''),
    ).toBe(' ([a.example](https://a.example/x))');
  });

  it('is INCONCLUSIVE with a visible warning when no citation exists, whatever the model claims', () => {
    for (const declared of ['FOUND', 'NO_MATCHES']) {
      const report = extractReport(
        completed([{ text: `OUTCOME: ${declared}\nNothing cited.`, citations: [] }]),
      );
      expect(report?.outcome).toBe('INCONCLUSIVE');
      expect(report?.warnings).toContain('NO_CITATIONS');
    }
  });

  it('is INCONCLUSIVE when no web search call is present', () => {
    const report = extractReport(
      completed([buildTextPart(['OUTCOME: FOUND\nClaim', cite('https://a.example/')])], {
        webSearchCalls: 0,
      }),
    );
    expect(report?.outcome).toBe('INCONCLUSIVE');
    expect(report?.warnings).toContain('NO_WEB_SEARCH');
  });

  it('treats a missing or malformed outcome line as INCONCLUSIVE', () => {
    const report = extractReport(
      completed([buildTextPart(['Results: FOUND maybe', cite('https://a.example/')])]),
    );
    expect(report?.outcome).toBe('INCONCLUSIVE');
    expect(report?.warnings).toContain('OUTCOME_NOT_DECLARED');
  });

  it('drops citations with unsafe schemes or credentials instead of rendering them', () => {
    const part = buildTextPart(['OUTCOME: FOUND\nA', cite('https://ok.example/'), ' B']);
    part.citations.push(
      { startIndex: 0, endIndex: 1, url: 'javascript:alert(1)', title: 'x' },
      { startIndex: 0, endIndex: 1, url: 'https://user:pw@evil.example/', title: 'x' },
    );
    const report = extractReport(completed([part]));
    expect(report?.citations.map((citation) => citation.url)).toEqual(['https://ok.example/']);
    expect(report?.warnings).toContain('UNSAFE_CITATION_DROPPED');
  });

  it('resolves UTF-16 offsets when they, not code points, locate the cited URL', () => {
    const text = 'OUTCOME: FOUND\n😀😀 claim ([s.example](https://s.example/p))';
    const start = text.indexOf(' ([s.example]'); // UTF-16 index, emoji count twice
    const part = {
      text,
      citations: [
        { startIndex: start, endIndex: text.length, url: 'https://s.example/p', title: 't' },
      ],
    };
    const report = extractReport(completed([part]));
    const [citation] = report?.citations ?? [];
    expect(
      Array.from(report?.text ?? '')
        .slice(citation?.start, citation?.end)
        .join(''),
    ).toBe(' ([s.example](https://s.example/p))');
  });

  it('shifts offsets of later text parts and returns null for empty output', () => {
    const report = extractReport(
      completed([
        buildTextPart(['OUTCOME: PARTIAL\nFirst', cite('https://one.example/')]),
        buildTextPart(['Second', cite('https://two.example/')]),
      ]),
    );
    const text = Array.from(report?.text ?? '');
    expect(report?.citations.map((c) => text.slice(c.start, c.end).join(''))).toEqual([
      ' ([one.example](https://one.example/))',
      ' ([two.example](https://two.example/))',
    ]);
    expect(extractReport(completed([{ text: '  \n', citations: [] }]))).toBeNull();
  });
});

describe('safeSourceUrl', () => {
  it.each([
    ['https://a.example/x?y=1', 'https://a.example/x?y=1'],
    ['http://a.example', 'http://a.example/'],
    ['javascript:alert(1)', null],
    ['data:text/html,x', null],
    ['tg://resolve?domain=x', null],
    ['//a.example', null],
    [`https://a.example/${'x'.repeat(2100)}`, null],
  ])('%s -> %s', (input, expected) => {
    expect(safeSourceUrl(input)).toBe(expected);
  });
});
