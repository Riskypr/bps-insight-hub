import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const storageDirectory = resolve(process.env.PDF_STORAGE_DIR ?? ".storage/pdfs");

function keyPath(storageKey: string) {
  // Storage keys are generated internally; this also prevents path traversal if a DB record is altered.
  if (!/^[a-f0-9-]+\.pdf$/i.test(storageKey)) throw new Error("Invalid storage key");
  return resolve(storageDirectory, storageKey);
}

export const pdfStorage = {
  async put(storageKey: string, content: Uint8Array) {
    const path = keyPath(storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  },
  get(storageKey: string) {
    return readFile(keyPath(storageKey));
  },
  async remove(storageKey: string) {
    try {
      await unlink(keyPath(storageKey));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
};
