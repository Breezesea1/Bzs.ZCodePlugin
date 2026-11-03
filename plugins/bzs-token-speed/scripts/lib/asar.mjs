// Minimal asar reader/writer: enough to replace one file inside an archive
// without unpacking the rest. Layout (chromium asar disk format):
//   [u32 pickleSize][u32 headerObjSize][u32 jsonLen][JSON][file bytes...]
// pickleSize covers the [u32 jsonLen][JSON] pair; file offsets are relative to
// the first byte after the header. Replacing a file rebuilds the archive:
// fresh header, then each file's bytes in header order with recomputed offsets.
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

const BLOCK_SIZE = 4194304; // asar integrity block size used by Electron
const ALIGN = 4; // header pickle payloads are 4-byte aligned

function parseHeader(buf) {
  // pickle1: [u32=4][u32 pickleSize] — pickleSize counts pickle2's bytes.
  // pickle2: [u32 payloadSize][u32 jsonLen][JSON] — JSON starts at byte 16.
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
    blocks.push(createHash("sha256").update(payload.subarray(i, i + BLOCK_SIZE)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash,
    blockSize: BLOCK_SIZE,
    blocks: blocks.length > 0 ? blocks : [hash],
  };
}

export function readFileFromAsar(archivePath, innerPath) {
  const buf = readFileSync(archivePath);
  const { header, headerSize } = parseHeader(buf);
  const node = nodeAt(header, innerPath);
  if (!node) throw new Error(`not found in asar: ${innerPath}`);
  if (node.files) throw new Error(`is a directory in asar: ${innerPath}`);
  const off = Number(node.offset);
  return Buffer.from(buf.subarray(headerSize + off, headerSize + off + node.size));
}

// Replace one file's content and return the complete new archive buffer.
// All other files keep their exact bytes; the JSON header is rebuilt so sizes,
// offsets and integrity stay consistent. Unpacked entries (files that live in
// app.asar.unpacked) are preserved verbatim with their "unpacked": true flag.
export function buildAsarWithReplacedFile(archivePath, innerPath, payload) {
  const buf = readFileSync(archivePath);
  const { header, headerSize } = parseHeader(buf);

  const newHeader = structuredClone(header);
  const targetNode = nodeAt(newHeader, innerPath);
  if (!targetNode) throw new Error(`not found in asar: ${innerPath}`);
  const wasUnpacked = targetNode.unpacked === true;

  // The archive's data region follows OLD-offset order, not header JSON order
  // (electron's asar writer sorts before assigning offsets). Rebuild in that
  // order so every file keeps its exact bytes; rewrite offsets as we go.
  const files = [];
  collectFiles(newHeader, files);
  const stored = files.filter((f) => f.entry.unpacked !== true);
  stored.sort((a, b) => {
    const da = a.entry === targetNode ? Number.POSITIVE_INFINITY : Number(a.entry.offset);
    const db = b.entry === targetNode ? Number.POSITIVE_INFINITY : Number(b.entry.offset);
    return da - db;
  });

  const placed = [];
  let offset = 0;
  for (const { entry } of stored) {
    if (entry === targetNode) {
      if (wasUnpacked) continue; // header flag kept, no bytes in archive
      entry.size = payload.length;
      entry.offset = String(offset);
      entry.integrity = integrityFor(payload);
      placed.push(payload);
      offset += payload.length;
      continue;
    }
    if (entry.size === 0) {
      entry.offset = String(offset);
      continue; // zero-size entries share their neighbor's old offset
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
  // pickle2 payload = [u32 jsonLen][json]; total padded to 4-byte alignment.
  const payloadSize = Math.ceil((jsonLen + 4) / ALIGN) * ALIGN;
  const pickleSize = payloadSize + 4;
  const outHeaderSize = 8 + pickleSize;

  const out = Buffer.alloc(outHeaderSize + offset);
  out.writeUInt32LE(4, 0); // pickle1 payload: size of pickle2
  out.writeUInt32LE(pickleSize, 4); // pickle2 size = payloadSize + 4
  out.writeUInt32LE(payloadSize, 8); // pickle2 payload size (len field + padded json)
  out.writeUInt32LE(jsonLen, 12); // json byte length
  out.write(json, 16, "utf8");
  out.fill(0, 16 + jsonLen, outHeaderSize); // zero padding keeps alignment

  let cursor = outHeaderSize;
  for (const bytes of placed) {
    bytes.copy(out, cursor);
    cursor += bytes.length;
  }

  return { archive: out, header: newHeader };
}

// Atomic-ish swap: write to a sibling temp file, fsync via rename, keep one
// generation of backup next to the archive.
export function installArchive(archivePath, newBytes, { backupPath }) {
  const tmp = `${archivePath}.tmp-bzs`;
  writeFileSync(tmp, newBytes);
  if (backupPath) {
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(archivePath, backupPath);
  }
  renameSync(tmp, archivePath);
}

export function restoreArchive(archivePath, backupPath) {
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  const tmp = `${archivePath}.tmp-bzs`;
  copyFileSync(backupPath, tmp);
  renameSync(tmp, archivePath);
}

export { parseHeader, walkFiles, nodeAt, readFileSync, basename, join, dirname };
