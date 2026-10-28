import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import video from "models/video";

const FAKE_BINARY = path.resolve("tests/fakes/yt-dlp.ts");

// TS: "let x: T;" declara o tipo de uma variável sem valor inicial; aqui é string.
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iwdtfv-video-test-"));
  process.env.YTDLP_BINARY = FAKE_BINARY;
  process.env.TEMP_DIR = tempDir;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.YTDLP_COOKIES_FILE;
  delete process.env.YTDLP_COOKIES_MODE;
  delete process.env.PERFORMANCE_METADATA_CACHE;
  delete process.env.MAX_CONCURRENT_DOWNLOADS;
  delete process.env.FAKE_YTDLP_ARGS_FILE;
  delete process.env.FAKE_YTDLP_FAIL_LOAD_INFO;
  delete process.env.FAKE_YTDLP_DOWNLOAD_DELAY_MS;
  delete process.env.DOWNLOAD_TIMEOUT_MS;
});

function jobDirs() {
  return fs.readdirSync(tempDir).filter((entry) => entry.startsWith("job-"));
}

describe("video.inspect", () => {
  test("With a YouTube link returns normalized qualities", async () => {
    const info = await video.inspect("https://www.youtube.com/watch?v=abc");

    expect(info.platform).toBe("YouTube");
    expect(info.duration_seconds).toBe(213);
    expect(info.audio_available).toBe(true);
    expect(info.formats.map((item) => item.quality)).toContain("1080p");
    expect(jobDirs()).toEqual([]);
  });

  test("With a TikTok link returns the TikTok platform", async () => {
    const info = await video.inspect("https://www.tiktok.com/@a/video/1");

    expect(info.platform).toBe("TikTok");
    expect(info.formats.map((item) => item.quality)).toEqual(["720p", "576p"]);
  });

  test("With an unsupported host does not call yt-dlp", async () => {
    await expect(video.inspect("https://vimeo.com/1")).rejects.toMatchObject({
      name: "UnsupportedPlatformError",
    });
  });

  test("With a live stream rejects", async () => {
    await expect(video.inspect("https://youtu.be/live")).rejects.toMatchObject({
      name: "ValidationError",
      message: "Transmissões ao vivo não são suportadas.",
    });
  });

  test("With a video longer than the limit rejects", async () => {
    await expect(video.inspect("https://youtu.be/long")).rejects.toMatchObject({
      name: "ValidationError",
      message: "O vídeo passa do limite de 120 minutos.",
    });
  });

  test("With a private video rejects and leaves no temp files", async () => {
    await expect(
      video.inspect("https://youtu.be/private"),
    ).rejects.toMatchObject({ name: "VideoUnavailableError" });
    expect(jobDirs()).toEqual([]);
  });

  test("With cookies configured, public videos are inspected anonymously", async () => {
    const cookiesFile = path.join(tempDir, "cookies-original.txt");
    const argsFile = path.join(tempDir, "args.jsonl");
    fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n");
    process.env.YTDLP_COOKIES_FILE = cookiesFile;
    process.env.YTDLP_COOKIES_MODE = "fallback";
    process.env.FAKE_YTDLP_ARGS_FILE = argsFile;

    await video.inspect("https://youtu.be/abc", {
      principal: "owner@example.com",
    });

    // TS: a anotação string[] vale para JSON.parse, que devolve any; o TS aceita sem checar o conteúdo.
    const calls: string[][] = fs
      .readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const args = calls[0]!;
    expect(args).not.toContain("--cookies");
    expect(calls).toHaveLength(1);
  });

  test("Retries once with a private copy for an authorized YouTube principal", async () => {
    const cookiesFile = path.join(tempDir, "cookies-original.txt");
    const argsFile = path.join(tempDir, "args.jsonl");
    fs.writeFileSync(
      cookiesFile,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n",
      { mode: 0o600 },
    );
    process.env.YTDLP_COOKIES_FILE = cookiesFile;
    process.env.YTDLP_COOKIES_MODE = "fallback";
    process.env.FAKE_YTDLP_ARGS_FILE = argsFile;

    await video.inspect("https://youtu.be/auth-required", {
      principal: "owner@example.com",
    });

    const calls: string[][] = fs
      .readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("--cookies");
    const cookiesArg = calls[1]![calls[1]!.indexOf("--cookies") + 1]!;
    expect(cookiesArg).not.toBe(cookiesFile);
    expect(path.basename(cookiesArg)).toBe("cookies.txt");
    expect(fs.existsSync(cookiesArg)).toBe(false);
  });

  test("Does not retry with cookies without an authenticated principal", async () => {
    const cookiesFile = path.join(tempDir, "cookies-original.txt");
    process.env.YTDLP_COOKIES_FILE = cookiesFile;
    process.env.YTDLP_COOKIES_MODE = "fallback";
    fs.writeFileSync(
      cookiesFile,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n",
      { mode: 0o600 },
    );
    await expect(
      video.inspect("https://youtu.be/auth-required"),
    ).rejects.toMatchObject({ name: "LoginRequiredError" });
  });

  test("Configured cookie files stay unused when cookie mode is omitted", async () => {
    const cookiesFile = path.join(tempDir, "cookies-original.txt");
    const argsFile = path.join(tempDir, "args.jsonl");
    fs.writeFileSync(
      cookiesFile,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n",
      { mode: 0o600 },
    );
    process.env.YTDLP_COOKIES_FILE = cookiesFile;
    process.env.FAKE_YTDLP_ARGS_FILE = argsFile;
    await expect(
      video.inspect("https://youtu.be/auth-required", {
        principal: "owner@example.com",
      }),
    ).rejects.toMatchObject({ name: "LoginRequiredError" });
    const calls: string[][] = fs
      .readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--cookies");
  });

  test.each([
    ["group-readable permissions", "valid", 0o644],
    [
      "a non-YouTube cookie domain",
      "# Netscape HTTP Cookie File\n.evil.example\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n",
      0o600,
    ],
  ])(
    "Rejects a fallback cookie file with %s",
    async (_label, contents, mode) => {
      const cookiesFile = path.join(tempDir, "cookies-original.txt");
      fs.writeFileSync(
        cookiesFile,
        contents === "valid"
          ? "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n"
          : contents,
        { mode },
      );
      fs.chmodSync(cookiesFile, mode);
      process.env.YTDLP_COOKIES_FILE = cookiesFile;
      process.env.YTDLP_COOKIES_MODE = "fallback";
      await expect(
        video.inspect("https://youtu.be/auth-required", {
          principal: "owner@example.com",
        }),
      ).rejects.toMatchObject({ name: "ServiceError" });
    },
  );

  test("Never supplies the YouTube session to another provider", async () => {
    const cookiesFile = path.join(tempDir, "cookies-original.txt");
    const argsFile = path.join(tempDir, "args.jsonl");
    fs.writeFileSync(
      cookiesFile,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n",
      { mode: 0o600 },
    );
    process.env.YTDLP_COOKIES_FILE = cookiesFile;
    process.env.YTDLP_COOKIES_MODE = "fallback";
    process.env.FAKE_YTDLP_ARGS_FILE = argsFile;
    await expect(
      video.inspect("https://www.instagram.com/p/login/", {
        principal: "owner@example.com",
      }),
    ).rejects.toMatchObject({ name: "LoginRequiredError" });
    const calls: string[][] = fs
      .readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--cookies");
  });
});

describe("video.download", () => {
  test("With a quality returns the file and cleanup removes it", async () => {
    const result = await video.download("https://youtu.be/abc", "137");

    expect(result.filename).toBe(
      "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster).mp4",
    );
    expect(result.contentType).toBe("video/mp4");
    expect(result.size).toBe(256 * 1024);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(video.getActiveDownloads()).toBe(1);

    await result.cleanup();
    await result.cleanup();

    expect(fs.existsSync(result.filePath)).toBe(false);
    expect(jobDirs()).toEqual([]);
    expect(video.getActiveDownloads()).toBe(0);
  });

  test("With audio returns an mp3", async () => {
    const result = await video.download("https://youtu.be/abc", "audio");

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.filename.endsWith(".mp3")).toBe(true);
    await result.cleanup();
  });

  test("With a failing download cleans up and releases the slot", async () => {
    await expect(
      video.download("https://youtu.be/fail", "137"),
    ).rejects.toMatchObject({ name: "YtDlpFailedError" });

    expect(jobDirs()).toEqual([]);
    expect(video.getActiveDownloads()).toBe(0);
  });

  test("With an aborted download cleans up", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    await expect(
      video.download("https://youtu.be/sleep", "137", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ statusCode: 499 });

    expect(jobDirs()).toEqual([]);
    expect(video.getActiveDownloads()).toBe(0);
  });

  test("With too many concurrent downloads rejects with 503", async () => {
    process.env.MAX_CONCURRENT_DOWNLOADS = "1";
    const first = await video.download("https://youtu.be/abc", "137");

    await expect(
      video.download("https://youtu.be/abc", "137"),
    ).rejects.toMatchObject({ statusCode: 503 });

    await first.cleanup();
    expect(video.getActiveDownloads()).toBe(0);
  });
});

describe("video.buildFilename", () => {
  test("Removes characters that are unsafe in file names", () => {
    expect(video.buildFilename('a/b\\c:d*e?f"g<h>i|j\nk', "mp4")).toBe(
      "a b c d e f g h i j k.mp4",
    );
  });

  test("With an empty title and a strange extension", () => {
    expect(video.buildFilename("  ", "../x")).toBe("video.bin");
  });
});

test("metadata cache hit downloads from info JSON without a positional URL", async () => {
  const cookiesFile = path.join(tempDir, "cache-cookies.txt");
  const argsFile = path.join(tempDir, "cache-args.jsonl");
  fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n", {
    mode: 0o600,
  });
  process.env.YTDLP_COOKIES_FILE = cookiesFile;
  process.env.YTDLP_COOKIES_MODE = "fallback";
  process.env.PERFORMANCE_METADATA_CACHE = "1";
  process.env.FAKE_YTDLP_ARGS_FILE = argsFile;
  const url = "https://youtu.be/cache-hit";
  await video.inspect(url, { principal: "owner@example.com" });
  const result = await video.download(url, "137", {
    principal: "owner@example.com",
  });
  await result.cleanup();
  const calls: string[][] = fs
    .readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("--load-info-json");
  expect(calls[1]).not.toContain("--");
  expect(calls[1]).not.toContain("--cookies");
  delete process.env.PERFORMANCE_METADATA_CACHE;
});

test("expired cached metadata falls back once without a stale partial file", async () => {
  const cookiesFile = path.join(tempDir, "expired-cookies.txt");
  const argsFile = path.join(tempDir, "expired-args.jsonl");
  fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n", {
    mode: 0o600,
  });
  process.env.YTDLP_COOKIES_FILE = cookiesFile;
  process.env.YTDLP_COOKIES_MODE = "fallback";
  process.env.PERFORMANCE_METADATA_CACHE = "1";
  process.env.FAKE_YTDLP_ARGS_FILE = argsFile;
  const url = "https://youtu.be/cache-expired";
  await video.inspect(url, { principal: "owner@example.com" });
  process.env.FAKE_YTDLP_FAIL_LOAD_INFO = "1";
  const result = await video.download(url, "137", {
    principal: "owner@example.com",
  });
  await result.cleanup();
  const calls: string[][] = fs
    .readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(3);
  expect(calls[1]).toContain("--load-info-json");
  expect(calls[2]).not.toContain("--load-info-json");
  expect(jobDirs()).toEqual([]);
});

test("failed normalization does not populate metadata cache", async () => {
  const cookiesFile = path.join(tempDir, "normalize-cookies.txt");
  const argsFile = path.join(tempDir, "normalize-args.jsonl");
  fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n", {
    mode: 0o600,
  });
  process.env.YTDLP_COOKIES_FILE = cookiesFile;
  process.env.YTDLP_COOKIES_MODE = "fallback";
  process.env.PERFORMANCE_METADATA_CACHE = "1";
  process.env.FAKE_YTDLP_ARGS_FILE = argsFile;
  const url = "https://youtu.be/bad-formats";
  await expect(
    video.inspect(url, { principal: "owner@example.com" }),
  ).rejects.toThrow();
  const result = await video.download(url, "137", {
    principal: "owner@example.com",
  });
  await result.cleanup();
  const calls: string[][] = fs
    .readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[1]).not.toContain("--load-info-json");
});

test("cached attempt and fallback share one download timeout", async () => {
  const cookiesFile = path.join(tempDir, "budget-cookies.txt");
  fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n", {
    mode: 0o600,
  });
  process.env.YTDLP_COOKIES_FILE = cookiesFile;
  process.env.YTDLP_COOKIES_MODE = "fallback";
  process.env.PERFORMANCE_METADATA_CACHE = "1";
  const url = "https://youtu.be/budget-test";
  await video.inspect(url, { principal: "owner@example.com" });
  process.env.FAKE_YTDLP_FAIL_LOAD_INFO = "1";
  process.env.FAKE_YTDLP_DOWNLOAD_DELAY_MS = "100";
  process.env.DOWNLOAD_TIMEOUT_MS = "150";
  const started = performance.now();
  await expect(
    video.download(url, "137", { principal: "owner@example.com" }),
  ).rejects.toMatchObject({ statusCode: 504 });
  expect(performance.now() - started).toBeLessThan(350);
  expect(jobDirs()).toEqual([]);
  expect(video.getActiveDownloads()).toBe(0);
});

test("client cancellation still returns 499 during cached attempt", async () => {
  const cookiesFile = path.join(tempDir, "cancel-cookies.txt");
  fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n", {
    mode: 0o600,
  });
  process.env.YTDLP_COOKIES_FILE = cookiesFile;
  process.env.YTDLP_COOKIES_MODE = "fallback";
  process.env.PERFORMANCE_METADATA_CACHE = "1";
  const url = "https://youtu.be/cancel-test";
  await video.inspect(url, { principal: "owner@example.com" });
  process.env.FAKE_YTDLP_DOWNLOAD_DELAY_MS = "1000";
  process.env.DOWNLOAD_TIMEOUT_MS = "2000";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await expect(
    video.download(url, "137", {
      principal: "owner@example.com",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ statusCode: 499 });
  expect(jobDirs()).toEqual([]);
  expect(video.getActiveDownloads()).toBe(0);
});
