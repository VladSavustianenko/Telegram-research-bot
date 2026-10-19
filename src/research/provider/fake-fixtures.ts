import type { ProviderCitation, ProviderTextPart } from './provider.types';

/**
 * Dated synthetic fixtures (2026-10-18) for the fake provider. All sources use
 * reserved example domains. They prove application behaviour (rendering,
 * citations, persistence, delivery), not real-world search quality.
 */

export type FixtureKey = 'football' | 'shopping' | 'news' | 'generic';

export type Segment = string | { cite: { url: string; title: string } };

/** Builds text with model-style markdown citations and code-point annotations. */
export function buildTextPart(segments: readonly Segment[]): ProviderTextPart {
  let text = '';
  let length = 0; // code points
  const citations: ProviderCitation[] = [];
  for (const segment of segments) {
    if (typeof segment === 'string') {
      text += segment;
      length += Array.from(segment).length;
      continue;
    }
    const host = new URL(segment.cite.url).hostname;
    const marker = ` ([${host}](${segment.cite.url}))`;
    citations.push({
      startIndex: length,
      endIndex: length + Array.from(marker).length,
      url: segment.cite.url,
      title: segment.cite.title,
    });
    text += marker;
    length += Array.from(marker).length;
  }
  return { text, citations };
}

const source = (url: string, title: string) => ({ cite: { url, title } });

export const FAKE_FIXTURES: Record<FixtureKey, { parts: ProviderTextPart[]; searches: number }> = {
  football: {
    searches: 2,
    parts: [
      buildTextPart([
        'OUTCOME: FOUND\n',
        'Матчі чоловічих основних команд, тиждень 2026-10-19 – 2026-10-25 (час Europe/Kyiv). ⚽\n\n',
        '• FC Barcelona – Sevilla, La Liga, 2026-10-20 22:00',
        source('https://fixtures.example.com/barcelona', 'Synthetic: FC Barcelona fixtures'),
        '\n• Real Madrid – Juventus, Ліга чемпіонів, 2026-10-21 22:00',
        source('https://uefa.example.org/matches/rm-juv', 'Synthetic: UEFA match centre'),
        '\n• Bayern Munich – Mainz, Bundesliga, 2026-10-24 16:30; час може змінитися',
        source('https://bundesliga.example.net/bayern', 'Synthetic: Bundesliga schedule'),
        '\n\nОбмеження: синтетичні дані; час початку матчів TBD не перевірявся.',
      ]),
    ],
  },
  shopping: {
    searches: 3,
    parts: [
      buildTextPart([
        'OUTCOME: PARTIAL\n',
        'Пропозиції до 700 грн в українських інтернет-магазинах (перевірено 2026-10-18):\n\n',
        '• Шорти Nike Dri-FIT – 649 грн, розміри S, M',
        source('https://shop.example.com/nike-shorts', 'Synthetic: Nike shorts listing'),
        '\n• Футболка adidas – 699 грн; наявність розмірів не вказана',
        source('https://store.example.org/adidas-tee', 'Synthetic: adidas T-shirt'),
        '\n\nОбмеження: Under Armour і New Balance не знайдено в межах ціни; ціни можуть змінитися. ' +
          'Наявність у фізичних магазинах не перевіряється.',
      ]),
    ],
  },
  news: {
    searches: 2,
    parts: [
      buildTextPart([
        'OUTCOME: FOUND\n',
        'Політичні новини за 2026-10-12 – 2026-10-18:\n\n',
        '1. Парламент ухвалив бюджет у першому читанні (подія 2026-10-15, публікація 2026-10-15)',
        source('https://news.example.com/budget', 'Synthetic: budget vote report'),
        '\n2. Офіційна заява уряду щодо реформи (подія 2026-10-17)',
        source('https://gov.example.org/statement', 'Synthetic: official statement'),
        '\n\nОбмеження: аналітичні матеріали відокремлено від новин; перелік не є вичерпним.',
      ]),
    ],
  },
  generic: {
    searches: 1,
    parts: [
      buildTextPart([
        'OUTCOME: INCONCLUSIVE\n',
        'Симульована відповідь для перевірки доставки. Знайдено одне тестове джерело',
        source('https://example.com/simulated', 'Synthetic: example source'),
        '.\n\nОбмеження: це не результат реального пошуку.',
      ]),
    ],
  },
};

export function fixtureFor(prompt: string): FixtureKey {
  const text = prompt.toLowerCase();
  if (/футбол|football|матч|fixture/.test(text)) return 'football';
  if (/шорт|футболк|магазин|ціна|грн|shop|price|store/.test(text)) return 'shopping';
  if (/новин|політ|news|politic/.test(text)) return 'news';
  return 'generic';
}
