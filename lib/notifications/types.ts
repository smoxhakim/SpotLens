import { z } from "zod";

import type { Timeframe } from "@/lib/market-data/provider";
import type { SetupLifecycleStatus } from "@/lib/setups";

/**
 * The notification domain.
 *
 * Everything here describes *what happened*, never how it should be worded or
 * where it should go. Formatting belongs to a provider's formatter, and
 * routing belongs to the notification service, so that adding a channel later
 * cannot require touching the events themselves.
 */

export type NotificationEventType =
  | "SETUP_DETECTED"
  | "CONFIRMATION_DETECTED"
  | "SETUP_INVALIDATED"
  | "STRUCTURE_CHANGED"
  | "DAILY_SUMMARY"
  | "SYSTEM_ERROR";

export type NotificationChannel = "IN_APP" | "TELEGRAM";
export type NotificationPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Priority per event type, in one place.
 *
 * A table rather than a value threaded through the call sites, so "how urgent
 * is an invalidation?" has exactly one answer and changing it is a one-line
 * edit rather than a search.
 */
export const EVENT_PRIORITY: Record<NotificationEventType, NotificationPriority> = {
  SETUP_DETECTED: "MEDIUM",
  CONFIRMATION_DETECTED: "HIGH",
  SETUP_INVALIDATED: "HIGH",
  STRUCTURE_CHANGED: "MEDIUM",
  DAILY_SUMMARY: "LOW",
  SYSTEM_ERROR: "HIGH",
};

/** Levels and reasoning as they stood, copied from the stored setup snapshot. */
export interface SetupFacts {
  setupId: string;
  lifecycleStatus: SetupLifecycleStatus;
  previousStatus: SetupLifecycleStatus | null;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskReward: number;
  /** Phase A's qualifier. A message must never present an unmeasured reward as measured. */
  riskRewardIsSynthetic: boolean;
  score: number;
  scoreGrade: string;
  analysisStatus: string;
  trend: string;
  mtfAgreement: string | null;
  supportLow: number;
  supportHigh: number;
  entryReason: string;
  statusReason: string;
  /** Confirmation signals frozen onto the transition that caused this. */
  confirmationSignals: { type: string; signal: string; title: string; detail: string }[];
  confirmationExplanation: string | null;
  invalidationReason: string | null;
}

export interface DailySummaryFacts {
  date: string;
  runs: number;
  marketsScanned: number;
  analysesByTimeframe: { timeframe: string; count: number }[];
  potentialSetups: number;
  waiting: number;
  highRisk: number;
  avoided: number;
  failures: number;
  setupsCreated: number;
  confirmations: number;
  invalidations: number;
  /** Ranked by Phase E's ordering, not re-sorted here. */
  topRanked: { symbol: string; timeframe: string; analysisStatus: string; score: number | null }[];
}

export interface SystemErrorFacts {
  category: string;
  symbol: string | null;
  timeframe: string | null;
  /** Already sanitised by the scanner's failure classifier. */
  message: string;
  affectedMarkets: number;
}

/**
 * One thing worth telling the user about.
 *
 * `dedupeKey` is derived from the lifecycle event that caused it, not invented
 * here — see `dedupeKeyFor`. It is what makes re-observing an unchanged setup
 * silent.
 */
export interface NotificationEvent {
  type: NotificationEventType;
  userId: string;
  priority: NotificationPriority;
  asset: string | null;
  timeframe: Timeframe | null;
  /** Epoch ms, UTC, taken from the event that caused this. */
  timestamp: number;
  dedupeKey: string;
  setup: SetupFacts | null;
  summary: DailySummaryFacts | null;
  systemError: SystemErrorFacts | null;
}

/**
 * Validation for anything that arrives from outside the process.
 *
 * The events the scanner produces are built in-process from typed data and do
 * not need parsing; this exists for the Telegram payloads and API bodies,
 * where the shape is whatever the other side chose to send.
 */
export const notificationEventTypeSchema = z.enum([
  "SETUP_DETECTED",
  "CONFIRMATION_DETECTED",
  "SETUP_INVALIDATED",
  "STRUCTURE_CHANGED",
  "DAILY_SUMMARY",
  "SYSTEM_ERROR",
]);

export const notificationChannelSchema = z.enum(["IN_APP", "TELEGRAM"]);

export interface NotificationPreferences {
  inAppEnabled: boolean;
  telegramEnabled: boolean;
  setupDetected: boolean;
  confirmationDetected: boolean;
  setupInvalidated: boolean;
  structureChanged: boolean;
  dailySummary: boolean;
  systemError: boolean;
}

/**
 * What a fresh install does before anyone touches Settings.
 *
 * Quiet on purpose. The three that default on are the ones that describe
 * something having changed at a level already being tracked; the three that
 * default off are the ones that fire often enough to become wallpaper.
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  inAppEnabled: true,
  telegramEnabled: false,
  setupDetected: false,
  confirmationDetected: true,
  setupInvalidated: true,
  structureChanged: false,
  dailySummary: false,
  systemError: true,
};

/** Which preference flag governs which event type. */
export const PREFERENCE_FOR_EVENT: Record<
  NotificationEventType,
  keyof Omit<NotificationPreferences, "inAppEnabled" | "telegramEnabled">
> = {
  SETUP_DETECTED: "setupDetected",
  CONFIRMATION_DETECTED: "confirmationDetected",
  SETUP_INVALIDATED: "setupInvalidated",
  STRUCTURE_CHANGED: "structureChanged",
  DAILY_SUMMARY: "dailySummary",
  SYSTEM_ERROR: "systemError",
};
