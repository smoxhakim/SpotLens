// Loaded into a real scanner process under test, with node's --import.
//
// Nothing but this machine can be reached by fetch, so no exchange and no Telegram,
// whatever the environment holds. And the process never outlives the test that
// started it: a test runner killed outright cannot clean up after itself, so the
// child notices its parent is gone and exits. The timer does not hold it open.
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "127.0.0.1") throw new Error(`blocked: ${url.hostname}`);
  return real(input, init);
};

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(99);
}, 1000).unref();
