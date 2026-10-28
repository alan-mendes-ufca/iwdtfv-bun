import fs from "node:fs/promises";
import path from "node:path";
import config from "infra/config";
import {
  validateYouTubeCookies,
  withOptionalCookies,
} from "infra/cookiePolicy";
import inspectionCache from "infra/inspectionCache";
import { ServicesError, ValidationError, YtDlpFailedError } from "infra/errors";
import tempfiles from "infra/tempfiles";
// TS: "{ type X }" dentro do import importa só o tipo Selection; some no JavaScript gerado.
import ytdlp, { type Selection } from "infra/ytdlp";
import format, { type RawYtDlpVideo, type VideoInfo } from "models/format";
import provider from "models/provider";

let activeDownloads = 0;
const shutdown = new AbortController();
function operationSignal(signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
}

// TS: Promise<VideoInfo> é genérico: a função é async e resolve para um VideoInfo.
async function inspect(
  url: string,
  // TS: "{ signal?: AbortSignal }" é tipo de objeto inline; signal é opcional. O "= {}" é o valor padrão.
  options: { signal?: AbortSignal; principal?: string } = {},
): Promise<VideoInfo> {
  const videoProvider = provider.findByUrl(url);
  const job = await tempfiles.create();

  try {
    const signal = operationSignal(options.signal);
    const generation = await inspectionCache.generation(
      videoProvider.name,
      options.principal,
    );
    signal.throwIfAborted();
    let usedCookies = false;
    const raw = await withOptionalCookies(
      job,
      videoProvider,
      { ...options, signal },
      (cookiesPath) => {
        usedCookies = Boolean(cookiesPath);
        return ytdlp.inspect(url, { cookiesPath, signal });
      },
    );
    assertDownloadable(raw);
    signal.throwIfAborted();
    const info = format.normalize(raw, videoProvider.label);
    signal.throwIfAborted();
    await inspectionCache.put(
      videoProvider.name,
      options.principal,
      url,
      raw,
      usedCookies,
      generation,
    );
    return info;
  } finally {
    await job.cleanup();
  }
}

function assertDownloadable(raw: RawYtDlpVideo) {
  if (raw._type === "playlist" || raw._type === "multi_video") {
    throw new ValidationError({
      message: "Playlists não são suportadas.",
      action: "Cole o link de um único vídeo.",
    });
  }

  if (raw.is_live || raw.live_status === "is_live") {
    throw new ValidationError({
      message: "Transmissões ao vivo não são suportadas.",
      action: "Espere a transmissão terminar e tente de novo.",
    });
  }

  const { maxDurationSeconds } = config.get();
  if (typeof raw.duration === "number" && raw.duration > maxDurationSeconds) {
    throw new ValidationError({
      message: `O vídeo passa do limite de ${Math.floor(maxDurationSeconds / 60)} minutos.`,
      action: "Escolha um vídeo mais curto.",
    });
  }
}

// TS: "export type" exporta o formato do resultado do download para outros arquivos. Some no JavaScript gerado.
export type DownloadResult = {
  filePath: string;
  filename: string;
  contentType: string;
  size: number;
  // TS: "() => Promise<void>" é tipo de função: não recebe nada e a promessa não devolve valor.
  cleanup: () => Promise<void>;
};

function parseSelection(formatId: string): Selection {
  // TS: Selection é união discriminada: o campo "type" diz qual formato é. "audio" não tem formatId; "video" tem.
  return formatId === "audio" ? { type: "audio" } : { type: "video", formatId };
}

// Quem chama deve sempre executar cleanup() ao terminar de enviar o arquivo.
async function download(
  url: string,
  formatId: string,
  options: { signal?: AbortSignal; principal?: string } = {},
): Promise<DownloadResult> {
  const videoProvider = provider.findByUrl(url);

  if (activeDownloads >= config.get().maxConcurrentDownloads) {
    throw new ServicesError({
      message: "Já há downloads demais em andamento.",
      action: "Espere um download terminar e tente de novo.",
    });
  }

  const budget = AbortSignal.timeout(config.get().downloadTimeoutMs);
  const signal = AbortSignal.any([operationSignal(options.signal), budget]);
  activeDownloads++;
  let released = false;
  const job = await tempfiles.create().catch((error) => {
    release();
    throw error;
  });

  const cleanup = async () => {
    release();
    await job.cleanup();
  };

  try {
    await tempfiles.ensureSpace();
    const cached = await inspectionCache.take(
      videoProvider.name,
      options.principal,
      url,
    );
    signal.throwIfAborted();
    if (cached) {
      const attemptDir = path.join(job.path, "cache-attempt");
      try {
        signal.throwIfAborted();
        let cookiesPath: string | null = null;
        if (cached.usedCookies) {
          const file = config.get().cookiesFile;
          if (!file) throw new Error("Cookie configuration changed");
          await validateYouTubeCookies(file);
          cookiesPath = await job.copyCookies(file);
        }
        signal.throwIfAborted();
        await fs.mkdir(attemptDir, { mode: 0o700 });
        const file = await ytdlp.download(url, parseSelection(formatId), {
          directory: attemptDir,
          cookiesPath,
          signal,
          infoJson: cached.json,
        });
        return {
          filePath: file.filePath,
          filename: buildFilename(file.title, file.ext),
          contentType: contentTypeFor(file.ext),
          size: file.size,
          cleanup,
        };
      } catch (error) {
        await fs.rm(attemptDir, { recursive: true, force: true });
        if (signal.aborted) throw error;
        // A metadata pode conter URLs de mídia já expiradas. Reextraia uma vez.
      }
    }
    const file = await withOptionalCookies(
      job,
      videoProvider,
      { ...options, signal },
      (cookiesPath) =>
        ytdlp.download(url, parseSelection(formatId), {
          directory: job.path,
          cookiesPath,
          signal,
        }),
    );

    return {
      filePath: file.filePath,
      filename: buildFilename(file.title, file.ext),
      contentType: contentTypeFor(file.ext),
      size: file.size,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (options.signal?.aborted || shutdown.signal.aborted) {
      if (error instanceof YtDlpFailedError && error.statusCode === 499)
        throw error;
      throw new YtDlpFailedError({
        message: "A operação foi cancelada.",
        statusCode: 499,
        cause: error,
      });
    }
    if (budget.aborted) {
      throw new YtDlpFailedError({
        message: "O download demorou demais para responder.",
        action: "Tente novamente ou escolha uma qualidade menor.",
        statusCode: 504,
        cause: error,
      });
    }
    throw error;
  }

  function release() {
    if (released) return;
    released = true;
    activeDownloads--;
  }
}

function buildFilename(title: string, ext: string) {
  const safeTitle =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
      .trim() || "video";
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "bin";
  return `${safeTitle}.${safeExt}`;
}

function contentTypeFor(ext: string) {
  // TS: Record<string, string> é um objeto com chaves e valores de texto. Com noUncheckedIndexedAccess, types[ext] pode ser undefined, por isso o "||".
  const types: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
  };
  return types[ext.toLowerCase()] || "application/octet-stream";
}

function getActiveDownloads() {
  return activeDownloads;
}

const video = {
  inspect,
  download,
  buildFilename,
  getActiveDownloads,
  abortOperations() {
    shutdown.abort();
  },
  async waitForCleanup() {
    const deadline = Date.now() + 5000;
    while (activeDownloads > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  },
};

export default video;
