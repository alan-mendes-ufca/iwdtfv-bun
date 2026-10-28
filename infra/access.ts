import { AccessDeniedError } from "infra/errors";

export function authenticate(request: Request): string | null {
  const mode = process.env.APP_AUTH_MODE || "none";
  if (mode === "none") return null;
  if (mode !== "tailscale") throw new AccessDeniedError();
  const allowed = (process.env.APP_ALLOWED_USERS || "")
    .split(",")
    .map((user) => user.trim().toLowerCase())
    .filter(Boolean);
  const login = request.headers
    .get("Tailscale-User-Login")
    ?.trim()
    .toLowerCase();
  if (!login || !allowed.includes(login)) throw new AccessDeniedError();
  return login;
}

// Tailscale identity headers are trusted ONLY behind Serve and its private gateway Unix socket.
// infra/compose.authenticated.yaml enforces that network boundary.
export function validateSecurityConfig() {
  const mode = process.env.APP_AUTH_MODE || "none";
  const cookies = process.env.YTDLP_COOKIES_MODE || "disabled";
  if (!["none", "tailscale"].includes(mode))
    throw new Error("APP_AUTH_MODE inválido.");
  if (!["disabled", "fallback"].includes(cookies))
    throw new Error("YTDLP_COOKIES_MODE inválido.");
  if (mode === "tailscale") {
    if (!process.env.APP_ALLOWED_USERS?.trim())
      throw new Error("Configure APP_ALLOWED_USERS.");
    const origin = new URL(process.env.APP_ORIGIN || "http://invalid");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("APP_ORIGIN deve ser a origem HTTPS do Tailscale Serve.");
    if (
      !process.env.ALLOWED_HOSTS?.split(",")
        .map((host) => host.trim())
        .includes(origin.hostname)
    )
      throw new Error("APP_ORIGIN precisa constar em ALLOWED_HOSTS.");
  }
  if (
    cookies === "fallback" &&
    (mode !== "tailscale" || !process.env.YTDLP_COOKIES_FILE)
  ) {
    throw new Error(
      "Cookies exigem acesso autenticado por Tailscale Serve e arquivo de sessão dedicada.",
    );
  }
}
