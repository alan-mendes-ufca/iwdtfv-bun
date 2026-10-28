import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import cache from "infra/inspectionCache";

const file = path.join(os.tmpdir(), `cache-cookie-identity-${process.pid}`);
const url = "https://youtu.be/cache-test";
async function setup() {
  await fs.writeFile(file, "identity", { mode: 0o600 });
  process.env.PERFORMANCE_METADATA_CACHE = "1";
  process.env.YTDLP_COOKIES_MODE = "fallback";
  process.env.YTDLP_COOKIES_FILE = file;
}
async function put(
  ...args: Parameters<typeof cache.put> extends [...infer A, unknown]
    ? A
    : never
) {
  const [provider, principal] = args;
  const generation = await cache.generation(provider, principal);
  await cache.put(...args, generation);
}
afterEach(async () => {
  delete process.env.PERFORMANCE_METADATA_CACHE;
  delete process.env.YTDLP_COOKIES_MODE;
  delete process.env.YTDLP_COOKIES_FILE;
  await fs.rm(file, { force: true });
});
test("metadata remains scoped to principal, exact URL and cookie identity", async () => {
  await setup();
  await put("youtube", "alice", url, { title: "private" }, true);
  expect(await cache.take("youtube", "bob", url)).toBeNull();
  expect(await cache.take("youtube", "alice", url + "?x=1")).toBeNull();
  expect(await cache.take("instagram", "alice", url)).toBeNull();
  expect((await cache.take("youtube", "alice", url))?.usedCookies).toBe(true);
  expect(await cache.take("youtube", "alice", url)).toBeNull();
  await put("youtube", "alice", url, { title: "private" }, true);
  await fs.rm(file);
  await fs.writeFile(file, "identity2", { mode: 0o600 });
  expect(await cache.take("youtube", "alice", url)).toBeNull();
});
test("mode and feature flag gate insertion and retrieval", async () => {
  await setup();
  await put("youtube", "alice", url, { title: "private" }, false);
  process.env.YTDLP_COOKIES_MODE = "disabled";
  expect(await cache.take("youtube", "alice", url)).toBeNull();
  process.env.YTDLP_COOKIES_MODE = "fallback";
  delete process.env.PERFORMANCE_METADATA_CACHE;
  expect(await cache.take("youtube", "alice", url)).toBeNull();
});
test("entry count and UTF-8 byte budget are bounded", async () => {
  await setup();
  for (let i = 0; i < 5; i++)
    await put("youtube", "bound", `${url}-${i}`, { title: `v${i}` }, false);
  expect(await cache.take("youtube", "bound", `${url}-0`)).toBeNull();
  expect(await cache.take("youtube", "bound", `${url}-4`)).not.toBeNull();
  await put(
    "youtube",
    "bound",
    "huge",
    { title: "é".repeat(5 * 1024 * 1024) },
    false,
  );
  expect(await cache.take("youtube", "bound", "huge")).toBeNull();
});
test("entries expire after 60 seconds", async () => {
  await setup();
  const now = Date.now;
  const start = now();
  try {
    Date.now = () => start;
    await put("youtube", "expiry", url, { title: "old" }, false);
    Date.now = () => start + 60_001;
    expect(await cache.take("youtube", "expiry", url)).toBeNull();
  } finally {
    Date.now = now;
  }
});
test("stored JSON strips cookie and authorization fields recursively", async () => {
  await setup();
  const raw = {
    title: "safe",
    cookies: "secret-cookie",
    formats: [
      {
        format_id: "137",
        url: "https://media.example/video",
        http_headers: {
          COOKIE: "secret-header-cookie",
          Authorization: "secret-auth",
          Referer: "https://youtu.be/",
        },
      },
    ],
    nested: { Cookies: ["secret-nested"], authorization: "secret-nested-auth" },
  };
  await put("youtube", "sanitize", url, raw, false);
  const json = (await cache.take("youtube", "sanitize", url))?.json || "";
  expect(json).not.toContain("secret-");
  expect(json).toContain("Referer");
  expect(json).toContain("https://media.example/video");
});

test("generation changed during extraction prevents insertion", async () => {
  await setup();
  const generation = await cache.generation("youtube", "rotation");
  await fs.rm(file);
  await fs.writeFile(file, "new identity", { mode: 0o600 });
  await cache.put(
    "youtube",
    "rotation",
    url,
    { title: "old-session" },
    true,
    generation,
  );
  expect(await cache.take("youtube", "rotation", url)).toBeNull();
});
