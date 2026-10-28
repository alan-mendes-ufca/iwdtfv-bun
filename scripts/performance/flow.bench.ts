import video from "models/video";
import ytdlp from "infra/ytdlp";
import fs from "node:fs/promises";
const url =
  process.env.BENCH_URL || "https://www.youtube.com/watch?v=gHKT4uU8Zng";
const principal = "benchmark-owner";
const counts = {
  inspectAnonymous: 0,
  inspectAuthenticated: 0,
  downloadAnonymous: 0,
  downloadAuthenticated: 0,
  metadataReuse: 0,
};
const protocols: Record<string, number> = {};
const originalInspect = ytdlp.inspect;
ytdlp.inspect = async (...args) => {
  if (args[1]?.cookiesPath) counts.inspectAuthenticated++;
  else counts.inspectAnonymous++;
  const raw = await originalInspect(...args);
  for (const f of raw.formats || []) {
    const protocol = (f as { protocol?: string }).protocol || "unknown";
    protocols[protocol] = (protocols[protocol] || 0) + 1;
  }
  return raw;
};
const originalDownload = ytdlp.download;
ytdlp.download = async (...args) => {
  if (args[2]?.cookiesPath) counts.downloadAuthenticated++;
  else counts.downloadAnonymous++;
  if ((args[2] as { infoJson?: string }).infoJson) counts.metadataReuse++;
  return originalDownload(...args);
};
const started = performance.now();
let result: Awaited<ReturnType<typeof video.download>> | undefined;
try {
  const info = await video.inspect(url, { principal });
  const inspected = performance.now();
  const requested = process.env.BENCH_FORMAT || "18";
  const selected = info.formats.find(
    (f) => f.format_id === requested,
  )?.format_id;
  if (!selected) throw new Error("RequestedFormatUnavailable");
  result = await video.download(url, selected, { principal });
  const ready = performance.now();
  const bytes = await Bun.file(result.filePath).arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await result.cleanup();
  result = undefined;
  console.log(
    JSON.stringify({
      variant: process.env.BENCH_VARIANT,
      rep: Number(process.env.BENCH_REP || 1),
      format: selected,
      inspectMs: Math.round(inspected - started),
      downloadMs: Math.round(ready - inspected),
      totalMs: Math.round(performance.now() - started),
      bytes: bytes.byteLength,
      sha256: hash,
      counts,
      protocols,
      temporaryJobs: (await fs.readdir("/tmp/iwdtfv")).length,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      variant: process.env.BENCH_VARIANT,
      rep: Number(process.env.BENCH_REP || 1),
      error: e instanceof Error ? e.name : "UnknownError",
      counts,
      totalMs: Math.round(performance.now() - started),
    }),
  );
  process.exitCode = 1;
} finally {
  if (result) await result.cleanup();
}
