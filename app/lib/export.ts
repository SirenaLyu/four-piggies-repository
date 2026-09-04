export type ExportFileFormat = "code" | "markdown" | "docx" | "pdf" | "text";

export type ExportFileDescriptor = {
  filename: string;
  format: ExportFileFormat;
  language?: string;
  content: string;
};

/**
 * 把 ExportFileDescriptor 转为 Blob 并触发浏览器下载。
 * docx / jspdf 通过动态 import 按需加载，不进首屏 bundle。
 */
export async function downloadExportFile(f: ExportFileDescriptor): Promise<void> {
  const blob = await fileToBlob(f);
  triggerDownload(blob, f.filename);
}

async function fileToBlob(f: ExportFileDescriptor): Promise<Blob> {
  switch (f.format) {
    case "code":
    case "markdown":
    case "text":
      return new Blob([f.content], { type: "text/plain;charset=utf-8" });
    case "docx":
      return buildDocxBlob(f.content);
    case "pdf":
      return buildPdfBlob(f.content);
    default:
      return new Blob([f.content], { type: "text/plain;charset=utf-8" });
  }
}

async function buildDocxBlob(content: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const paragraphs = content
    .split(/\n{2,}/)
    .map((para) =>
      new Paragraph({
        children: [new TextRun(para.replace(/\n/g, " "))],
      }),
    );
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return await Packer.toBlob(doc);
}

async function buildPdfBlob(content: string): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  // jsPDF 的内置 Helvetica 不包含中文字形。本地应用直接使用浏览器
  // 已安装字体绘制到画布，再逐页嵌入 PDF，避免中文变成方框或空白。
  const canvas = document.createElement("canvas");
  canvas.width = 1240;
  canvas.height = 1754;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建 PDF 绘图上下文");

  const margin = 88;
  const lineHeight = 44;
  context.font =
    '28px "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", sans-serif';
  context.textBaseline = "top";

  const lines = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) =>
      wrapTextByWidth(
        line,
        canvas.width - margin * 2,
        (value) => context.measureText(value).width,
      ),
    );
  if (lines.length === 0) lines.push("");

  let offset = 0;
  let pageIndex = 0;
  while (offset < lines.length) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111827";
    let y = margin;
    while (offset < lines.length && y + lineHeight <= canvas.height - margin) {
      context.fillText(lines[offset], margin, y);
      offset += 1;
      y += lineHeight;
    }
    if (pageIndex > 0) pdf.addPage();
    pdf.addImage(
      canvas.toDataURL("image/jpeg", 0.94),
      "JPEG",
      0,
      0,
      pdf.internal.pageSize.getWidth(),
      pdf.internal.pageSize.getHeight(),
    );
    pageIndex += 1;
  }
  return pdf.output("blob");
}

export function wrapTextByWidth(
  text: string,
  maxWidth: number,
  measureWidth: (value: string) => number,
): string[] {
  if (!(maxWidth > 0)) throw new Error("maxWidth 必须大于 0");
  const lines: string[] = [];
  let current = "";
  for (const character of Array.from(text)) {
    const candidate = current + character;
    if (current && measureWidth(candidate) > maxWidth) {
      lines.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current || text.length === 0) lines.push(current);
  return lines;
}

export function sanitizeDownloadFilename(filename: string): string {
  const normalized = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 180);
  return normalized || "download";
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeDownloadFilename(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 下载纯文本代码块（用于 AI 回复中的 Markdown 代码块直接下载按钮）。
 */
export function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  triggerDownload(blob, filename);
}
