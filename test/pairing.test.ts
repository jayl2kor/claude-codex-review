/**
 * pairing.test.ts — unit coverage for the pure surface-pairing decision that
 * drives auto re-pairing (healPairing) and the manual ccr-repair command. The
 * IO-bound enumeration (liveSurfaceIds) and registration writes are exercised
 * end-to-end elsewhere; this pins the decision matrix.
 */
import { test, expect, describe } from "bun:test";
import { decidePairing, parseIdentifyCaller, type PairingAction } from "../src/lib/cmux";

const CUR = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const OTHER = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

describe("decidePairing", () => {
  const cases: Array<[string, string, string, boolean | null, PairingAction]> = [
    ["no current surface id is a no-op", "", OTHER, false, "noop"],
    ["already registered to current is a no-op", CUR, CUR, null, "noop"],
    ["unset registration claims current", CUR, "", null, "register-unset"],
    ["dead registration re-pairs to current", CUR, OTHER, false, "repair-dead"],
    ["live different registration refuses (no hijack)", CUR, OTHER, true, "refuse-live"],
    ["unverifiable registration is left alone", CUR, OTHER, null, "unknown-liveness"],
  ];
  for (const [name, current, registered, regAlive, expected] of cases) {
    test(name, () => {
      expect(decidePairing(current, registered, regAlive)).toBe(expected);
    });
  }

  test("current==registered wins even when liveness says dead (no redundant rewrite)", () => {
    expect(decidePairing(CUR, CUR, false)).toBe("noop");
  });
});

describe("parseIdentifyCaller", () => {
  // Mirrors real `cmux identify --id-format uuids`: caller block precedes focused.
  const real = JSON.stringify({
    caller: { surface_id: CUR, workspace_id: "WS-CALLER", surface_type: "terminal" },
    focused: { surface_id: OTHER, workspace_id: "WS-FOCUSED" },
    socket_path: "/tmp/cmux.sock",
  });

  test("extracts the caller surface/workspace, not focused", () => {
    expect(parseIdentifyCaller(real)).toEqual({ surface: CUR, workspace: "WS-CALLER" });
  });

  test("malformed JSON -> null", () => {
    expect(parseIdentifyCaller("not json")).toBeNull();
    expect(parseIdentifyCaller("")).toBeNull();
  });

  test("missing caller block -> null", () => {
    expect(parseIdentifyCaller(JSON.stringify({ focused: { surface_id: OTHER } }))).toBeNull();
  });

  test("caller without surface_id -> null (can't trust it)", () => {
    expect(parseIdentifyCaller(JSON.stringify({ caller: { workspace_id: "WS" } }))).toBeNull();
  });
});
