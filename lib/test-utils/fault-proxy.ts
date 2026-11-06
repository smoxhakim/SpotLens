import net from "node:net";

/**
 * Real connection faults, on real connections, at a chosen point of a real statement.
 *
 * A TCP proxy between Prisma and the test's throwaway PostgreSQL that reads just enough
 * of the wire protocol to recognise a lifecycle transaction (its advisory lock), a
 * pass's results (their insert) and a COMMIT. So a test can say "cut the second market
 * after its COMMIT was applied but before its answer came back", which no mock can do
 * honestly: Prisma has to raise whatever it really raises.
 *
 * It only ever connects to the one port it was given, on this machine.
 */

/** A fault on one lifecycle transaction. */
export type LifecycleFault =
  | "BODY" //            connection cut at the advisory lock: nothing written
  | "BEFORE_COMMIT" //   COMMIT never reaches the server: nothing written
  | "AFTER_COMMIT" //    COMMIT is applied, its answer is lost
  | "HOLD_COMMIT" //     the client is cut, and COMMIT lands `holdMs` later
  | "BLACKHOLE" //       the client is cut, and the server's transaction is left open
  | "PERMANENT"; //      the lock call is redirected to one that raises a real 42P01

const APPLICATION_PORT = 5432;

/** The server's CommandComplete for a COMMIT: proof it was applied. */
const COMMIT_ANSWERED = Buffer.from("COMMIT\0", "latin1");

export class FaultProxy {
  /** Chosen by the OS on first start, and kept across a stop and a restart. */
  port = 0;
  /** Lifecycle transactions seen so far. A plan is keyed on this count, from 1. */
  lifecycleCount = 0;
  plan = new Map<number, LifecycleFault>();
  /** A fault on the transaction that saves a pass's results. */
  finishFault: "BEFORE_COMMIT" | "AFTER_COMMIT" | null = null;
  /** Every fault that actually fired, so a test can prove its fault happened. */
  fired: { mode: string; index: number }[] = [];
  holdMs = 3000;
  /** When the lifecycle count reaches this, stop for the rest of the pass. */
  outageAt: number | null = null;
  /** Cut the connection on the Notification insert after skipping this many. */
  cutNotificationAfter: number | null = null;

  private server: net.Server | null = null;
  private readonly conns = new Set<net.Socket>();

  constructor(readonly targetPort: number) {
    if (targetPort === APPLICATION_PORT) {
      throw new Error("Refusing to forward to the application's database port.");
    }
  }

  planNext(mode: LifecycleFault) {
    this.plan.set(this.lifecycleCount + 1, mode);
  }

  async start() {
    if (this.server) return;
    const server = net.createServer((client) => this.handle(client));
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  /** The port refuses connections and every open one is cut: what a stopped database looks like. */
  async stop() {
    const server = this.server;
    this.server = null;
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(client: net.Socket) {
    const upstream = net.connect(this.targetPort, "127.0.0.1");
    this.conns.add(client);
    this.conns.add(upstream);
    const state = {
      started: false,
      buffer: Buffer.alloc(0),
      lifecycle: null as number | null,
      savingResults: false,
      killOnReply: false,
      replyTail: Buffer.alloc(0),
      clientGone: false,
    };
    const killBoth = () => {
      client.destroy();
      upstream.destroy();
    };

    upstream.on("data", (data) => {
      if (state.killOnReply) {
        // COMMIT's own answer, and nothing earlier. The client closes dropped statements
        // without waiting, so a reply to one of those can arrive first. Cutting on that
        // would lose the commit itself, and "commit landed, answer lost" would be false.
        const seen = Buffer.concat([state.replyTail, data]);
        if (seen.includes(COMMIT_ANSWERED)) {
          killBoth();
          return;
        }
        state.replyTail = seen.subarray(-COMMIT_ANSWERED.length);
      }
      if (!state.clientGone) client.write(data);
    });
    client.on("close", () => {
      this.conns.delete(client);
      if (!state.clientGone) upstream.destroy();
    });
    upstream.on("close", () => {
      this.conns.delete(upstream);
      client.destroy();
    });
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);

    client.on("data", (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (;;) {
        // The startup packet has no type byte, and SSLRequest is one that does not start it.
        if (!state.started) {
          if (state.buffer.length < 8) return;
          const length = state.buffer.readInt32BE(0);
          if (state.buffer.length < length) return;
          const message = state.buffer.subarray(0, length);
          state.buffer = state.buffer.subarray(length);
          if (message.readInt32BE(4) !== 80877103) state.started = true;
          upstream.write(message);
          continue;
        }

        if (state.buffer.length < 5) return;
        const length = state.buffer.readInt32BE(1);
        if (state.buffer.length < length + 1) return;
        const message = state.buffer.subarray(0, length + 1);
        state.buffer = state.buffer.subarray(length + 1);

        const type = String.fromCharCode(message[0]);
        let sql = "";
        if (type === "Q") sql = message.subarray(5, message.length - 1).toString("latin1");
        if (type === "P") sql = message.subarray(5).toString("latin1").split("\0")[1] ?? "";

        if (/pg_advisory_xact_lock/.test(sql)) {
          this.lifecycleCount += 1;
          state.lifecycle = this.lifecycleCount;

          if (this.outageAt !== null && this.lifecycleCount >= this.outageAt) {
            this.fired.push({ mode: "OUTAGE", index: this.lifecycleCount });
            this.outageAt = null;
            void this.stop();
            return;
          }
          const planned = this.plan.get(this.lifecycleCount);
          if (planned === "PERMANENT") {
            this.fired.push({ mode: "PERMANENT", index: this.lifecycleCount });
            const rewritten = Buffer.from(
              message.toString("latin1").replace("pg_advisory_xact_lock", "test_poison_lock"),
              "latin1",
            );
            rewritten.writeInt32BE(rewritten.length - 1, 1);
            upstream.write(rewritten);
            continue;
          }
          if (planned === "BODY") {
            this.fired.push({ mode: "BODY", index: this.lifecycleCount });
            killBoth();
            return;
          }
        }

        if (/INSERT INTO "public"\."ScannerResult"/.test(sql)) state.savingResults = true;

        if (
          this.cutNotificationAfter !== null &&
          /INSERT INTO "public"\."Notification"/.test(sql)
        ) {
          if (this.cutNotificationAfter === 0) {
            this.cutNotificationAfter = null;
            this.fired.push({ mode: "NOTIF_INSERT", index: -1 });
            killBoth();
            return;
          }
          this.cutNotificationAfter -= 1;
        }

        if (sql.trim().toUpperCase() === "COMMIT") {
          const index = state.lifecycle;
          const mode = index !== null ? this.plan.get(index) : undefined;
          state.lifecycle = null;

          if (mode === "BEFORE_COMMIT") {
            this.fired.push({ mode, index: index! });
            killBoth();
            return;
          }
          if (mode === "AFTER_COMMIT") {
            this.fired.push({ mode, index: index! });
            state.killOnReply = true;
          }
          if (mode === "HOLD_COMMIT") {
            this.fired.push({ mode, index: index! });
            state.clientGone = true;
            client.destroy();
            const held = Buffer.from(message);
            setTimeout(() => {
              state.killOnReply = true;
              upstream.write(held);
            }, this.holdMs);
            return;
          }
          if (mode === "BLACKHOLE") {
            this.fired.push({ mode, index: index! });
            state.clientGone = true;
            client.destroy();
            return;
          }
          if (state.savingResults && this.finishFault) {
            const fault = this.finishFault;
            this.finishFault = null;
            this.fired.push({ mode: `FINISH_${fault}`, index: -1 });
            if (fault === "BEFORE_COMMIT") {
              killBoth();
              return;
            }
            state.killOnReply = true;
          }
          state.savingResults = false;
        }

        if (sql.trim().toUpperCase() === "ROLLBACK") {
          state.lifecycle = null;
          state.savingResults = false;
        }

        upstream.write(message);
      }
    });
  }
}
