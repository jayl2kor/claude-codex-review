/**
 * repair.ts — `ccr-repair`. Manually (re-)pair the current cmux surface for CCR
 * after a surface was closed and reopened (which mints a fresh CMUX_SURFACE_ID
 * and leaves the old registration stale). Registers THIS surface as the chosen
 * role, inferring the role when only one slot is free/dead, and refuses to take
 * over a registration that still points at a live surface unless --force.
 *
 * The automatic counterpart runs inside the SessionStart hook (healPairing);
 * this command is the explicit escape hatch for pairing a deliberately different
 * surface or overriding a duplicate.
 */
import type { CcrArgs } from "../lib/args";
import { workspaceId, surfaceId } from "../lib/paths";
import { roleForCurrentSurface, surfaceForRole, registerSurface, liveSurfaceIds, isSurfaceLive } from "../lib/cmux";
import { isAgentRole, opposite } from "../lib/text";
import { out, err } from "./shared";

const ROLES = ["claude", "codex"];

export function commandRepair(args: CcrArgs): number {
  if (!workspaceId()) {
    err("Not inside a cmux workspace (CMUX_WORKSPACE_ID unset).");
    return 1;
  }
  const current = surfaceId();
  if (!current) {
    err("No CMUX_SURFACE_ID — run ccr-repair from inside the cmux surface you want to pair.");
    return 1;
  }

  // One enumeration, reused for role inference, the live-registration guard, and
  // the partner report. null means "couldn't verify" (treated as not-dead).
  const live = liveSurfaceIds();
  const aliveOf = (id: string): boolean | null => isSurfaceLive(id, live);

  // Resolve the target role: explicit --role, else this surface's existing
  // registration, else the single free-or-dead slot.
  let role = args.role && isAgentRole(args.role) ? args.role : roleForCurrentSurface();
  if (!isAgentRole(role)) {
    const claimable = ROLES.filter((r) => {
      const reg = surfaceForRole(r);
      return !reg || aliveOf(reg) === false;
    });
    if (claimable.length === 1) {
      role = claimable[0]!;
    } else {
      err("Could not infer the role for this surface; pass --role claude|codex.");
      return 1;
    }
  }

  // Safety: never silently steal a role that still points at a different, live
  // surface (that would be a duplicate same-role session).
  const reg = surfaceForRole(role);
  if (reg && reg !== current && aliveOf(reg) === true && !args.force) {
    err(`${role} is already paired to a live surface (${reg}). Re-run with --force to take over.`);
    return 1;
  }

  registerSurface(role, current);
  out(`Paired this surface as ${role}: ${current}`);

  // Report partner state so the user knows whether the loop is whole again.
  const other = opposite(role);
  const otherReg = surfaceForRole(other);
  if (!otherReg) {
    out(`Partner (${other}) is not registered yet — run cmux-setup-${other} or ccr-repair in that surface.`);
  } else if (aliveOf(otherReg) === false) {
    out(`Partner (${other}) surface ${otherReg} appears to be gone — restart it or run ccr-repair there to complete the pair.`);
  } else {
    out(`Partner (${other}) surface: ${otherReg}.`);
  }
  return 0;
}
