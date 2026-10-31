import { describe, expect, it } from "vitest";

import { EXIT_REASONS } from "@/app/api/journal/validation";
import { toLocalInput } from "@/features/decision/components/LateEntryForm";

import {
  EXIT_REASON_LABELS,
  outcomeFormFrom,
  outcomeRequest,
  type RecordedTrade,
} from "./outcome-form";

/**
 * The trade form's mapping to and from the stored trade.
 *
 * The save replaces the whole trade, so the form must send back everything it
 * holds, unchanged unless the user changed it, and leave a blank blank. Times
 * are typed as the reader's local wall clock; every expectation is built from
 * the instant it means, so the suite passes in any time zone.
 */

const FILL = Date.parse("2026-10-31T10:00:42Z");
const CLOSE = Date.parse("2026-10-31T16:20:05Z");

const RECORDED: RecordedTrade = {
  actualEntry: 101.5,
  actualStopLoss: 96.5,
  actualTakeProfit: 110,
  actualExit: 110,
  quantity: 0.19,
  fees: 0.04,
  slippage: 0.01,
  exitReason: "TAKE_PROFIT",
  openedAt: "2026-10-31T10:00:42.250Z",
  closedAt: "2026-10-31T16:20:05.000Z",
};

function body(result: ReturnType<typeof outcomeRequest>) {
  if (!result.ok) throw new Error(result.message);
  return result.body;
}

describe("a new trade", () => {
  it("starts blank, with nothing taken from the plan or the clock", () => {
    expect(outcomeFormFrom(null)).toEqual({
      actualEntry: "",
      actualStopLoss: "",
      actualTakeProfit: "",
      actualExit: "",
      quantity: "",
      fees: "",
      exitReason: "",
      openedAt: "",
      closedAt: "",
    });
  });

  it("records the fill time to the second, as the instant the local time names", () => {
    const form = {
      ...outcomeFormFrom(null),
      actualEntry: "101.5",
      actualStopLoss: "96.5",
      actualTakeProfit: "110",
      quantity: "0.19",
      openedAt: toLocalInput(FILL),
    };
    expect(body(outcomeRequest(form, null, false))).toEqual({
      actualEntry: 101.5,
      actualStopLoss: 96.5,
      actualTakeProfit: 110,
      quantity: 0.19,
      openedAt: FILL,
      close: false,
    });
  });

  it("sends a closed trade's exit, close time and reason", () => {
    const form = {
      ...outcomeFormFrom(null),
      actualEntry: "101.5",
      actualStopLoss: "96.5",
      actualExit: "96.2",
      quantity: "0.19",
      fees: "0.04",
      exitReason: "STOP_LOSS",
      openedAt: toLocalInput(FILL),
      closedAt: toLocalInput(CLOSE),
    };
    expect(body(outcomeRequest(form, null, true))).toMatchObject({
      actualExit: 96.2,
      exitReason: "STOP_LOSS",
      openedAt: FILL,
      closedAt: CLOSE,
      close: true,
    });
  });

  it("leaves every blank field out, so it is stored as unknown", () => {
    const form = { ...outcomeFormFrom(null), actualEntry: "101.5", quantity: "0.19" };
    expect(body(outcomeRequest(form, null, false))).toEqual({
      actualEntry: 101.5,
      quantity: 0.19,
      close: false,
    });
  });
});

describe("saving a recorded trade again", () => {
  it("sends back every stored value unchanged — slippage and recorded milliseconds included", () => {
    const form = outcomeFormFrom(RECORDED);
    expect(form.openedAt).toBe(toLocalInput(Date.parse(RECORDED.openedAt!)));

    expect(body(outcomeRequest(form, RECORDED, false))).toEqual({
      actualEntry: 101.5,
      actualStopLoss: 96.5,
      actualTakeProfit: 110,
      actualExit: 110,
      quantity: 0.19,
      fees: 0.04,
      slippage: 0.01,
      exitReason: "TAKE_PROFIT",
      openedAt: Date.parse("2026-10-31T10:00:42.250Z"),
      closedAt: CLOSE,
      close: false,
    });
  });

  it("keeps the fill time of a partial fill when the rest of the order fills later", () => {
    const partial: RecordedTrade = {
      ...RECORDED,
      actualExit: null,
      exitReason: null,
      closedAt: null,
      quantity: 0.095,
    };
    const form = { ...outcomeFormFrom(partial), quantity: "0.19" };

    const sent = body(outcomeRequest(form, partial, false));
    expect(sent.quantity).toBe(0.19);
    expect(sent.openedAt).toBe(Date.parse(partial.openedAt!));
    expect(sent.actualTakeProfit).toBe(110);
    expect(sent).not.toHaveProperty("actualExit");
    expect(sent).not.toHaveProperty("exitReason");
    expect(sent).not.toHaveProperty("closedAt");
  });

  it("treats a time a browser shows without its zero seconds as untouched", () => {
    const recorded = { ...RECORDED, openedAt: "2026-10-31T10:00:00.500Z" };
    const shown = toLocalInput(Date.parse(recorded.openedAt)).slice(0, 16);
    const form = { ...outcomeFormFrom(recorded), openedAt: shown };

    expect(body(outcomeRequest(form, recorded, false)).openedAt).toBe(
      Date.parse(recorded.openedAt),
    );
  });

  it("records a corrected time as the new instant", () => {
    const corrected = FILL + 3 * 60_000;
    const form = { ...outcomeFormFrom(RECORDED), openedAt: toLocalInput(corrected) };
    expect(body(outcomeRequest(form, RECORDED, false)).openedAt).toBe(corrected);
  });

  it("clears a field only when the user blanks it", () => {
    const form = { ...outcomeFormFrom(RECORDED), exitReason: "", closedAt: "" };
    const sent = body(outcomeRequest(form, RECORDED, false));
    expect(sent).not.toHaveProperty("exitReason");
    expect(sent).not.toHaveProperty("closedAt");
    expect(sent.openedAt).toBe(Date.parse(RECORDED.openedAt!));
  });
});

describe("a time that does not read as one", () => {
  it("stops the save rather than clearing the time", () => {
    const form = { ...outcomeFormFrom(RECORDED), openedAt: "31/10/2026 10:00" };
    expect(outcomeRequest(form, RECORDED, false)).toEqual({
      ok: false,
      message: "The fill time is not a valid time.",
    });
    expect(
      outcomeRequest({ ...outcomeFormFrom(RECORDED), closedAt: "later" }, RECORDED, true),
    ).toMatchObject({ ok: false, message: "The close time is not a valid time." });
  });
});

describe("exit reasons", () => {
  it("offers exactly the reasons the API accepts", () => {
    expect(Object.keys(EXIT_REASON_LABELS).sort()).toEqual([...EXIT_REASONS].sort());
  });
});
