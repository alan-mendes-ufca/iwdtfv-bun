import fs from "node:fs/promises";
import config from "infra/config";
import type { RawYtDlpVideo } from "models/format";

const TTL_MS = 60_000;
const MAX_ENTRIES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
type Identity = {
  path: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};
type Entry = {
  principal: string;
  url: string;
  identity: Identity;
  json: string;
  usedCookies: boolean;
  expires: number;
  bytes: number;
};
const entries: Entry[] = [];

async function identity(): Promise<Identity | null> {
  const settings = config.get();
  if (
    process.env.PERFORMANCE_METADATA_CACHE !== "1" ||
    settings.cookiesMode !== "fallback" ||
    !settings.cookiesFile
  )
    return null;
  try {
    const stat = await fs.lstat(settings.cookiesFile);
    if (!stat.isFile()) return null;
    return {
      path: settings.cookiesFile,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}
function same(a: Identity, b: Identity) {
  return (
    a.path === b.path &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size
  );
}
function prune() {
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i]!.expires <= now) entries.splice(i, 1);
}
async function generation(provider: string, principal?: string) {
  if (provider !== "youtube" || !principal) return null;
  const cookie = await identity();
  return cookie ? { principal, cookie } : null;
}
async function put(
  provider: string,
  principal: string | undefined,
  url: string,
  raw: RawYtDlpVideo,
  usedCookies: boolean,
  expected: Awaited<ReturnType<typeof generation>>,
) {
  const current = await generation(provider, principal);
  if (
    !current ||
    !expected ||
    current.principal !== expected.principal ||
    !same(current.cookie, expected.cookie)
  )
    return;
  const json = JSON.stringify(raw, (key, value) =>
    /^(?:cookies?|authorization)$/i.test(key) ? undefined : value,
  );
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_BYTES) return;
  prune();
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i]!.principal === principal && entries[i]!.url === url)
      entries.splice(i, 1);
  entries.push({
    principal: current.principal,
    url,
    identity: current.cookie,
    json,
    usedCookies,
    expires: Date.now() + TTL_MS,
    bytes,
  });
  while (
    entries.length > MAX_ENTRIES ||
    entries.reduce((sum, e) => sum + e.bytes, 0) > MAX_BYTES
  )
    entries.shift();
}
async function take(
  provider: string,
  principal: string | undefined,
  url: string,
) {
  const current = await generation(provider, principal);
  if (!current) return null;
  prune();
  const index = entries.findIndex(
    (e) => e.principal === current.principal && e.url === url,
  );
  if (index < 0) return null;
  const entry = entries[index]!;
  entries.splice(index, 1);
  return same(entry.identity, current.cookie)
    ? { json: entry.json, usedCookies: entry.usedCookies }
    : null;
}
export default { generation, put, take };
