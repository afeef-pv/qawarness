import { expect, test } from "bun:test";
import { dashboardStatus } from "./server";

test("dashboard treats an overdue unfinished run as interrupted", () => {
  const startedAt = new Date("2026-09-28T09:45:50.336Z");
  const run = { status: "running", startedAt, limits: { maxDurationMs: 90 * 60_000 } };
  expect(dashboardStatus(run, startedAt.getTime() + 90 * 60_000)).toBe("running");
  expect(dashboardStatus(run, startedAt.getTime() + 96 * 60_000)).toBe("interrupted");
  const heartbeat = { ...run, heartbeatAt: new Date(startedAt.getTime() + 60_000) };
  expect(dashboardStatus(heartbeat, startedAt.getTime() + 2 * 60_000)).toBe("running");
  expect(dashboardStatus(heartbeat, startedAt.getTime() + 4 * 60_000)).toBe("interrupted");
  expect(dashboardStatus({ ...run, status: "passed" }, startedAt.getTime() + 96 * 60_000)).toBe("passed");
});
