import { useEffect, useRef, useState, type FormEvent } from "react";
import type { VideoInfo } from "models/format";
import PixelBackground from "./PixelBackground";
import {
  monotonicProgress,
  preparationProgress,
  readDownloadResponse,
} from "./downloadProgress";

type Phase = "input" | "inspect" | "choose" | "download" | "done";
type ApiError = { message: string; action?: string };
const SERVER_ERROR = "Não foi possível falar com o servidor. Tente novamente.";

function AngryFace() {
  return (
    <div className="angry-mascot">
      <svg
        viewBox="0 0 24 24"
        role="img"
        aria-label="Rostinho irritado pixelado"
        shapeRendering="crispEdges"
      >
        <defs>
          <clipPath id="angry-face-shape">
            <path d="M8 1h8v1h3v2h2v3h1v3h1v4h-1v4h-2v3h-3v1H8v-1H5v-2H3v-3H2v-4H1v-4h1V7h2V4h2V2h2Z" />
          </clipPath>
        </defs>
        <g clipPath="url(#angry-face-shape)">
          <path fill="#c5c9cd" d="M0 0h24v24H0z" />
          <path fill="#a0a6ac" d="M0 12h24v12H0z" />
          <path fill="#747c84" d="M0 19h24v5H0z" />
          <path fill="#e7e9eb" d="M6 3h3v1H6zM4 5h2v2H4zM3 8h1v3H3z" />
          <path
            fill="#121619"
            d="M5 6h3v1h2v1h2v3h-2v-1H8V9H5zM19 6h-3v1h-2v1h-2v3h2v-1h2V9h3zM7 11h3v3H7zM14 11h3v3h-3zM8 18v-2h2v-1h4v1h2v2h-2v-1h-4v1z"
          />
        </g>
        <path fill="#e7e9eb" d="M20 0h1v2h2v1h-3zM23 4h1v3h-1V5h-2V4z" />
      </svg>
    </div>
  );
}

function Logo() {
  return (
    <h1 className="logo">
      <span>I want to</span> <span>download</span> <span>this f***ing</span>{" "}
      <span>video</span>
    </h1>
  );
}

export default function Home() {
  const [inputUrl, setInputUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [inspected, setInspected] = useState<{
    sourceUrl: string;
    video: VideoInfo;
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const operation = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState(0);
  const [transferKnown, setTransferKnown] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const busy = phase === "inspect" || phase === "download";

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (!busy || transferring) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      setProgress((current) =>
        monotonicProgress(
          current,
          preparationProgress(performance.now() - started),
        ),
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [busy, transferring]);
  useEffect(() => {
    if (phase !== "done") return;
    const timer = window.setTimeout(() => {
      setInputUrl("");
      setInspected(null);
      setPhase("input");
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current || phase === "done") return;
    const controller = new AbortController();
    operation.current = controller;
    setProgress(0);
    setTransferring(false);
    setTransferKnown(false);
    setError(null);
    setInspected(null);
    setPhase("inspect");
    try {
      const sourceUrl = inputUrl.trim();
      const response = await fetch("/api/v1/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
        signal: controller.signal,
      });
      if (operation.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        setError(await readError(response));
        setPhase("input");
        return;
      }
      const video = (await response.json()) as VideoInfo;
      if (operation.current !== controller || controller.signal.aborted) return;
      if (!video.formats.length && !video.audio_available) {
        setError({ message: "Nenhuma qualidade disponível para este vídeo." });
        setPhase("input");
        return;
      }
      setInspected({ sourceUrl, video });
      setPhase("choose");
    } catch {
      if (!controller.signal.aborted) setError({ message: SERVER_ERROR });
      if (operation.current === controller) setPhase("input");
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  async function handleDownload(formatId: string) {
    if (!inspected || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setProgress(0);
    setTransferring(false);
    setTransferKnown(false);
    setError(null);
    setPhase("download");
    try {
      const response = await fetch("/api/v1/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: inspected.sourceUrl, format_id: formatId }),
        signal: controller.signal,
      });
      if (operation.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        setError(await readError(response));
        setPhase("choose");
        return;
      }
      setTransferring(true);
      setProgress((current) => monotonicProgress(current, 75));
      const blob = await readDownloadResponse(
        response,
        controller.signal,
        (next, known) => {
          if (operation.current !== controller || controller.signal.aborted)
            return;
          setTransferKnown(known);
          setProgress((current) => monotonicProgress(current, next));
        },
      );
      if (controller.signal.aborted || operation.current !== controller) return;
      saveBlob(
        blob,
        filenameFromDisposition(response.headers.get("Content-Disposition")),
      );
      setProgress(100);
      setPhase("done");
    } catch {
      if (!controller.signal.aborted) setError({ message: SERVER_ERROR });
      if (operation.current === controller) setPhase("choose");
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  return (
    <main className="page">
      <PixelBackground />
      <section className="download-app" aria-label="Baixar vídeo">
        <AngryFace />
        <Logo />
        <div className={`shell ${busy ? "shell-busy" : ""}`} aria-busy={busy}>
          {busy || phase === "done" ? (
            <div className="loading-stage" key="loading">
              <div
                className={`progress-track ${phase === "done" ? "progress-done" : ""}`}
                role="progressbar"
                aria-label={
                  phase === "inspect"
                    ? "Buscando qualidades"
                    : phase === "done"
                      ? "Arquivo enviado ao navegador"
                      : "Preparando e baixando vídeo"
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={phase === "done" ? 100 : progress}
                aria-valuetext={
                  phase === "done"
                    ? "Download concluído"
                    : transferring && transferKnown
                      ? "Transferência do arquivo em andamento"
                      : "Estimativa durante preparação ou transferência sem tamanho conhecido"
                }
              >
                <div
                  className="progress-beam"
                  style={{ width: `${phase === "done" ? 100 : progress}%` }}
                />
              </div>
              {busy ? (
                <button
                  className="cancel"
                  type="button"
                  onClick={() => {
                    operation.current?.abort();
                    operation.current = null;
                    setPhase(phase === "inspect" ? "input" : "choose");
                  }}
                  aria-label={
                    phase === "inspect"
                      ? "Cancelar consulta"
                      : "Cancelar download"
                  }
                  title="Cancelar"
                >
                  ×
                </button>
              ) : (
                <span className="done-mark" aria-hidden="true">
                  ✓
                </span>
              )}
            </div>
          ) : (
            <div className="form-stage" key="form">
              <form className="url-form" onSubmit={handleSubmit}>
                <span className="prompt" aria-hidden="true">
                  ❯
                </span>
                <label className="sr-only" htmlFor="video-url">
                  Link do vídeo
                </label>
                <input
                  id="video-url"
                  name="url"
                  type="url"
                  required
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Cole o link do vídeo"
                  value={inputUrl}
                  onChange={(event) => {
                    setInputUrl(event.target.value);
                    setInspected(null);
                    setError(null);
                    setPhase("input");
                  }}
                  aria-describedby={error ? "download-error" : undefined}
                />
                <button
                  className="submit"
                  type="submit"
                  aria-label="Ver qualidades"
                  title="Ver qualidades"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 12h14m-6-6 6 6-6 6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </form>
              {phase === "choose" && inspected ? (
                <div
                  className="quality-stage"
                  role="group"
                  aria-label="Escolha a qualidade"
                >
                  {inspected.video.formats.map((format) => (
                    <button
                      key={format.format_id}
                      className="quality"
                      type="button"
                      onClick={() => handleDownload(format.format_id)}
                    >
                      {format.quality}
                    </button>
                  ))}
                  {inspected.video.audio_available ? (
                    <button
                      className="quality quality-audio"
                      type="button"
                      onClick={() => handleDownload("audio")}
                    >
                      Áudio <span>mp3</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
        {error ? (
          <div id="download-error" className="error" role="alert">
            <p>{error.message}</p>
            {error.action ? (
              <p className="error-action">{error.action}</p>
            ) : null}
          </div>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">
          {phase === "done"
            ? "Arquivo enviado ao navegador. Confira os downloads do seu dispositivo."
            : phase === "choose"
              ? "Escolha a qualidade do download."
              : ""}
        </span>
      </section>
      <style>{CSS}</style>
    </main>
  );
}

async function readError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return {
      message: body.message,
      action:
        "action" in body && typeof body.action === "string"
          ? body.action
          : undefined,
    };
  }
  return { message: SERVER_ERROR };
}

function filenameFromDisposition(header: string | null): string {
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header || "")?.[1];
  if (extended) {
    try {
      return decodeURIComponent(extended.trim());
    } catch {
      /* Fall back to the plain filename. */
    }
  }
  return /filename="([^"]+)"/i.exec(header || "")?.[1] || "download";
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const CSS = `
  :root { color-scheme: dark; --bg:#080a0b; --surface:#111416; --border:#42474b; --text:#e3e5e7; --muted:#969da3; --accent:#d4d9dd; }
  * { box-sizing:border-box; }
  html, body, #root { margin:0; min-height:100%; background:var(--bg); }
  body, button, input { font-family:"Silkscreen", "SFMono-Regular", Consolas, monospace; }
  button, input { font-size:16px; }
  button { -webkit-tap-highlight-color:transparent; }
  .page { position:relative; isolation:isolate; min-height:100svh; display:grid; place-items:center; padding:32px 24px; color:var(--text); }
  .download-app { position:relative; z-index:1; width:min(100%, 560px); display:flex; flex-direction:column; align-items:center; gap:40px; animation:arrive 600ms ease both; }
  .angry-mascot { width:96px; height:96px; margin-bottom:-12px; animation:grumble 5s steps(2,end) infinite; }
  .angry-mascot svg { display:block; width:100%; height:100%; }
  @keyframes grumble { 0%,78%,100% { transform:translateY(0) rotate(0); } 80%,88% { transform:translateY(-2px) rotate(-3deg); } 84%,92% { transform:translateY(-2px) rotate(3deg); } 96% { transform:translateY(0) rotate(0); } }
  .logo { display:block; width:100%; margin:0; color:var(--text); text-align:center; font-size:clamp(30px,10.5vw,64px); font-weight:400; line-height:1.2; letter-spacing:-.04em; font-synthesis:none; }
  .logo span { display:block; white-space:nowrap; background:linear-gradient(to bottom,#f0f1f2 0%,#f0f1f2 40%,#a7aaad 41%,#72767a 72%,#454b50 73%,#343a3f 100%); background-clip:text; -webkit-background-clip:text; color:transparent; }
  .shell { width:100%; border:1px solid var(--border); border-radius:0; background:#111416f2; box-shadow:0 12px 40px #00000033; transition:border-color 180ms, box-shadow 180ms; }
  .shell:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px #d4d9dd10,0 12px 40px #0c0e101a; }
  .url-form { display:flex; gap:12px; align-items:center; padding:8px 9px 8px 19px; min-height:64px; }
  .prompt { color:var(--accent); font-size:17px; user-select:none; }
  .url-form input { width:0; flex:1; min-width:0; padding:12px 0; outline:none; border:0; background:transparent; color:var(--text); caret-color:var(--accent); }
  .url-form input::placeholder { color:var(--muted); opacity:1; font-size:14px; }
  .submit { border:0; border-radius:0; display:grid; place-items:center; width:44px; height:44px; flex:none; color:var(--accent); background:#d4d9dd12; cursor:pointer; transition:background 160ms, transform 160ms; }
  .submit:hover { background:#d4d9dd25; transform:translateX(2px); }
  .submit:active { transform:scale(.94); }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:4px; }
  .quality-stage { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; border-top:1px solid #42474b80; padding:16px; animation:reveal 200ms ease both; }
  .quality { min-height:44px; padding:10px 15px; background:transparent; border:1px solid var(--border); border-radius:0; color:var(--text); cursor:pointer; font-size:13px; transition:background 150ms, border-color 150ms, color 150ms, transform 150ms; }
  .quality:hover { color:var(--accent); border-color:var(--accent); background:#d4d9dd0d; transform:translateY(-2px); }
  .quality:active { transform:translateY(0); }
  .quality-audio span { font-size:10px; color:var(--muted); }
  .shell-busy { border-color:#42474b99; }
  .loading-stage { min-height:64px; display:flex; align-items:center; gap:18px; padding:14px 16px 14px 22px; animation:reveal 220ms ease both; }
  .progress-track { flex:1; height:18px; overflow:hidden; position:relative; border:1px solid #747c84; border-radius:0; background:#292e32; }
  .progress-beam { height:100%; position:absolute; left:0; border-radius:0; background:repeating-linear-gradient(90deg,#c5c9cd 0 12px,#e7e9eb 12px 14px,#747c84 14px 16px); transition:width 240ms steps(1,end); }
  .progress-done .progress-beam { background:repeating-linear-gradient(90deg,#e7e9eb 0 14px,#a0a6ac 14px 16px); }
  .cancel { flex:none; display:grid; place-items:center; width:32px; height:36px; padding:0; border:0; border-radius:0; background:none; color:var(--muted); font-size:22px; cursor:pointer; transition:color 150ms, background 150ms; }
  .cancel:hover { color:var(--text); background:#42474b40; }
  .done-mark { width:32px; text-align:center; color:var(--accent); animation:reveal 200ms ease both; }
  .form-stage { animation:reveal 180ms ease both; }
  .error { width:100%; margin-top:-20px; color:#f7768e; font-size:13px; line-height:1.8; text-align:center; overflow-wrap:anywhere; animation:reveal 180ms ease both; }
  .error p { margin:0; }
  .error-action { color:var(--muted); margin-top:4px!important; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  @keyframes reveal { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
  @keyframes arrive { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
  @keyframes finish { from { opacity:.45; } to { opacity:1; } }
  @media (max-width:480px) { .page { padding:24px 20px; } .download-app { gap:32px; } .url-form { gap:10px; padding-left:15px; } .quality-stage { padding:14px; } }
  @media (prefers-reduced-motion:reduce) { *, *::before, *::after { animation:none!important; transition:none!important; } }
`;
