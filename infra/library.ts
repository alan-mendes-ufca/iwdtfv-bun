import fs from "node:fs/promises";
import path from "node:path";
import config from "infra/config";
import { ServicesError, ValidationError } from "infra/errors";
import type { DownloadResult } from "models/video";

export type SavedFile = {
  id: string;
  filename: string;
  size: number;
  contentType: string;
};
const validId = /^[0-9a-f-]{36}$/;
export function downloadsDir() {
  return path.resolve(process.env.DOWNLOADS_DIR || "./downloads");
}
export async function ensureSpace() {
  const directory = downloadsDir();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const disk = await fs.statfs(directory);
  // Reserve enough for two source streams, merged output and a safety margin.
  const required =
    config.get().maxFilesizeBytes * 3 * config.get().maxConcurrentDownloads +
    Number(process.env.MIN_FREE_BYTES || 1073741824);
  if (disk.bavail * disk.bsize < required)
    throw new ServicesError({
      message: "Espaço livre insuficiente para um download seguro.",
    });
}
export async function saveFile(result: DownloadResult): Promise<SavedFile> {
  const id = crypto.randomUUID();
  const file = {
    id,
    filename: result.filename,
    size: result.size,
    contentType: result.contentType,
  };
  const destination = path.join(downloadsDir(), id);
  await fs.rename(result.filePath, destination);
  try {
    await Bun.write(destination + ".json.tmp", JSON.stringify(file));
    await fs.rename(destination + ".json.tmp", destination + ".json");
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  }
  return file;
}
export async function getFile(id: string): Promise<SavedFile | null> {
  if (!validId.test(id))
    throw new ValidationError({
      message: "Identificador de arquivo inválido.",
    });
  try {
    const metadata = path.join(downloadsDir(), id + ".json");
    if (!(await fs.lstat(metadata)).isFile()) return null;
    const file = (await Bun.file(metadata).json()) as SavedFile;
    const stat = await fs.lstat(path.join(downloadsDir(), id));
    if (
      !stat.isFile() ||
      file.id !== id ||
      typeof file.filename !== "string" ||
      file.size !== stat.size
    )
      return null;
    return file;
  } catch {
    return null;
  }
}
export async function listFiles() {
  await fs.mkdir(downloadsDir(), { recursive: true, mode: 0o700 });
  const names = await fs.readdir(downloadsDir());
  const files = await Promise.all(
    names.filter((name) => validId.test(name)).map(getFile),
  );
  return files.filter((file): file is SavedFile => file !== null);
}
export function filePath(id: string) {
  if (!validId.test(id))
    throw new ValidationError({ message: "Identificador inválido." });
  return path.join(downloadsDir(), id);
}
