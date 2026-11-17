import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type { FileRecord, KnowledgeChunkRecord, PersistenceAdapter } from "./persistence.js";

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".docx", ".csv", ".json", ".png", ".jpg", ".jpeg", ".webp",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".css", ".html", ".xml", ".yaml", ".yml",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ts": "text/plain", ".tsx": "text/plain",
  ".js": "text/javascript", ".jsx": "text/javascript", ".py": "text/plain", ".go": "text/plain",
  ".rs": "text/plain", ".java": "text/plain", ".css": "text/css", ".html": "text/html",
  ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
};

const isImage = (extension: string) => [".png", ".jpg", ".jpeg", ".webp"].includes(extension);

export type ExtractedDocument = {
  text: string;
  metadata: Record<string, unknown>;
  pages?: Array<{ page: number; text: string }>;
};

export const validateUpload = (name: string, size: number) => {
  const extension = extname(name).toLowerCase();
  if (!basename(name) || basename(name) !== name || name.includes("\0")) throw new Error("Invalid file name");
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error(`Unsupported file type: ${extension || "unknown"}`);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw new Error("File exceeds the 64 MB limit");
  return { extension, mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream", image: isImage(extension) };
};

export const extractDocument = async (buffer: Buffer, name: string): Promise<ExtractedDocument> => {
  const extension = extname(name).toLowerCase();
  if (isImage(extension)) {
    return { text: "", metadata: { media: true, filename: name } };
  }
  if (extension === ".pdf") {
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    const pages = parsed.text
      .split(/\f/)
      .map((text: string, index: number) => ({ page: index + 1, text: text.trim() }))
      .filter((page: { page: number; text: string }) => page.text);
    return { text: parsed.text.trim(), pages, metadata: { filename: name, pages: pages.length } };
  }
  if (extension === ".docx") {
    const parsed = await mammoth.extractRawText({ buffer });
    return { text: parsed.value.trim(), metadata: { filename: name, messages: parsed.messages } };
  }
  const text = buffer.toString("utf8");
  if (extension === ".json") {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), metadata: { filename: name, format: "json" } };
    } catch {
      throw new Error("Invalid JSON document");
    }
  }
  return { text: text.trim(), metadata: { filename: name, format: extension.slice(1) } };
};

export const chunkDocument = (
  file: FileRecord,
  extracted: ExtractedDocument,
  chunkSize = 1200,
  overlap = 200,
): Omit<KnowledgeChunkRecord, "createdAt">[] => {
  const size = Math.max(200, Math.min(10_000, chunkSize));
  const step = Math.max(1, size - Math.min(overlap, size - 1));
  const pages = extracted.pages?.length ? extracted.pages : [{ page: undefined, text: extracted.text }];
  const chunks: Omit<KnowledgeChunkRecord, "createdAt">[] = [];
  for (const page of pages) {
    for (let offset = 0; offset < page.text.length; offset += step) {
      const content = page.text.slice(offset, offset + size).trim();
      if (!content) continue;
      chunks.push({
        id: randomUUID(),
        owner: file.owner,
        projectId: file.projectId,
        fileId: file.id,
        chunkIndex: chunks.length,
        content,
        page: page.page,
        metadata: { filename: file.originalName, offset, hash: createHash("sha256").update(content).digest("hex") },
      });
    }
  }
  return chunks;
};

export class FileStorage {
  private readonly root: string;
  constructor(root = join(process.cwd(), ".deepseek-ui", "files")) {
    this.root = resolve(root);
  }

  private path(storageKey: string) {
    const target = resolve(this.root, storageKey);
    if (!target.startsWith(`${this.root}\\`) && target !== this.root) throw new Error("Invalid storage key");
    return target;
  }

  async put(id: string, buffer: Buffer): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const storageKey = `${id}.bin`;
    await writeFile(this.path(storageKey), buffer, { flag: "wx" });
    return storageKey;
  }

  read(storageKey: string) {
    return readFile(this.path(storageKey));
  }

  async remove(storageKey: string) {
    await rm(this.path(storageKey), { force: true });
  }
}

export const processFile = async (store: PersistenceAdapter, storage: FileStorage, file: FileRecord) => {
  if (file.mimeType.startsWith("image/")) {
    await store.updateFile(file.id, file.owner, { extractionStatus: "completed", metadata: { ...file.metadata, media: true } });
    return;
  }
  await store.updateFile(file.id, file.owner, { extractionStatus: "processing" });
  try {
    const extracted = await extractDocument(await storage.read(file.storageKey), file.originalName);
    await store.updateFile(file.id, file.owner, {
      extractionStatus: "completed",
      extractedText: extracted.text,
      metadata: { ...file.metadata, ...extracted.metadata, pages: extracted.pages?.length ?? 0 },
    });
    await store.replaceKnowledgeChunks(file.id, file.owner, chunkDocument(file, extracted));
  } catch (error) {
    await store.updateFile(file.id, file.owner, {
      extractionStatus: "failed",
      extractionError: error instanceof Error ? error.message : String(error),
    });
  }
};
