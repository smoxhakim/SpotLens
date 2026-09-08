import { describe, expect, it } from "vitest";

import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("Correct horse battery staple", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(hash).not.toContain("hunter2");
    expect(hash.startsWith("$2")).toBe(true);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password here");
    const b = await hashPassword("same password here");

    expect(a).not.toBe(b);
    await expect(verifyPassword("same password here", a)).resolves.toBe(true);
    await expect(verifyPassword("same password here", b)).resolves.toBe(true);
  });

  it("requires a length that actually resists guessing", () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
  });
});
