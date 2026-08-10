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
  const margin = 40;
  const maxWidth = pdf.internal.pageSize.getWidth() - margin * 2;
  const pageHeight = pdf.internal.pageSize.getHeight();
  const lines = pdf.splitTextToSize(content, maxWidth) as string[];
  let y = margin;
  for (const line of lines) {
    if (y > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
    pdf.text(line, margin, y);
    y += 16;
  }
  return pdf.output("blob");
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
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
