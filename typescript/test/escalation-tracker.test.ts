import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  recordHttpResult,
  setOutageNotifier,
  clearOutageNotifier,
  resetOutageState,
  getConsecutiveFailures,
  isOutageActive,
  OUTAGE_MESSAGE,
  OUTAGE_THRESHOLD,
} from "../src/escalation/tracker.js";

describe("failure-escalation tracker", () => {
  let notifications: string[] = [];

  beforeEach(() => {
    resetOutageState();
    clearOutageNotifier();
    notifications = [];
  });

  afterEach(() => {
    resetOutageState();
    clearOutageNotifier();
  });

  it("threshold is 3 consecutive failures (per AC)", () => {
    expect(OUTAGE_THRESHOLD).toBe(3);
  });

  it("notifier fires once on the 3rd consecutive failure", () => {
    setOutageNotifier((m) => notifications.push(m));
    recordHttpResult(false);
    expect(notifications).toHaveLength(0);
    recordHttpResult(false);
    expect(notifications).toHaveLength(0);
    recordHttpResult(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe(OUTAGE_MESSAGE);
  });

  it("notifier does NOT re-fire while outage stays active", () => {
    setOutageNotifier((m) => notifications.push(m));
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(false);
    expect(notifications).toHaveLength(1);
  });

  it("any success resets the counter and clears outage state", () => {
    setOutageNotifier((m) => notifications.push(m));
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(true);
    expect(getConsecutiveFailures()).toBe(0);
    expect(isOutageActive()).toBe(false);

    // Threshold restarts from 0 — needs another 3 failures
    recordHttpResult(false);
    recordHttpResult(false);
    expect(notifications).toHaveLength(0);
    recordHttpResult(false);
    expect(notifications).toHaveLength(1);
  });

  it("after recovery (success), notifier can fire again on a fresh outage", () => {
    setOutageNotifier((m) => notifications.push(m));
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(false);
    expect(notifications).toHaveLength(1);
    recordHttpResult(true);
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(false);
    expect(notifications).toHaveLength(2);
  });

  it("with no notifier registered, recording is silent", () => {
    // No-op path — must not throw, must still track counter
    recordHttpResult(false);
    recordHttpResult(false);
    recordHttpResult(false);
    expect(getConsecutiveFailures()).toBeGreaterThanOrEqual(3);
  });

  it("notifier that throws does not propagate", () => {
    setOutageNotifier(() => {
      throw new Error("send failed");
    });
    expect(() => {
      recordHttpResult(false);
      recordHttpResult(false);
      recordHttpResult(false);
    }).not.toThrow();
  });

  it("OUTAGE_MESSAGE matches the spec phrasing (plan §6.3)", () => {
    expect(OUTAGE_MESSAGE).toMatch(/Artifacta API unreachable/);
    expect(OUTAGE_MESSAGE).toMatch(/connectivity is restored/);
  });
});
