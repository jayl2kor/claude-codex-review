/**
 * lock.ts — advisory-locked state file access + status/dirty/session updates,
 * Phase 3 of the Python->Bun migration (ccr-hook.py).
 *
 * Ported from ccr-hook.py: locked_state (749-760), write_status (763-775),
 * mark_dirty (778-791), clear_dirty (794-796), has_dirty (799-800),
 * ensure_session (706-736). default_state is reused from misc.ts.
 *
 * Lock mechanism divergence (accepted — see migration plan risk 1): Python uses
 * a blocking fcntl.flock(LOCK_EX) on state.lock, auto-released by the kernel on
 * fd close / process death. Bun/Node has no portable advisory flock, so this
 * uses a DIRECTORY lock (<root>/state.lock.d) — the race-free 0-dep primitive:
 *   - ACQUIRE is `mkdirSync` (atomic; EEXIST if held). The holder then writes
 *     its "<pid>:<nonce>" token to <dir>/owner with O_EXCL no-follow; that owner
 *     create is the final arbiter if two processes race the rare init window.
 *   - A live holder (owner PID alive via process.kill(pid,0)) is blocked behind,
 *     never stolen from.
 *   - A dead holder is reclaimed by atomically RENAMING the lock dir aside and
 *     removing it. This is race-free BY CONSTRUCTION: the dir's existence makes
 *     every other mkdir fail, so no live holder can occupy the slot while the
 *     dead dir is present — the renamed dir is guaranteed to be the dead one.
 *     (This is why the directory primitive replaced the earlier file+reaper
 *     design, whose unlink/detach of a file could race a fresh re-publish.)
 *
 * CROSS-RUNTIME BOUNDARY (accepted divergence D10): this governs concurrent
 * BUN holders only. It does NOT interoperate with Python's fcntl.flock — flock
 * state is invisible in the filesystem, and a portable flock binding is
 * unavailable with zero deps. This is safe because the migration replaces the
 * Python runtime wholesale in Phase 5; the Python hook and the Bun port never
 * run against the same root concurrently.
 *
 * Only the mutual-exclusion SEMANTICS are preserved; the resulting state.json
 * bytes are identical, and the lock dir's contents are internal.
 *
 * State/status/dirty/session JSON is byte-stable: objects are built in the same
 * key order as the Python dicts so writeJson (indent=2) output matches.
 *
 * Zero npm deps — node:fs / node:path / lib modules only.
 */

import {
  mkdirSync,
  rmdirSync,
  rmSync,
  statSync,
  readFileSync,
  unlinkSync,
  renameSync,
  linkSync,
  existsSync,
  realpathSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { loadJson, writeJson, appendJsonl, now, getOrNull, writeAllSync } from "./io";
import { defaultState } from "./misc";
import { sessionDir, workspaceId, surfaceId } from "./paths";
import { toolName } from "./tool";

// Per-process counter contributing to unique lock-token nonces.
let tempCounter = 0;

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}

function ignoreENOENT(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!isErrno(err, "ENOENT")) {
      throw err;
    }
  }
}

/** Synchronous sleep with zero dependencies (works in Bun and Node). */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal but performs
 * the existence/permission check: success or EPERM => alive; ESRCH => dead.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrno(err, "EPERM");
  }
}

// Tokens this process currently holds, keyed by lockPath. Used to (a) reject
// reentrant lockedState on the same root (which would otherwise deadlock or
// self-reclaim), and (b) ensure reclaim never unlinks a lock WE are holding,
// even though it bears our own PID.
const HELD_TOKENS = new Map<string, string>();

/** A unique per-acquisition token: "<pid>:<monotonic nonce>". */
function mintToken(): string {
  return `${process.pid}:${Date.now()}-${tempCounter++}`;
}

/** Extract the owner PID from a token, or null if unrecognized/empty. */
function holderPid(token: string): number | null {
  const m = /^(\d+):/.exec(token);
  return m ? Number(m[1]) : null;
}

// A lock-dir whose owner file has not appeared within this grace is treated as
// a holder that crashed between mkdir and the owner write (a sub-millisecond
// window in practice). The grace only affects how quickly such a rare crash is
// reclaimed — never safety, since the dir blocks all new acquirers meanwhile.
const LOCK_INIT_GRACE_MS = 1_000;

// The reclaim lock is held for only a handful of syscalls (no user code, no
// grace wait), so a reclaim lock older than this can only mean the reclaimer
// crashed — safe to steal by age. (This age-steal is sound HERE precisely
// because the hold time is bounded; it is NOT sound for the main lock, whose
// hold time is the variable lockedState critical section.)
const RECLAIM_STALE_MS = 5_000;

/** Read the owner token from a lock dir's owner file; null if absent/empty. */
function readOwner(ownerPath: string): string | null {
  try {
    const t = readFileSync(ownerPath, "utf-8").trim();
    return t === "" ? null : t;
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

/**
 * Reclaim a dead lock directory.
 *
 * Naively renaming `lockDir` aside is NOT race-free: a concurrent reclaimer can
 * remove the dead dir, a contender re-acquires (live) in the freed slot, and a
 * second reclaimer's rename — decided from a stale owner read — then moves that
 * fresh LIVE dir, double-acquiring and losing an update.
 *
 * Fix: serialize reclaim through an atomic `mkdir` reclaim-lock, and RE-READ the
 * owner under it immediately before renaming. While `lockDir` exists, no one can
 * `mkdir` it, so its owner cannot become live between the re-check and the
 * rename — the rename is guaranteed to hit a dead/owner-less dir. The reclaim
 * lock is microsecond-held, hence age-stealable if a reclaimer crashes.
 */
function reclaimDeadLock(lockDir: string): void {
  const reclaimDir = `${lockDir}.reclaim`;
  try {
    mkdirSync(reclaimDir);
  } catch (err) {
    if (!isErrno(err, "EEXIST")) {
      throw err;
    }
    // A reclaimer is active; steal only a crashed one (age-based), then back off.
    try {
      const st = statSync(reclaimDir);
      if (Date.now() - st.mtimeMs > RECLAIM_STALE_MS) {
        rmSync(reclaimDir, { recursive: true, force: true });
      }
    } catch (e) {
      if (!isErrno(e, "ENOENT")) {
        throw e;
      }
    }
    sleepSync(20);
    return; // the main loop retries
  }
  try {
    // Sole reclaimer: re-read the owner. lockDir still exists, so no one can
    // mkdir it — its owner cannot have just become live.
    const owner = readOwner(join(lockDir, "owner"));
    const pid = owner === null ? null : holderPid(owner);
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      return; // a live holder reacquired since the caller's read — nothing to do
    }
    const stale = `${lockDir}.stale.${randomBytes(8).toString("hex")}`;
    try {
      renameSync(lockDir, stale);
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        return; // already gone
      }
      throw err;
    }
    // Recursive remove handles `owner` plus any leftover private `.owner.tmp.*`
    // a publisher may have left after crashing mid-publish.
    rmSync(stale, { recursive: true, force: true });
  } finally {
    rmSync(reclaimDir, { recursive: true, force: true });
  }
}

/**
 * Acquire the directory lock at `lockDir`, returning our owner token.
 *
 * - ACQUIRE is `mkdirSync` (atomic; EEXIST if held). The owner token is then
 *   published ATOMICALLY: write it to a private temp INSIDE the dir, then
 *   linkSync it to <lockDir>/owner (create-if-absent). So `owner` only ever
 *   appears fully-written, never partial — and a write/close failure BEFORE the
 *   link leaves the dir owner-less (which self-heals via grace reclaim) rather
 *   than exposing a live PID we'd never release. linkSync EEXIST means a racer
 *   already owns it; linkSync ENOENT means our dir was reclaimed in a stall.
 * - A LIVE holder (owner PID alive) is blocked behind, never stolen from.
 * - A DEAD holder is reclaimed via reclaimDeadLock (see its race-freedom note);
 *   an owner-less dir is tolerated for LOCK_INIT_GRACE_MS before being treated
 *   as a crashed-during-init holder.
 */
function acquireLock(lockDir: string): string {
  if (HELD_TOKENS.has(lockDir)) {
    // Reentrant lockedState on the same root cannot be satisfied: blocking would
    // deadlock (we hold it ourselves) and reclaiming would break mutual
    // exclusion. Fail fast. (Python's flock would simply deadlock here.)
    throw new Error(`lockedState is not reentrant: this process already holds ${lockDir}`);
  }
  const ownerPath = join(lockDir, "owner");
  const myToken = mintToken();
  let emptySince = 0;
  for (;;) {
    let created = false;
    try {
      mkdirSync(lockDir);
      created = true;
    } catch (err) {
      if (!isErrno(err, "EEXIST")) {
        throw err;
      }
    }
    if (created) {
      // Publish the owner ATOMICALLY: full-write a private temp INSIDE the dir,
      // then linkSync it to `owner` (create-if-absent). `owner` thus appears
      // only fully-written; any failure BEFORE the link leaves the dir
      // owner-less (self-heals via reclaim) — never a partial/live owner we'd
      // fail to release. The private temp has a unique random name, so cleaning
      // it up is identity-safe (it can never be another holder's file).
      const ownerTmp = join(lockDir, `.owner.tmp.${randomBytes(8).toString("hex")}`);
      try {
        const fd = openSync(ownerTmp, "wx", 0o600);
        try {
          writeAllSync(fd, myToken);
        } finally {
          closeSync(fd);
        }
        linkSync(ownerTmp, ownerPath);
      } catch (err) {
        ignoreENOENT(() => unlinkSync(ownerTmp)); // identity-safe: our private temp only
        if (isErrno(err, "ENOENT") || isErrno(err, "EEXIST")) {
          continue; // dir reclaimed under us / a racer already linked owner
        }
        // Unexpected failure BEFORE the link: owner was never created, so the
        // dir is owner-less and self-heals via reclaim. Never path-clean it.
        throw err;
      }
      // linkSync succeeded => owner=myToken is committed. Record ownership
      // BEFORE the (fallible) temp cleanup so releaseLock always runs for us.
      HELD_TOKENS.set(lockDir, myToken);
      ignoreENOENT(() => unlinkSync(ownerTmp)); // drop our private temp; owner hardlink persists
      return myToken;
    }
    // Held — inspect the owner.
    const owner = readOwner(ownerPath);
    const pid = owner === null ? null : holderPid(owner);
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      // Live holder (a different process): block like flock and NEVER steal.
      emptySince = 0;
      sleepSync(20);
      continue;
    }
    if (owner === null) {
      // Owner not yet written: likely the holder's mkdir->owner-write window.
      // Treat as a crashed holder only after the grace elapses.
      const nowMs = Date.now();
      if (emptySince === 0) {
        emptySince = nowMs;
      }
      if (nowMs - emptySince < LOCK_INIT_GRACE_MS) {
        sleepSync(20);
        continue;
      }
    }
    // Dead PID, our own prior-run token, corrupt, or long-empty: reclaim.
    reclaimDeadLock(lockDir);
    emptySince = 0;
  }
}

function releaseLock(lockDir: string, token: string): void {
  // Remove only OUR lock. A reclaimer never touches a live holder's dir (its
  // owner PID is alive — us), so this read-then-remove is safe for the live
  // owner: nobody else can be removing it concurrently.
  if (HELD_TOKENS.get(lockDir) === token) {
    HELD_TOKENS.delete(lockDir);
  }
  if (readOwner(join(lockDir, "owner")) === token) {
    ignoreENOENT(() => unlinkSync(join(lockDir, "owner")));
    ignoreENOENT(() => rmdirSync(lockDir));
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Python `locked_state` (749-760), a contextmanager that loads state under an
 * exclusive lock, yields it for mutation, then writes it back and unlocks. The
 * TS shape is a higher-order function: the `mutate` callback plays the role of
 * the Python `with` block body.
 */
export function lockedState(
  root: string,
  mutate: (state: Record<string, unknown>) => void,
): void {
  mkdirSync(root, { recursive: true });
  // Canonicalize the root so that aliases of the SAME physical directory
  // (symlinks, relative paths, trailing slashes) collapse to ONE lock identity.
  // Otherwise HELD_TOKENS would be keyed by distinct strings and a nested call
  // via an alias would bypass the reentrancy guard and reclaim the live outer
  // lock. realpathSync is safe here: mkdirSync above guarantees root exists.
  const canonicalRoot = realpathSync(root);
  const lockDir = join(canonicalRoot, "state.lock.d");
  const statePath = join(canonicalRoot, "state.json");
  const token = acquireLock(lockDir);
  try {
    let state = loadJson<unknown>(statePath, defaultState());
    if (!isPlainObject(state)) {
      state = defaultState();
    }
    const obj = state as Record<string, unknown>;
    const ret = mutate(obj) as unknown;
    if (ret != null && typeof (ret as { then?: unknown }).then === "function") {
      // An async callback's Promise would be ignored, so state would be written
      // and the lock released before the mutation completes. Fail loudly.
      throw new TypeError(
        "lockedState(mutate) must be synchronous: an async callback's Promise is ignored before write/release",
      );
    }
    writeJson(statePath, obj);
  } finally {
    releaseLock(lockDir, token);
  }
}

/** Mirror Python dict.get(key, default): default only when the key is absent. */
function getDefault(obj: Record<string, unknown>, key: string, dflt: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

/**
 * Python `write_status` (763-775). Preserves an existing `last_report` object.
 * Key order: status, reason, updated_at, review_count, active_request,
 * last_completed, [last_report].
 */
export function writeStatus(
  root: string,
  state: Record<string, unknown>,
  status: string,
  reason: string = "",
): void {
  const existing = loadJson<unknown>(join(root, "status.json"), {});
  const data: Record<string, unknown> = {
    status,
    reason,
    updated_at: now(),
    review_count: getDefault(state, "review_count", 0),
    active_request: getOrNull(state, "active_request"),
    last_completed: getOrNull(state, "last_completed"),
  };
  if (isPlainObject(existing) && isPlainObject(existing.last_report)) {
    data.last_report = existing.last_report;
  }
  writeJson(join(root, "status.json"), data);
}

/**
 * Python `mark_dirty` (778-791). Writes the per-session dirty marker and appends
 * a "dirty" event. dirty.json key order: at, agent, role, event, tool_name,
 * turn_id.
 */
export function markDirty(
  root: string,
  inputData: Record<string, unknown>,
  agent: string,
  role: string,
): void {
  const sid = String(getOrNull(inputData, "session_id") || "");
  if (!sid) {
    return;
  }
  const dirty: Record<string, unknown> = {
    at: now(),
    agent,
    role,
    event: getOrNull(inputData, "hook_event_name"),
    tool_name: toolName(inputData),
    turn_id: getOrNull(inputData, "turn_id"),
  };
  writeJson(join(sessionDir(root, sid), "dirty.json"), dirty);
  appendJsonl(join(root, "events.jsonl"), { type: "dirty", ...dirty });
}

/** Python `clear_dirty` (794-796): unlink dirty.json, ignore if absent. */
export function clearDirty(root: string, sessionId: string): void {
  try {
    unlinkSync(join(sessionDir(root, sessionId), "dirty.json"));
  } catch (err) {
    if (!isErrno(err, "ENOENT")) {
      throw err;
    }
  }
}

/** Python `has_dirty` (799-800): does dirty.json exist? */
export function hasDirty(root: string, sessionId: string): boolean {
  return existsSync(join(sessionDir(root, sessionId), "dirty.json"));
}

/**
 * Python `ensure_session` (706-736). Upserts session.json (preserving created_at
 * and any other existing keys via {**existing, ...}) and appends a "hook" event.
 */
export function ensureSession(
  root: string,
  agent: string,
  role: string,
  inputData: Record<string, unknown>,
): void {
  const sid = String(getOrNull(inputData, "session_id") || "");
  const cwd = String(getOrNull(inputData, "cwd") || process.cwd());
  if (!sid) {
    return;
  }
  const sdir = sessionDir(root, sid);
  const existing = loadJson<Record<string, unknown>>(join(sdir, "session.json"), {});
  const createdAt = (isPlainObject(existing) ? existing.created_at : undefined) || now();
  const data: Record<string, unknown> = {
    ...(isPlainObject(existing) ? existing : {}),
    version: 1,
    agent,
    role,
    session_id: sid,
    cwd,
    workspace_id: workspaceId(),
    surface_id: surfaceId(),
    transcript_path: getOrNull(inputData, "transcript_path"),
    model: getOrNull(inputData, "model"),
    created_at: createdAt,
    updated_at: now(),
  };
  writeJson(join(sdir, "session.json"), data);
  appendJsonl(join(root, "events.jsonl"), {
    at: now(),
    type: "hook",
    agent,
    role,
    session_id: sid,
    event: getOrNull(inputData, "hook_event_name"),
  });
}
