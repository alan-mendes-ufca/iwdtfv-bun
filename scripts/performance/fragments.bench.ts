import fs from "node:fs/promises";
await fs.mkdir("/tmp/hls", { recursive: true });
const ffmpeg = Bun.spawn(
  [
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x180:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=22050",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-g",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    "/tmp/hls/index.m3u8",
  ],
  { stdout: "ignore", stderr: "pipe" },
);
if (await ffmpeg.exited) throw new Error("Fixture generation failed");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8765,
  async fetch(request) {
    const file = new URL(request.url).pathname.split("/").at(-1)!;
    if (!/^(index\.m3u8|index\d+\.ts)$/.test(file))
      return new Response("", { status: 404 });
    if (file.endsWith(".ts")) await new Promise((r) => setTimeout(r, 120));
    return new Response(Bun.file("/tmp/hls/" + file));
  },
});
try {
  for (let rep = 1; rep <= 3; rep++)
    for (const n of [1, 2, 4]) {
      const started = performance.now();
      const proc = Bun.spawn(
        [
          "yt-dlp",
          "--ignore-config",
          "--no-cache-dir",
          "--hls-prefer-native",
          "--concurrent-fragments",
          String(n),
          "-o",
          `/tmp/fixture-${n}.mp4`,
          "--",
          "http://127.0.0.1:8765/index.m3u8",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code) throw new Error("Fixture download failed");
      const bytes = await Bun.file(`/tmp/fixture-${n}.mp4`).arrayBuffer();
      console.log(
        JSON.stringify({
          kind: "synthetic-hls",
          rep,
          fragments: n,
          delayMs: 120,
          milliseconds: Math.round(performance.now() - started),
          bytes: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        }),
      );
      await fs.rm(`/tmp/fixture-${n}.mp4`);
    }
} finally {
  await server.stop(true);
}
