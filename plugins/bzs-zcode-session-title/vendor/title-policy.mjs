import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const defaultDirectory = join(homedir(), '.zcode', 'tools', 'suian-zcode-common', 'session-titles');
function policyFile(directory, sessionId) {
  if (!/^sess(?:ion)?_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid title policy sessionId');
  return join(directory, sessionId + '.json');
}
export async function readTitlePolicy({ sessionId, directory = defaultDirectory }) {
  let raw;
  try { raw = await readFile(policyFile(directory, sessionId), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const policy = JSON.parse(raw);
  if (policy.version !== 1 || typeof policy.locked !== 'boolean') throw new Error('Invalid title policy');
  return policy;
}
export async function writeTitlePolicy({ sessionId, locked, directory = defaultDirectory }) {
  const file = policyFile(directory, sessionId);
  if (typeof locked !== 'boolean') throw new Error('Invalid title lock');
  await mkdir(directory, { recursive: true });
  const temporary = file + '.tmp-' + randomUUID();
  await writeFile(temporary, JSON.stringify({ version: 1, locked }), 'utf8');
  await rename(temporary, file);
}
