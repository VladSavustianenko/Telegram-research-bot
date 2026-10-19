import type { ReportWarning, ResearchOutcome } from '../research/report';

/**
 * User-facing texts (Ukrainian UI, SPEC §1). Plain text; callers escape before
 * embedding in Telegram HTML.
 */
export const messages = {
  reportTitle: 'Результат дослідження',
  simulatedBanner: 'СИМУЛЯЦІЯ: тестові дані, реальний пошук не виконувався',
  runLabel: 'Запуск',
  checkedAtLabel: 'Перевірено',
  outcomeLabel: 'Підсумок',
  sourcesHeading: 'Джерела',
  truncated: (runId: string) =>
    `Звіт обрізано через ліміт повідомлень. Повний текст збережено (запуск ${runId}).`,

  help: [
    'Приватний дослідницький бот (прототип, лише для адміністраторів).',
    '',
    '/research <запит> - запустити дослідження з вебпошуком',
    '/result <id> - повторно надіслати збережений результат (без нового дослідження)',
    '/help - ця довідка',
  ].join('\n'),
  notAuthorized: 'Цей бот приватний. Доступ лише за запрошенням.',
  researchDisabled: 'Дослідження зараз вимкнено оператором.',
  emptyPrompt: 'Вкажіть запит: /research <що потрібно знайти>',
  promptTooLong: (max: number) => `Запит задовгий. Максимум ${max} символів.`,
  queueFull: (limit: number) =>
    `Черга заповнена (максимум ${limit} запитів). Спробуйте пізніше, коли поточні завершаться.`,
  accepted: (runId: string, simulated: boolean) =>
    [
      simulated ? 'Запит прийнято (СИМУЛЯЦІЯ, без реального пошуку).' : 'Запит прийнято.',
      `Запуск: ${runId}`,
      'Результат надійде окремим повідомленням.',
      `Повторно отримати: /result ${runId}`,
    ].join('\n'),
  resultUsage: 'Вкажіть ідентифікатор: /result <id>',
  runNotFound: 'Запуск не знайдено.',
  runQueued: (runId: string) => `Запуск ${runId} у черзі.`,
  runRunning: (runId: string) => `Запуск ${runId} виконується.`,
  runFailed: (runId: string, code: string) =>
    `Запуск ${runId} завершився помилкою (${code}). Звіту немає.`,
  runUncertain: (runId: string, code: string) =>
    `Результат запуску ${runId} невизначений (${code}): запит до провайдера міг бути виконаний і оплачений. ` +
    'Автоматичного повтору не буде; потрібне рішення оператора.',
  unknownCommand: 'Невідома команда. /help - довідка.',
} as const;

export const OUTCOME_LABELS: Record<ResearchOutcome, string> = {
  FOUND: 'знайдено',
  PARTIAL: 'частково',
  NO_MATCHES: 'нічого не знайдено',
  INCONCLUSIVE: 'невизначено',
};

export const WARNING_LABELS: Record<ReportWarning, string> = {
  OUTCOME_NOT_DECLARED: 'Модель не вказала підсумок; результат вважається невизначеним.',
  NO_CITATIONS: 'Немає підтверджених посилань на джерела; висновки не перевірені.',
  NO_WEB_SEARCH: 'Вебпошук не зафіксовано у відповіді провайдера.',
  UNSAFE_CITATION_DROPPED: 'Небезпечні посилання на джерела відкинуто.',
  INVALID_CITATION_DROPPED: 'Некоректні посилання на джерела відкинуто.',
};
