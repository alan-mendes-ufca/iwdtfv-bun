import fs from "node:fs/promises";
import config from "infra/config";
import { LoginRequiredError, ServicesError } from "infra/errors";
import type { TempJob } from "infra/tempfiles";
import type { Provider } from "models/provider";

type Options = { principal?: string; signal?: AbortSignal };

export async function validateYouTubeCookies(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) {
    throw new ServicesError({
      message: "Arquivo de sessão indisponível ou com permissões inadequadas.",
    });
  }
  const content = await fs.readFile(file, "utf8");
  if (!/^# (Netscape )?HTTP Cookie File/.test(content))
    throw new ServicesError({
      message: "Formato do arquivo de sessão inválido.",
    });
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    if (
      !line.trim() ||
      (line.startsWith("#") && !line.startsWith("#HttpOnly_"))
    )
      continue;
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    const domain = fields[0]?.replace(/^\./, "").toLowerCase();
    if (
      fields.length !== 7 ||
      !domain ||
      !(domain === "youtube.com" || domain.endsWith(".youtube.com"))
    ) {
      throw new ServicesError({
        message: "A sessão dedicada deve conter somente cookies do YouTube.",
      });
    }
    count++;
  }
  if (!count)
    throw new ServicesError({ message: "O arquivo de sessão está vazio." });
}

// Start anonymously. Exactly one authenticated retry is allowed, only for the owner
// and only on a genuine login-required result; other platforms never see this file.
export async function withOptionalCookies<T>(
  job: TempJob,
  provider: Provider,
  options: Options,
  operation: (cookiesPath: string | null) => Promise<T>,
): Promise<T> {
  try {
    return await operation(null);
  } catch (error) {
    const settings = config.get();
    if (
      !(error instanceof LoginRequiredError) ||
      settings.cookiesMode !== "fallback" ||
      !options.principal ||
      provider.name !== "youtube" ||
      !settings.cookiesFile
    )
      throw error;
    options.signal?.throwIfAborted();
    await validateYouTubeCookies(settings.cookiesFile);
    const copy = await job.copyCookies(settings.cookiesFile);
    return operation(copy);
  }
}
