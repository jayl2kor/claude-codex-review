/**
 * support.ts — `ccr-support`. Faithful port of ccr-hook.py command_support
 * (3047-3129): write a shareable diagnostic bundle (doctor.json, version,
 * status/state, events tail, optional session payloads) as a .zip + a manifest.
 *
 * DIVERGENCE (documented): Python uses zipfile ZIP_DEFLATED; this writes a valid
 * but STORED (uncompressed) .zip with a fixed timestamp — zero-dep, openable by
 * any unzip/zipfile. The bundle BYTES therefore differ from Python's, but the
 * printed path, messages, and the manifest/contents file LIST match byte-for-byte
 * (the oracle test compares stdout, not the archive bytes).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readText, now } from "../lib/io";
import { rootForCwd, sessionDir, CONFIG_ROOT } from "../lib/paths";
import { latestSessionId } from "../lib/report";
import { cpCompare, splitlines } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { doctorDoc } from "./doctor";
import { out } from "./shared";

// ---- minimal STORED zip writer (zero-dep) ---------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function buildZipStored(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const crc = crc32(e.data);
    const size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // STORED
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12); // fixed 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 30); // extra(2)+comment(2) len = 0
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + e.data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
// ---------------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function commandSupport(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  mkdirSync(root, { recursive: true });
  const supportDir = join(root, "support");
  mkdirSync(supportDir, { recursive: true });

  const sid = args.session || latestSessionId(root) || "";
  const stamp = now().replace(/[-:]/g, "").replace(/(\d{8})T(\d{6})Z/, "$1T$2Z"); // %Y%m%dT%H%M%SZ
  const bundlePath = join(supportDir, `ccr-support-${stamp}.zip`);
  const includePayloads = Boolean(args.include_diffs);
  const filesAdded: string[] = [];
  const entries: { name: string; data: Buffer }[] = [];

  const addText = (arcname: string, text: string): void => {
    entries.push({ name: arcname, data: Buffer.from(text, "utf-8") });
    filesAdded.push(arcname);
  };
  const addFile = (path: string, arcname: string): void => {
    if (!isFile(path)) {
      return;
    }
    try {
      entries.push({ name: arcname, data: readFileSync(path) });
      filesAdded.push(arcname);
    } catch {
      /* OSError -> skip */
    }
  };

  const { code: doctorRc, doc: doctorDocObj } = doctorDoc(cwd);
  addText("doctor.json", JSON.stringify(doctorDocObj, null, 2) + "\n");
  addText("version.txt", readText(join(CONFIG_ROOT, "VERSION")) || "unknown\n");

  for (const name of ["status.json", "state.json"]) {
    addFile(join(root, name), name);
  }

  const eventsPath = join(root, "events.jsonl");
  if (isFile(eventsPath)) {
    try {
      const lines = splitlines(readFileSync(eventsPath, "utf-8"));
      addText("events-tail.jsonl", lines.slice(-200).join("\n") + (lines.length ? "\n" : ""));
    } catch {
      /* OSError -> skip */
    }
  }

  if (sid) {
    const sdir = sessionDir(root, sid);
    addFile(join(sdir, "session.json"), `sessions/${sid}/session.json`);
    if (includePayloads) {
      addFile(join(sdir, "report.md"), `sessions/${sid}/report.md`);
    }
    const roundsDir = join(sdir, "rounds");
    let roundNames: string[] = [];
    try {
      roundNames = readdirSync(roundsDir).filter((n) => {
        try {
          return statSync(join(roundsDir, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      roundNames = [];
    }
    roundNames.sort(cpCompare);
    for (const rname of roundNames) {
      const rdir = join(roundsDir, rname);
      const prefix = `sessions/${sid}/rounds/${rname}`;
      addFile(join(rdir, "decision.json"), `${prefix}/decision.json`);
      if (includePayloads) {
        for (const name of ["request.md", "diff.patch", "delta.patch", "worker-followup.md", "review.md"]) {
          addFile(join(rdir, name), `${prefix}/${name}`);
        }
      }
    }
  }

  const manifest = {
    version: 1,
    created_at: now(),
    cwd,
    ccr_root: root,
    session: sid || null,
    doctor_exit_code: doctorRc,
    include_payloads: includePayloads,
    note: "Default bundles exclude request/review/diff payloads. Re-run with --include-diffs when sharing code payloads is acceptable.",
    files: [...filesAdded, "manifest.json"].sort(cpCompare),
  };
  entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8") });

  writeFileSync(bundlePath, buildZipStored(entries));

  out(bundlePath);
  out("Created CCR support bundle.");
  if (includePayloads) {
    out("Included review request, review, and diff payload files.");
  } else {
    out("Payload files excluded. Re-run with `ccr-support --include-diffs` only when sharing code/review content is acceptable.");
  }
  if (args.print_body) {
    out("Contents:");
    for (const name of [...filesAdded, "manifest.json"].sort(cpCompare)) {
      out(`  ${name}`);
    }
  }
  return 0;
}
