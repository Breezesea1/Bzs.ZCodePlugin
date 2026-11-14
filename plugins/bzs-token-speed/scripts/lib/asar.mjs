// Minimal asar reader/writer: enough to inspect or replace one file inside an
// archive without unpacking the rest. Layout (chromium asar disk format):
//   [u32=4][u32 pickleSize][u32 payloadSize][u32 jsonLen][JSON][file bytes...]
// File offsets are relative to the first byte after the header.
import {
  openSync,
  readSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

const BLOCK_SIZE = 4194304; // asar integrity block size used by Electron
const ALIGN = 4; // header pickle payloads are 4-byte aligned

function parseHeader(buf) {
  const pickleSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const jsonStart = 16;
  const header = JSON.parse(buf.toString("utf8", jsonStart, jsonStart + jsonLen));
  return { header, headerSize: 8 + pickleSize };
}

function walkFiles(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walkFiles(entry, path, out);
    else out.push({ path, entry });
  }
  return out;
}

function collectFiles(node, out) {
  for (const entry of Object.values(node.files ?? {})) {
    if (entry.files) collectFiles(entry, out);
    else out.push({ entry });
  }
  return out;
}

function nodeAt(header, innerPath) {
  let node = header;
  for (const part of innerPath.split("/")) {
    node = node.files?.[part];
    if (!node) return null;
  }
  return node;
}

export function integrityFor(payload) {
  const hash = createHash("sha256").update(payload).digest("hex");
  const blocks = [];
  for (let i = 0; i < payload.length; i += BLOCK_SIZE) {
    blocks.push(
      createHash("sha256").update(payload.subarray(i, i + BLOCK_SIZE)).digest("hex")
    );
  }
  return {
    algorithm: "SHA256",
    hash,
    blockSize: BLOCK_SIZE,
    blocks: blocks.length > 0 ? blocks : [hash],
  };
}

// Fast partial read: reads only the ~5MB JSON header + the requested inner file
// bytes instead of loading the entire ~385MB app.asar into memory.
export function readFileFromAsar(archivePath, innerPath) {
  const fd = openSync(archivePath, "r");
  try {
    const pre = Buffer.alloc(16);
    readSync(fd, pre, 0, 16, 0);
    const pickleSize = pre.readUInt32LE(4);
    const jsonLen = pre.readUInt32LE(12);
    const headerSize = 8 + pickleSize;
    const jsonBuf = Buffer.alloc(jsonLen);
    readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString("utf8"));
    const node = nodeAt(header, innerPath);
    if (!node) throw new Error(`not found in asar: ${innerPath}`);
    if (node.files) throw new Error(`is a directory in asar: ${innerPath}`);
    const out = Buffer.alloc(node.size);
    if (node.size > 0) {
      readSync(fd, out, 0, node.size, headerSize + Number(node.offset));
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

// Replace one file's content and return the complete new archive buffer.
// All other files keep their exact bytes; the JSON header is rebuilt so sizes,
// offsets and integrity stay consistent. Unpacked entries are preserved verbatim.
export function buildAsarWithReplacedFile(archivePath, innerPath, payload) {
  const buf = readFileSync(archivePath);
  const { header, headerSize } = parseHeader(buf);

  const newHeader = structuredClone(header);
  const targetNode = nodeAt(newHeader, innerPath);
  if (!targetNode) throw new Error(`not found in asar: ${innerPath}`);
  const wasUnpacked = targetNode.unpacked === true;

  const files = [];
  collectFiles(newHeader, files);
  const stored = files.filter((f) => f.entry.unpacked !== true);
  stored.sort((a, b) => {
    const da =
      a.entry === targetNode ? Number.POSITIVE_INFINITY : Number(a.entry.offset);
    const db =
      b.entry === targetNode ? Number.POSITIVE_INFINITY : Number(b.entry.offset);
    return da - db;
  });

  const placed = [];
  let offset = 0;
  for (const { entry } of stored) {
    if (entry === targetNode) {
      if (wasUnpacked) continue;
      entry.size = payload.length;
      entry.offset = String(offset);
      entry.integrity = integrityFor(payload);
      placed.push(payload);
      offset += payload.length;
      continue;
    }
    if (entry.size === 0) {
      entry.offset = String(offset);
      continue;
    }
    const oldOff = Number(entry.offset);
    const bytes = Buffer.from(
      buf.subarray(headerSize + oldOff, headerSize + oldOff + entry.size)
    );
    entry.offset = String(offset);
    placed.push(bytes);
    offset += bytes.length;
  }

  const json = JSON.stringify(newHeader);
  const jsonLen = Buffer.byteLength(json, "utf8");
  const payloadSize = Math.ceil((jsonLen + 4) / ALIGN) * ALIGN;
  const pickleSize = payloadSize + 4;
  const outHeaderSize = 8 + pickleSize;

  const out = Buffer.alloc(outHeaderSize + offset);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(pickleSize, 4);
  out.writeUInt32LE(payloadSize, 8);
  out.writeUInt32LE(jsonLen, 12);
  out.write(json, 16, "utf8");
  out.fill(0, 16 + jsonLen, outHeaderSize);

  let cursor = outHeaderSize;
  for (const bytes of placed) {
    bytes.copy(out, cursor);
    cursor += bytes.length;
  }

  return { archive: out, header: newHeader };
}

function replaceFileWindowsSafe(tmpPath, targetPath) {
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // On Windows, a running Electron process opens app.asar with FILE_SHARE_WRITE
    // but not always FILE_SHARE_DELETE, blocking rename() while allowing overwrite.
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      copyFileSync(tmpPath, targetPath);
      rmSync(tmpPath, { force: true });
      return;
    }
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function installArchive(archivePath, newBytes, { backupPath, saveBackup = false } = {}) {
  const tmp = `${archivePath}.tmp-bzs-${process.pid}`;
  writeFileSync(tmp, newBytes);
  if (backupPath && saveBackup) {
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(archivePath, backupPath);
  }
  replaceFileWindowsSafe(tmp, archivePath);
}

export function restoreArchive(archivePath, backupPath) {
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  const tmp = `${archivePath}.tmp-bzs-${process.pid}`;
  copyFileSync(backupPath, tmp);
  replaceFileWindowsSafe(tmp, archivePath);
}

export { parseHeader, walkFiles, nodeAt, readFileSync, basename, join, dirname };
