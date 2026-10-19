import type { Denial } from '../identity/authorization';
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
    'Приватний дослідницький бот (прототип).',
    '',
    '/tasks - ваші завдання',
    '/new - створити завдання',
    '/cancel - скасувати незавершену чернетку',
    '/research <запит> - запустити дослідження з вебпошуком',
    '/result <id> - повторно надіслати збережений результат (без нового дослідження)',
    '/help - ця довідка',
  ].join('\n'),
  adminHelp: [
    'Адміністрування:',
    '/admin invite - створити одноразове запрошення',
    '/admin suspend <Telegram ID> - призупинити доступ користувача',
    '/admin reactivate <Telegram ID> - відновити доступ (без доставки накопиченого)',
  ].join('\n'),

  // Identity and onboarding (TRB-030).
  invitationRequired: 'Цей бот приватний. Доступ лише за запрошенням.',
  invitationInvalid:
    'Запрошення недійсне, прострочене або вже використане. Попросіть адміністратора про нове.',
  alreadyRegistered: 'Ви вже зареєстровані; запрошення не використано.',
  suspended: 'Ваш доступ призупинено адміністратором.',
  welcome: 'Вітаємо! Запрошення прийнято.',
  timeZonePrompt:
    'Підтвердіть часовий пояс: за ним бот тлумачить дати й тижні у ваших запитах. ' +
    'Пропонуємо Europe/Kyiv. Натисніть кнопку або надішліть назву часового поясу IANA, ' +
    'наприклад Europe/Warsaw чи America/New_York.',
  onboardingRequired: 'Спершу завершіть реєстрацію: підтвердіть часовий пояс.',
  timeZoneInvalid:
    'Невідомий часовий пояс. Надішліть назву IANA, наприклад Europe/Kyiv або America/New_York.',
  timeZoneQuestion: (zone: string) => `Підтвердити часовий пояс ${zone}?`,
  timeZoneConfirmed: (zone: string) => `Часовий пояс підтверджено: ${zone}.`,
  timeZoneAlreadyConfirmed: (zone: string) => `Часовий пояс уже підтверджено: ${zone}.`,
  staleButton: 'Ця кнопка застаріла.',
  liveAdminOnly:
    'Live-дослідження поки доступні лише адміністраторам (до запровадження бюджетів). Запит не прийнято.',

  // Administration (TRB-030, minimal).
  invitationCreated: (expiresAt: string, link: string) =>
    [
      `Одноразове запрошення, дійсне до ${expiresAt}:`,
      link,
      '',
      'Передайте його лише тому, кого запрошуєте: скористатися ним може перший, хто його отримає.',
    ].join('\n'),
  invitationsNotConfigured:
    'Запрошення не налаштовано: оператор має задати INVITATION_TOKEN_SECRET.',
  invitationRedeemedNotice: (telegramUserId: string) =>
    `Ваше запрошення використано. Telegram ID нового користувача: ${telegramUserId}.`,
  adminTargetUsage: 'Вкажіть числовий Telegram ID: /admin suspend <ID> або /admin reactivate <ID>',
  adminUserNotFound: 'Користувача з таким Telegram ID не знайдено.',
  adminTargetIsAdmin: 'Адміністратора не можна призупинити; змініть ADMIN_TELEGRAM_IDS.',
  adminSuspended: (telegramUserId: string, cancelled: number, running: number) =>
    `Доступ користувача ${telegramUserId} призупинено. Скасовано запусків у черзі: ${cancelled}. ` +
    `Запусків, що виконуються: ${running} (буде запит на скасування; звіти не доставлятимуться).`,
  adminAlreadySuspended: (telegramUserId: string) =>
    `Доступ користувача ${telegramUserId} уже призупинено.`,
  adminReactivated: (telegramUserId: string) =>
    `Доступ користувача ${telegramUserId} відновлено. Накопичені результати не надсилаються.`,
  adminNotSuspended: (telegramUserId: string) => `Користувач ${telegramUserId} не призупинений.`,
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
  runUncertain: (runId: string, code: string, simulated: boolean) =>
    simulated
      ? `Результат симульованого запуску ${runId} невизначений (${code}). ` +
        'СИМУЛЯЦІЯ: реального запиту до провайдера і витрат не було.'
      : `Результат запуску ${runId} невизначений (${code}): запит до провайдера міг бути виконаний і оплачений, ` +
        'можливо, він ще виконується. Автоматичного повтору не буде. ' +
        'Нові live-дослідження заблоковано до звірки оператором.',
  runCancelled: (runId: string, code: string) =>
    `Запуск ${runId} скасовано (${code}). Звіту немає.`,
  runUncertainReconciled: (runId: string, code: string) =>
    `Результат запуску ${runId} невизначений (${code}); оператор провів звірку. Звіту немає.`,
  liveBlocked:
    'Live-дослідження тимчасово заблоковано: попередній запуск має невизначений результат ' +
    'і потребує звірки оператором. Запит не прийнято.',
  unknownCommand: 'Невідома команда. /help - довідка.',
} as const;

/** Reply for an authorization denial. NOT_ADMIN looks like an unknown command (no disclosure). */
export function denialMessage(denial: Denial): string {
  switch (denial) {
    case 'NOT_REGISTERED':
      return messages.invitationRequired;
    case 'SUSPENDED':
      return messages.suspended;
    case 'ONBOARDING_INCOMPLETE':
      return messages.onboardingRequired;
    case 'NOT_ADMIN':
      return messages.unknownCommand;
    case 'LIVE_ADMIN_ONLY':
      return messages.liveAdminOnly;
  }
}

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
