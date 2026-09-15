/**
 * The notification layer.
 *
 * Consumes what the scanner and the setup lifecycle already established; it
 * never re-derives analysis. Pure parts (event mapping, dedupe keys, message
 * formatting) live here; `services/notifications.ts` performs the delivery and
 * the writes.
 */
export {
  CONFIRMATION_WATCH_EVENTS,
  DEFAULT_PREFERENCES,
  EVENT_PRIORITY,
  PREFERENCE_FOR_EVENT,
  isConfirmationWatchEvent,
  notificationChannelSchema,
  notificationEventTypeSchema,
  type DailySummaryFacts,
  type LifecycleNotificationEventType,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationEventType,
  type NotificationPreferences,
  type NotificationPriority,
  type SetupFacts,
  type SystemErrorFacts,
} from "./types";

export {
  dedupeKeyForDailySummary,
  dedupeKeyForSetupEvent,
  dedupeKeyForSystemError,
  eventTypeForTransition,
  isStructuralChange,
  isTelegramWorthy,
  telegramPriorityFor,
  type RoutingFacts,
  type TelegramPriority,
  type TransitionFacts,
} from "./mapping";

export {
  REPLACEMENT_TITLE,
  TELEGRAM_TITLES,
  escape,
  formatConfirmation,
  formatConnectionTest,
  formatDailySummary,
  formatForTelegram,
  formatInvalidation,
  formatPotentialSetup,
  formatReplacement,
  formatStructureChange,
  formatSystemError,
} from "./telegram-format";

export {
  MAX_RETRY_AFTER_MS,
  MAX_SEND_ATTEMPTS,
  SEND_RETRY_BASE_MS,
  TELEGRAM_BOTS,
  getTelegramBotUsername,
  getTelegramUpdates,
  isTelegramConfigured,
  resetTelegramIdentityCache,
  parseUpdates,
  sendTelegramMessage,
  tokenVariableFor,
  type TelegramBot,
  type TelegramSendResult,
  type TelegramUpdate,
} from "./telegram-provider";

export { IN_APP_MARKERS, renderInApp, toneForNotification, type NotificationTone } from "./render";
