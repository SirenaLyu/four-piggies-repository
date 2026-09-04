import type JSZip from "jszip";
import type { JSZipObject } from "jszip";

const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_XML_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 12 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 200_000;

const OFFICE_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

type ZipObjectWithSize = JSZipObject & {
  _data?: { uncompressedSize?: number };
};

export function isOfficeAttachmentMediaType(mediaType: string): boolean {
  return OFFICE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlToText(xml: string, paragraphTag: string): string {
  return decodeXml(
    xml
      .replace(new RegExp(`<${paragraphTag}\\b[^>]*>`, "gi"), "")
      .replace(new RegExp(`</${paragraphTag}>`, "gi"), "\n")
      .replace(/<(?:w:tab|a:tab)\b[^>]*\/?\s*>/gi, "\t")
      .replace(/<(?:w:br|a:br)\b[^>]*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function entrySize(entry: JSZipObject): number | undefined {
  return (entry as ZipObjectWithSize)._data?.uncompressedSize;
}

async function readXml(
  entry: JSZipObject | null | undefined,
  consumed: { bytes: number },
): Promise<string> {
  if (!entry || entry.dir) return "";
  const declaredSize = entrySize(entry);
  if (declaredSize !== undefined && declaredSize > MAX_XML_BYTES) {
    throw new Error("办公文档内部 XML 过大，已拒绝提取");
  }
  const xml = await entry.async("string");
  const bytes = new TextEncoder().encode(xml).length;
  if (bytes > MAX_XML_BYTES || consumed.bytes + bytes > MAX_TOTAL_XML_BYTES) {
    throw new Error("办公文档解压后内容过大，已拒绝提取");
  }
  consumed.bytes += bytes;
  return xml;
}

function truncate(text: string): string {
  const normalized = text.trim();
  return normalized.length > MAX_EXTRACTED_TEXT_CHARS
    ? `${normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[内容已截断]`
    : normalized;
}

async function extractDocx(
  zip: JSZip,
  consumed: { bytes: number },
): Promise<string> {
  const xml = await readXml(zip.file("word/document.xml"), consumed);
  return xmlToText(xml, "w:p");
}

function sharedStringsFrom(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    xmlToText(match[1], "r"),
  );
}

function cellText(cellAttributes: string, cellBody: string, shared: string[]): string {
  const type = /\bt=["']([^"']+)["']/i.exec(cellAttributes)?.[1] ?? "";
  if (type === "inlineStr") return xmlToText(cellBody, "r");
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cellBody)?.[1] ?? "";
  if (type === "s") return shared[Number(value)] ?? "";
  return decodeXml(value).trim();
}

async function extractXlsx(
  zip: JSZip,
  consumed: { bytes: number },
): Promise<string> {
  const sharedXml = await readXml(zip.file("xl/sharedStrings.xml"), consumed);
  const shared = sharedStringsFrom(sharedXml);
  const sheetNames = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const sheets: string[] = [];
  for (const [index, name] of sheetNames.entries()) {
    const xml = await readXml(zip.file(name), consumed);
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)]
      .map((row) =>
        [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)]
          .map((cell) => cellText(cell[1], cell[2], shared))
          .join("\t"),
      )
      .filter(Boolean);
    if (rows.length > 0) sheets.push(`## 工作表 ${index + 1}\n${rows.join("\n")}`);
  }
  return sheets.join("\n\n");
}

async function extractPptx(
  zip: JSZip,
  consumed: { bytes: number },
): Promise<string> {
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const slides: string[] = [];
  for (const [index, name] of slideNames.entries()) {
    const xml = await readXml(zip.file(name), consumed);
    const text = xmlToText(xml, "a:p");
    if (text) slides.push(`## 幻灯片 ${index + 1}\n${text}`);
  }
  return slides.join("\n\n");
}

export async function extractOfficeArchive(
  archive: ArrayBuffer,
  filename: string,
): Promise<string> {
  const { default: JSZipRuntime } = await import("jszip");
  const zip = await JSZipRuntime.loadAsync(archive);
  if (Object.keys(zip.files).length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("办公文档内部文件数量过多，已拒绝提取");
  }
  const consumed = { bytes: 0 };
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  let text = "";
  if (extension === ".docx") text = await extractDocx(zip, consumed);
  else if (extension === ".xlsx") text = await extractXlsx(zip, consumed);
  else if (extension === ".pptx") text = await extractPptx(zip, consumed);
  else throw new Error("不支持的办公文档格式");
  const result = truncate(text);
  if (!result) throw new Error("未能从办公文档中提取到文本");
  return result;
}

export async function extractOfficeAttachmentText(file: File): Promise<string> {
  return extractOfficeArchive(await file.arrayBuffer(), file.name);
}
