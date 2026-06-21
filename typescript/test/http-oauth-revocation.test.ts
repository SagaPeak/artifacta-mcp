// AG-10 — revocation store unit tests.
//
// Revoking (client_id, tenant_id) invalidates tokens issued at or before the
// cutoff; tokens issued after it still validate. Storage is an in-process Map
// (single-instance deploy — see src/http/revocation.ts). The end-to-end
// revocation-through-the-verifier behavior is exercised in test/http-oauth.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  revokeConnection,
  isRevoked,
  clearRevocations,
} from "../src/http/revocation.js";

const CLIENT = "mcp-client-abc";
const TENANT = "tenant-123";

beforeEach(() => {
  clearRevocations();
});

describe("AG-10 revocation store", () => {
  it("a pair with no revocation is never revoked", () => {
    expect(isRevoked(CLIENT, TENANT, 1000)).toBe(false);
  });

  it("revoking invalidates older and at-cutoff tokens but not strictly-newer ones", () => {
    revokeConnection(CLIENT, TENANT, 1500);
    // Issued before the cutoff → revoked.
    expect(isRevoked(CLIENT, TENANT, 1000)).toBe(true);
    // Issued AT the cutoff → revoked (inclusive boundary, fail-closed). This is
    // the finding-#5 fix: the contract says "at or before the cutoff are revoked".
    expect(isRevoked(CLIENT, TENANT, 1500)).toBe(true);
    // Issued strictly after the cutoff → still valid.
    expect(isRevoked(CLIENT, TENANT, 1501)).toBe(false);
    expect(isRevoked(CLIENT, TENANT, 2000)).toBe(false);
  });

  it("revocation is scoped to the exact (client_id, tenant_id) pair", () => {
    revokeConnection(CLIENT, TENANT, 1500);
    expect(isRevoked("other-client", TENANT, 1000)).toBe(false);
    expect(isRevoked(CLIENT, "other-tenant", 1000)).toBe(false);
  });

  it("is monotonic — a later cutoff widens, an earlier one is ignored", () => {
    revokeConnection(CLIENT, TENANT, 2000);
    revokeConnection(CLIENT, TENANT, 1000); // earlier — ignored
    expect(isRevoked(CLIENT, TENANT, 1500)).toBe(true); // still revoked by the 2000 cutoff
    revokeConnection(CLIENT, TENANT, 3000); // later — widens
    expect(isRevoked(CLIENT, TENANT, 2500)).toBe(true);
  });

  it("a token without an iat fails closed once a revocation exists", () => {
    expect(isRevoked(CLIENT, TENANT, undefined)).toBe(false); // no revocation yet
    revokeConnection(CLIENT, TENANT, 1500);
    expect(isRevoked(CLIENT, TENANT, undefined)).toBe(true);
  });

  it("defaults the cutoff to now when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    revokeConnection(CLIENT, TENANT);
    // A token issued well in the past is revoked; one issued comfortably in the
    // future is not.
    expect(isRevoked(CLIENT, TENANT, before - 100)).toBe(true);
    expect(isRevoked(CLIENT, TENANT, before + 100)).toBe(false);
  });
});
