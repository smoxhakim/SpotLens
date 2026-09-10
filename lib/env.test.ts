import { describe, expect, it } from "vitest";

import { validateEnv } from "./env";

const base = { NODE_ENV: "production", AUTH_SECRET: "s".repeat(32) } as NodeJS.ProcessEnv;

describe("validateEnv", () => {
  it("accepts a development environment with nothing configured", () => {
    const report = validateEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(true);
    // It should still say what will not work.
    expect(report.warnings.join(" ")).toMatch(/DATABASE_URL/);
  });

  it("refuses production without an auth secret", () => {
    const report = validateEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@db.example.com/x",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/AUTH_SECRET/);
  });

  it("refuses production without a database", () => {
    const report = validateEnv(base);

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/DATABASE_URL/);
  });

  it("refuses a localhost database in production", () => {
    const report = validateEnv({
      ...base,
      DATABASE_URL: "postgresql://u:p@localhost:5432/x",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/localhost/);
  });

  it("accepts a complete production environment", () => {
    const report = validateEnv({
      ...base,
      DATABASE_URL: "postgresql://u:p@db.example.com/x",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(true);
  });

  it("warns when a pooled url has no direct url for migrations", () => {
    const report = validateEnv({
      ...base,
      DATABASE_URL: "postgresql://u:p@ep-x-pooler.eu-west-2.aws.neon.tech/db",
    } as NodeJS.ProcessEnv);

    expect(report.warnings.join(" ")).toMatch(/DIRECT_URL/);
  });

  it("rejects a malformed url outright", () => {
    const report = validateEnv({ ...base, DATABASE_URL: "not-a-url" } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(false);
  });

  it("treats a blank optional variable as unset rather than invalid", () => {
    // `UPSTASH_REDIS_REST_URL=` on its own line is how a placeholder is
    // usually left behind, and it used to fail the whole boot in production.
    const report = validateEnv({
      ...base,
      DATABASE_URL: "postgresql://u:p@db.example.com/x",
      UPSTASH_REDIS_REST_URL: "",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/No Upstash configured/);
  });

  it("still rejects a non-empty malformed url", () => {
    const report = validateEnv({
      ...base,
      DATABASE_URL: "postgresql://u:p@db.example.com/x",
      UPSTASH_REDIS_REST_URL: "   not-a-url",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(false);
  });
});
