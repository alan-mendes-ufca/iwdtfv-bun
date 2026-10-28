import fs from "node:fs/promises";
import path from "node:path";
import config from "infra/config";
import {
  LoginRequiredError,
  ServicesError,
  UnsupportedPlatformError,
  ValidationError,
  VideoUnavailableError,
  YtDlpFailedError,
} from "infra/errors";
// TS: `import type` traz só o tipo `RawYtDlpVideo`, que não existe em tempo de execução.
import type { RawYtDlpVideo } from "models/format";

const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

// TS: união `|` de dois formatos de objeto. O campo `type` com texto literal (`"audio"`) diz qual deles é.
export type Selection = { type: "audio" } | { type: "video"; formatId: string };

// TS: `type` cria um apelido para um formato de objeto. Só existe na checagem.
type RunOptions = {
  timeoutMs: number;
  // TS: `AbortSignal` é um tipo global (padrão web) usado para cancelamento. `?:` deixa o campo opcional.
  signal?: AbortSignal;
  binary?: string;
};

type RunResult = {
  stdout: string;
  stderr: string;
};

type BaseOptions = {
  // TS: união `string | null`: texto ou null.
  cookiesPath?: string | null;
  signal?: AbortSignal;
};

// Único ponto que executa o binário: sempre Bun.spawn([bin, ...args]), nunca shell.
// TS: `string[]` é um array de textos. A desestrutura do segundo parâmetro é tipada com `RunOptions`.
async function run(
  args: string[],
  { timeoutMs, signal, binary }: RunOptions,
): Promise<RunResult> {
  if (signal?.aborted) {
    throw abortError();
  }

  const executable = binary || config.get().ytdlpBinary;
  // TS: `ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>` obtém o tipo do subprocesso retornado pelo Bun.spawn com esses tipos de stdio.
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

  try {
    proc = Bun.spawn([executable, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
  } catch (error) {
    // TS: `NodeJS.ErrnoException` descreve erros de sistema com a propriedade `code` (ex.: ENOENT).
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ENOENT") {
      throw new ServicesError({
        message: "O yt-dlp não foi encontrado no servidor.",
        action: "Instale o yt-dlp ou ajuste YTDLP_BINARY.",
        cause: error,
      });
    }
    throw new YtDlpFailedError({ cause: error });
  }

  // TS: união com null: `failure` é um Error ou null. Testes como `if (failure)` estreitam o tipo.
  let failure: Error | null = null;

  function stop(error: Error) {
    if (failure) return;
    failure = error;
    proc.kill("SIGKILL");
  }

  const timeoutTimer = setTimeout(() => {
    stop(
      new YtDlpFailedError({
        message: "O yt-dlp demorou demais para responder.",
        action: "Tente novamente ou escolha uma qualidade menor.",
        statusCode: 504,
      }),
    );
  }, timeoutMs);

  const onAbort = () => stop(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamLimited(proc.stdout, MAX_STDOUT_BYTES, () =>
        stop(
          new YtDlpFailedError({
            message: "A resposta do yt-dlp passou do tamanho esperado.",
          }),
        ),
      ),
      readStderrTail(proc.stderr, MAX_STDERR_BYTES),
      proc.exited,
    ]);

    if (failure) throw failure;
    if (exitCode !== 0) throw errorFromStderr(stderr);

    return { stdout, stderr };
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimitExceeded: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        onLimitExceeded();
        await reader.cancel();
        return "";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readStderrTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stderr = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr = (stderr + decoder.decode(value, { stream: true })).slice(
        -maxBytes,
      );
    }
    stderr = (stderr + decoder.decode()).slice(-maxBytes);
  } finally {
    reader.releaseLock();
  }

  return stderr;
}

function abortError() {
  return new YtDlpFailedError({
    message: "A operação foi cancelada.",
    action: "Inicie o download novamente.",
    statusCode: 499,
  });
}

// TS: `: Error` é o tipo de retorno. As classes de erro do projeto são subtipos dele.
function errorFromStderr(stderr: string): Error {
  const lastError =
    stderr
      .split("\n")
      .filter((line) => line.startsWith("ERROR:"))
      // TS: `pop()` pode devolver undefined (array vazio); o `||` cobre esse caso.
      .pop() || stderr.trim();

  if (/Unsupported URL/i.test(lastError)) {
    return new UnsupportedPlatformError({ cause: lastError });
  }

  if (
    /private video|video is private|video unavailable|video is unavailable|has been removed|no longer available|not available in your country|does not exist|HTTP Error 404/i.test(
      lastError,
    )
  ) {
    return new VideoUnavailableError({ cause: lastError });
  }

  if (
    /sign in to confirm|log ?in required|login required|log in for access|requires authentication|account credentials|--cookies/i.test(
      lastError,
    )
  ) {
    return new LoginRequiredError({ cause: lastError });
  }

  return new YtDlpFailedError({ cause: lastError });
}

// TS: `cookiesPath?` é parâmetro opcional: pode ser omitido. Também pode receber null.
function baseArgs(cookiesPath?: string | null) {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-cache-dir",
    "--no-progress",
    "--no-color",
  ];
  const proxy = process.env.YTDLP_PROXY;
  if (proxy) args.push("--proxy", proxy, "--hls-prefer-native");
  if (cookiesPath) args.push("--cookies", cookiesPath);

  // O YouTube exige um runtime JS; no Docker usamos o próprio Bun.
  const { jsRuntimes } = config.get();
  if (jsRuntimes && /^[A-Za-z0-9_.,:/-]+$/.test(jsRuntimes)) {
    args.push("--js-runtimes", jsRuntimes);
  }
  return args;
}

// Versões para /api/v1/status; null quando o binário não responde.
// TS: sem anotação de retorno; o TS infere o formato do objeto a partir do `return`.
async function versions() {
  const [ytdlpVersion, ffmpegVersion] = await Promise.all([
    readVersion(["--version"]),
    readVersion(["-version"], "ffmpeg"),
  ]);

  return {
    ytdlp: ytdlpVersion,
    // TS: `?.` e `??` são JavaScript: `?.` para se o valor for null; `??` usa o valor da direita nesse caso.
    ffmpeg: ffmpegVersion?.match(/ffmpeg version (\S+)/)?.[1] ?? ffmpegVersion,
  };

  async function readVersion(args: string[], binary?: string) {
    try {
      const { stdout } = await run(args, { timeoutMs: 10_000, binary });
      return stdout.trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  }
}

// TS: `options: BaseOptions = {}` tem tipo e valor padrão; `{}` serve porque todos os campos são opcionais.
async function inspect(url: string, options: BaseOptions = {}) {
  const args = [...baseArgs(options.cookiesPath), "-J", "--", url];
  const { stdout } = await run(args, {
    timeoutMs: config.get().inspectTimeoutMs,
    signal: options.signal,
  });

  try {
    // TS: `as` afirma o tipo: `JSON.parse` devolve `any`, e o TS passa a tratar o resultado como `RawYtDlpVideo` sem validar.
    return JSON.parse(stdout) as RawYtDlpVideo;
    // TS: no modo strict, o erro capturado é do tipo `unknown`; por isso ele só é repassado em `cause`.
  } catch (error) {
    throw new YtDlpFailedError({
      message: "O yt-dlp devolveu uma resposta inválida.",
      cause: error,
    });
  }
}

export type DownloadedFile = {
  filePath: string;
  title: string;
  ext: string;
  size: number;
};

// TS: `Promise<DownloadedFile>` no retorno diz o que a função async entrega quando termina.
async function download(
  url: string,
  selection: Selection,
  // TS: `&` é interseção: `options` precisa ter os campos de BaseOptions e também `directory`.
  options: BaseOptions & { directory: string; infoJson?: string },
): Promise<DownloadedFile> {
  const { maxDurationSeconds, maxFilesizeBytes, downloadTimeoutMs } =
    config.get();

  const infoPath = options.infoJson
    ? path.join(options.directory, "inspection.json")
    : null;
  if (infoPath)
    await fs.writeFile(infoPath, options.infoJson!, { mode: 0o600 });
  const fragmentConcurrency = Number(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || 4,
  );
  if (
    !Number.isInteger(fragmentConcurrency) ||
    fragmentConcurrency < 1 ||
    fragmentConcurrency > 4
  ) {
    throw new ValidationError({
      message: "Concorrência de fragmentos inválida (1–4).",
    });
  }
  const args = [
    ...baseArgs(options.cookiesPath),
    "--concurrent-fragments",
    String(fragmentConcurrency),
    "--no-mtime",
    "--match-filter",
    `!is_live & duration <=? ${maxDurationSeconds}`,
    "--max-filesize",
    String(maxFilesizeBytes),
    "-P",
    options.directory,
    "-o",
    "video.%(ext)s",
    ...selectionArgs(selection),
    "--no-simulate",
    "--print",
    "after_move:%(.{title,filepath,ext})j",
    ...(infoPath ? ["--load-info-json", infoPath] : ["--", url]),
  ];

  const { stdout } = await run(args, {
    timeoutMs: downloadTimeoutMs,
    signal: options.signal,
  });

  const printed = parsePrinted(stdout);
  if (!printed) {
    // Com --match-filter e --max-filesize o yt-dlp pula o vídeo e sai com 0.
    throw new ValidationError({
      message: "O vídeo passa do limite de duração ou de tamanho do servidor.",
      action: "Escolha uma qualidade menor ou um vídeo mais curto.",
    });
  }

  const directory = path.resolve(options.directory);
  const filePath = path.resolve(printed.filepath);
  if (path.dirname(filePath) !== directory) {
    throw new YtDlpFailedError({
      message: "O yt-dlp gravou o arquivo fora do diretório esperado.",
    });
  }

  const stat = await fs.lstat(filePath).catch(() => null);
  // TS: `stat?.isFile()` só é verdadeiro se `stat` existir. Depois do `if`, o TS trata `stat` como não-null.
  if (!stat?.isFile()) {
    throw new YtDlpFailedError({
      message: "O yt-dlp terminou sem gerar o arquivo.",
    });
  }

  if (stat.size > maxFilesizeBytes)
    throw new ValidationError({
      message: "Arquivo gerado ultrapassa o limite permitido.",
    });
  return {
    filePath,
    title: printed.title || "video",
    ext: printed.ext || path.extname(filePath).slice(1),
    size: stat.size,
  };
}

function selectionArgs(selection: Selection) {
  if (selection.type === "audio") {
    return [
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
    ];
  }

  // TS: união discriminada: o `if` com `type === "audio"` deixa só o formato de vídeo, que tem `formatId`.
  const id = selection.formatId;
  return [
    "-f",
    `${id}+bestaudio[ext=m4a]/${id}+bestaudio/${id}`,
    "--merge-output-format",
    "mp4",
  ];
}

function parsePrinted(stdout: string) {
  const lastLine = stdout.trim().split("\n").pop();
  if (!lastLine) return null;
  try {
    // TS: `as` com tipo de objeto: afirma o formato esperado, mas os campos podem faltar, por isso são opcionais (`?:`).
    const value = JSON.parse(lastLine) as {
      title?: string;
      filepath?: string;
      ext?: string;
    };
    // TS: o teste `value.filepath ?` estreita o tipo: dentro do ramo, `filepath` é string e não undefined.
    return value.filepath ? { ...value, filepath: value.filepath } : null;
  } catch {
    return null;
  }
}

const ytdlp = {
  versions,
  inspect,
  download,
};

export default ytdlp;
