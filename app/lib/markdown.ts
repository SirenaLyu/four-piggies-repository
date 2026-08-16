export type CodeBlock = {
  language: string;
  code: string;
};

/**
 * 从 Markdown 文本中提取所有围栏代码块。
 * 匹配 ```lang\ncode``` 形式。
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const re = /```(\w+)?[^\n]*\n([\s\S]*?)```/g;
  const blocks: CodeBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({
      language: (m[1] ?? "text").toLowerCase(),
      code: m[2].replace(/\n$/, ""),
    });
  }
  return blocks;
}

const EXTENSION_MAP: Record<string, string> = {
  python: "py",
  py: "py",
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  markdown: "md",
  md: "md",
  json: "json",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  html: "html",
  css: "css",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  go: "go",
  rust: "rs",
  rs: "rs",
  ruby: "rb",
  php: "php",
  sql: "sql",
  yaml: "yaml",
  yml: "yml",
  xml: "xml",
  toml: "toml",
  ini: "ini",
  text: "txt",
  txt: "txt",
  plain: "txt",
};

export function languageToExtension(lang: string): string {
  return EXTENSION_MAP[lang.toLowerCase()] ?? "txt";
}
