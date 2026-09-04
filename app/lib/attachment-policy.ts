export const MAX_ATTACHMENT_FILES = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_OFFICE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const SUPPORTED_MEDIA_TYPES = new Set(Object.values(MEDIA_TYPES_BY_EXTENSION));

export const ATTACHMENT_ACCEPT = Object.keys(MEDIA_TYPES_BY_EXTENSION).join(",");

export type AttachmentCandidate = {
  name: string;
  size: number;
  type?: string;
};

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

export function inferAttachmentMediaType(file: AttachmentCandidate): string | null {
  const declared = file.type?.trim().toLowerCase();
  if (declared && SUPPORTED_MEDIA_TYPES.has(declared)) return declared;
  return MEDIA_TYPES_BY_EXTENSION[extensionOf(file.name)] ?? null;
}

export function estimateDataUrlBytes(url: string): number {
  const comma = url.indexOf(",");
  if (comma < 0) return 0;
  const payload = url.slice(comma + 1);
  return /;base64,/i.test(url.slice(0, comma + 1))
    ? Math.floor((payload.length * 3) / 4)
    : new TextEncoder().encode(decodeURIComponent(payload)).length;
}

export function validateAttachment(
  file: AttachmentCandidate,
  acceptedCount: number,
  acceptedBytes: number,
): string | null {
  const mediaType = inferAttachmentMediaType(file);
  if (!mediaType) {
    return `${file.name}：暂不支持该格式；当前支持图片、文本及 DOCX/XLSX/PPTX。`;
  }
  if (acceptedCount >= MAX_ATTACHMENT_FILES) {
    return `每次最多上传 ${MAX_ATTACHMENT_FILES} 个附件。`;
  }
  const isOffice = mediaType.includes("openxmlformats-officedocument");
  const perFileLimit = mediaType.startsWith("image/")
    ? MAX_IMAGE_ATTACHMENT_BYTES
    : isOffice
      ? MAX_OFFICE_ATTACHMENT_BYTES
      : MAX_TEXT_ATTACHMENT_BYTES;
  if (file.size > perFileLimit) {
    const limitMb = perFileLimit / 1024 / 1024;
    const kind = mediaType.startsWith("image/")
      ? "图片"
      : isOffice
        ? "办公文档"
        : "文本";
    return `${file.name}：文件过大，${kind}上限为 ${limitMb} MB。`;
  }
  if (acceptedBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `附件总大小不能超过 ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB。`;
  }
  return null;
}
