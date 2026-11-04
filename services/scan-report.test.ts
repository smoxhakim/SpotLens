import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES, type NotificationEvent } from "@/lib/notifications";

/**
 * Scan report delivery: both switches, once per run, only for a pass with a
 * completion record — and the alerts beside it unchanged.
 *
 * The database is stubbed so these are about the delivery rules rather than
 * about Prisma — but the unique index cannot be stubbed away, so `P2002` is
 * simulated wherever idempotency is the claim.
 */

const db = {
  notification: { create: vi.fn(), update: vi.fn() },
  notificationPreference: { findUnique: vi.fn() },
  telegramConnection: { findUnique: vi.fn() },
  scannerRun: { findUnique: vi.fn() },
  scannerResult: { findMany: vi.fn() },
  trackedSetup: { groupBy: vi.fn() },
};

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: db }));

const sendTelegramMessage = vi.fn();
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return { ...actual, sendTelegramMessage: (i: unknown) => sendTelegramMessage(i) };
});

const { deliverScanReport } = await import("./scan-report");
const { deliverEvents, getPreferences } = await import("./notifications");

const STARTED = new Date(Date.UTC(2026, 10, 2, 7, 1, 30));

const RUN = {
  id: "run-1",
  status: "COMPLETED",
  timeframes: ["H1"],
  startedAt: STARTED,
  completedAt: new Date(STARTED.getTime() + 5_200),
  durationMs: 5_200,
};

const RESULTS = [
  { timeframe: "H1", status: "OK", analysisStatus: "POTENTIAL_SETUP" },
  { timeframe: "H1", status: "OK", analysisStatus: "WAIT_FOR_CONFIRMATION" },
  { timeframe: "H1", status: "OK", analysisStatus: "HIGH_RISK" },
  { timeframe: "H1", status: "OK", analysisStatus: "AVOID" },
];

const OPEN = [
  { status: "SETUP_FORMING", _count: { _all: 3 } },
  { status: "CONFIRMATION_DETECTED", _count: { _all: 2 } },
];

const EVENTS = [
  { type: "SETUP_CREATED", timeframe: "H1" },
  { type: "SETUP_INVALIDATED", timeframe: "H1" },
];

/** Both switches on: what delivery needs. The product default is both off. */
const ON = { ...DEFAULT_PREFERENCES, telegramEnabled: true, scanReport: true };

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function report(runId: string | null = "run-1") {
  return deliverScanReport({ userId: "user-1", runId, events: EVENTS });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.notificationPreference.findUnique.mockResolvedValue(ON);
  db.scannerRun.findUnique.mockResolvedValue(RUN);
  db.scannerResult.findMany.mockResolvedValue(RESULTS);
  db.trackedSetup.groupBy.mockResolvedValue(OPEN);
  db.telegramConnection.findUnique.mockResolvedValue({ chatId: "42" });
  db.notification.create.mockResolvedValue({ id: "n1" });
  db.notification.update.mockResolvedValue({});
  sendTelegramMessage.mockResolvedValue({ ok: true, error: null, retryable: false, attempts: 1 });
});

describe("a completed 1h pass", () => {
  it("writes one Telegram row for the run, then sends it to the main bot", async () => {
    const outcome = await report();

    expect(outcome).toEqual({ status: "SENT" });
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    expect(db.notification.create.mock.calls[0][0].data).toMatchObject({
      userId: "user-1",
      type: "SCAN_REPORT",
      channel: "TELEGRAM",
      priority: "LOW",
      status: "PENDING",
      timeframe: "H1",
      trackedSetupId: null,
      dedupeKey: "scan-report:run-1",
    });

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const sent = sendTelegramMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ chatId: "42", bot: "MAIN" });
    expect(sent.text).toContain("*Markets*: 4 · 4 succeeded · 0 failed");
    expect(sent.text).toContain("Potential setup: 1");
    expect(sent.text).toContain("*Setups*: 1 created · 1 invalidated");
    expect(sent.text).toContain("*Open 1h setups*: 5");

    // The outcome is written back, as for every Telegram row.
    expect(db.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "n1" },
        data: expect.objectContaining({ status: "SENT" }),
      }),
    );
  });

  it("reads only 1h results, and only this owner's open 1h setups", async () => {
    await report();

    expect(db.scannerResult.findMany.mock.calls[0][0].where).toEqual({
      scannerRunId: "run-1",
      timeframe: "H1",
    });
    expect(db.trackedSetup.groupBy.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      timeframe: "H1",
      status: { not: "INVALIDATED" },
    });
  });

  it("reports a PARTIAL pass, with its failures", async () => {
    db.scannerRun.findUnique.mockResolvedValue({ ...RUN, status: "PARTIAL" });
    db.scannerResult.findMany.mockResolvedValue([
      ...RESULTS,
      { timeframe: "H1", status: "FAILED", analysisStatus: null },
    ]);

    expect(await report()).toEqual({ status: "SENT" });
    expect(sendTelegramMessage.mock.calls[0][0].text).toContain("some markets failed");
    expect(sendTelegramMessage.mock.calls[0][0].text).toContain("5 · 4 succeeded · 1 failed");
  });
});

describe("never twice for the same pass", () => {
  it("sends nothing when the unique index already holds this run's report", async () => {
    db.notification.create.mockRejectedValue(uniqueViolation());

    expect(await report()).toEqual({ status: "DUPLICATE" });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends once however many times the same run is reported", async () => {
    const keys = new Set<string>();
    db.notification.create.mockImplementation(async ({ data }: { data: { dedupeKey: string } }) => {
      if (keys.has(data.dedupeKey)) throw uniqueViolation();
      keys.add(data.dedupeKey);
      return { id: `n${keys.size}` };
    });

    const outcomes = [await report(), await report(), await report()];

    expect(outcomes.map((o) => o.status)).toEqual(["SENT", "DUPLICATE", "DUPLICATE"]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a different run as a different report", async () => {
    const keys = new Set<string>();
    db.notification.create.mockImplementation(async ({ data }: { data: { dedupeKey: string } }) => {
      if (keys.has(data.dedupeKey)) throw uniqueViolation();
      keys.add(data.dedupeKey);
      return { id: `n${keys.size}` };
    });

    await report("run-1");
    db.scannerRun.findUnique.mockResolvedValue({ ...RUN, id: "run-2" });
    await report("run-2");

    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
  });
});

describe("no report without a successful, finished 1h pass", () => {
  it.each([
    ["FAILED", { ...RUN, status: "FAILED" }, "NOT_SUCCESSFUL"],
    ["RUNNING", { ...RUN, status: "RUNNING", completedAt: null }, "NOT_FINISHED"],
    ["4h-only", { ...RUN, timeframes: ["H4"] }, "NO_HOURLY_TIMEFRAME"],
    ["missing", null, "NO_RUN_RECORD"],
  ])("writes and sends nothing for a %s run", async (_name, stored, reason) => {
    db.scannerRun.findUnique.mockResolvedValue(stored);

    expect(await report()).toEqual({ status: "SKIPPED", reason });
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("writes and sends nothing when every 1h market failed", async () => {
    db.scannerRun.findUnique.mockResolvedValue({ ...RUN, status: "PARTIAL" });
    db.scannerResult.findMany.mockResolvedValue([
      { timeframe: "H1", status: "FAILED", analysisStatus: null },
    ]);

    expect(await report()).toEqual({ status: "SKIPPED", reason: "NO_HOURLY_ANALYSES" });
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("reads nothing for a pass that could not record itself", async () => {
    expect(await report(null)).toEqual({ status: "SKIPPED", reason: "NO_RUN_RECORD" });
    expect(db.notificationPreference.findUnique).not.toHaveBeenCalled();
    expect(db.scannerRun.findUnique).not.toHaveBeenCalled();
  });
});

describe("both switches", () => {
  it("sends nothing, and writes nothing, with the Telegram master switch off", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ ...ON, telegramEnabled: false });

    expect(await report()).toEqual({ status: "SKIPPED", reason: "TELEGRAM_OFF" });
    expect(db.scannerRun.findUnique).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends nothing, and writes nothing, with the report switch off", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ ...ON, scanReport: false });

    expect(await report()).toEqual({ status: "SKIPPED", reason: "REPORT_OFF" });
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends nothing for an account that never saved a preference — both default off", async () => {
    db.notificationPreference.findUnique.mockResolvedValue(null);

    expect(await report()).toEqual({ status: "SKIPPED", reason: "TELEGRAM_OFF" });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("a channel that cannot deliver", () => {
  it("records FAILED, not sent, when the main bot is not connected", async () => {
    db.telegramConnection.findUnique.mockResolvedValue(null);

    expect(await report()).toEqual({ status: "FAILED", delivery: "NOT_SENT" });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.notification.update.mock.calls[0][0].data).toMatchObject({ status: "FAILED" });
  });

  it("records the failure when Telegram refuses the message", async () => {
    sendTelegramMessage.mockResolvedValue({ ok: false, error: "x", retryable: false, attempts: 1 });

    expect(await report()).toEqual({ status: "FAILED", delivery: "FAILED" });
  });

  it("never throws into the scanner", async () => {
    db.scannerRun.findUnique.mockRejectedValue(new Error("database unavailable"));

    await expect(report()).resolves.toEqual({ status: "ERROR" });
  });
});

describe("existing alerts are unaffected", () => {
  /** A Potential alert, as the lifecycle path produces it. */
  const potential: NotificationEvent = {
    type: "SETUP_DETECTED",
    userId: "user-1",
    priority: "MEDIUM",
    asset: "OPUSDT",
    timeframe: "H1",
    timestamp: STARTED.getTime(),
    dedupeKey: "setup-event:e1",
    setup: {
      setupId: "setup-1",
      lifecycleStatus: "POTENTIAL_SETUP",
      previousStatus: "CONFIRMATION_DETECTED",
      entryLow: 0.1138,
      entryHigh: 0.1148,
      stopLoss: 0.11162,
      takeProfit1: 0.1156,
      takeProfit2: 0.11713,
      riskReward: 1.61,
      riskRewardIsSynthetic: false,
      score: 74,
      scoreGrade: "GOOD",
      analysisStatus: "POTENTIAL_SETUP",
      trend: "BULLISH",
      mtfAgreement: null,
      supportLow: 0.1138,
      supportHigh: 0.1148,
      entryReason: "r",
      statusReason: "r",
      confirmationSignals: [],
      confirmationExplanation: null,
      invalidationReason: null,
      regime: null,
      isReplacement: false,
      replacementZoneLow: null,
      replacementZoneHigh: null,
      everConfirmed: true,
    },
    summary: null,
    systemError: null,
    entryZone: null,
  };

  it.each([true, false])(
    "pushes a Potential alert on the master switch alone, report switch %s",
    async (scanReport) => {
      db.notificationPreference.findUnique.mockResolvedValue({
        ...DEFAULT_PREFERENCES,
        telegramEnabled: true,
        scanReport,
      });

      await deliverEvents([potential]);

      const channels = db.notification.create.mock.calls.map((c) => c[0].data.channel);
      expect(channels).toEqual(["IN_APP", "TELEGRAM"]);
      expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a Potential alert off Telegram when the master switch is off, report switch on", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      telegramEnabled: false,
      scanReport: true,
    });

    await deliverEvents([potential]);

    const channels = db.notification.create.mock.calls.map((c) => c[0].data.channel);
    expect(channels).toEqual(["IN_APP"]);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("preferences before the migration is applied", () => {
  it("reads the other switches and keeps the report off when its column is missing", async () => {
    const stored = { ...DEFAULT_PREFERENCES, telegramEnabled: true, setupDetected: false };
    const { scanReport: _missing, ...withoutColumn } = { ...stored, scanReport: true };
    db.notificationPreference.findUnique
      .mockRejectedValueOnce(Object.assign(new Error("column does not exist"), { code: "P2022" }))
      .mockResolvedValueOnce(withoutColumn);

    const prefs = await getPreferences("user-1");

    expect(prefs).toEqual({ ...stored, scanReport: false });
    expect(db.notificationPreference.findUnique.mock.calls[1][0].select).not.toHaveProperty(
      "scanReport",
    );
  });

  it("still throws any other database error", async () => {
    db.notificationPreference.findUnique.mockRejectedValue(
      Object.assign(new Error("connection refused"), { code: "P1001" }),
    );

    await expect(getPreferences("user-1")).rejects.toThrow("connection refused");
  });
});
