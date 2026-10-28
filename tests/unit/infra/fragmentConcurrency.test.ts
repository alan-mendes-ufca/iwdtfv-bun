import { test, expect } from "bun:test";
import ytdlp from "infra/ytdlp";
test("rejects excessive fragment concurrency before spawning", async () => {
  const previous = process.env.YTDLP_FRAGMENT_CONCURRENCY;
  process.env.YTDLP_FRAGMENT_CONCURRENCY = "99";
  try {
    await expect(
      ytdlp.download(
        "https://www.youtube.com/watch?v=abc",
        { type: "video", formatId: "18" },
        { directory: "/tmp" },
      ),
    ).rejects.toThrow("Concorrência de fragmentos inválida");
  } finally {
    if (previous === undefined) delete process.env.YTDLP_FRAGMENT_CONCURRENCY;
    else process.env.YTDLP_FRAGMENT_CONCURRENCY = previous;
  }
});
