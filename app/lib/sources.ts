export type AnswerSource = {
  id: string;
  kind: "knowledge" | "web";
  title: string;
  excerpt: string;
  url?: string;
  links?: Array<{ title: string; url: string }>;
  dataset?: string;
};

export function sourceTextId(text: string): string {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export function sourceAnchor(source: AnswerSource): string {
  return `source-${sourceTextId(source.id)}`;
}

export function sourceCitationCatalog(sources: AnswerSource[]): string {
  if (!sources.length) return "";
  return "\n可引用来源索引（仅在最终回答实际采用时附上对应引用）：\n" + sources.map((source) =>
    JSON.stringify({ citation: `[来源](${"#" + sourceAnchor(source)})`, title: source.title, excerpt: source.excerpt, url: source.url }),
  ).join("\n");
}

/** Explicit citations only; neither retrieved hits nor incidental URL mentions count. */
export function citedSources(text: string, candidates: AnswerSource[]): AnswerSource[] {
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  const anchors = new Set([...prose.matchAll(/\[[^\]\n]+\]\(#(source-[a-z0-9]+)\)/g)].map((match) => match[1]));
  return candidates.filter((source) => anchors.has(sourceAnchor(source)));
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

/** Extract only links actually present in retrieved text, never generated answer prose. */
export function linksInSource(text: string): Array<{ title: string; url: string }> {
  const links = new Map<string, string>();
  const remainingText = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s<>]+)\)/g, (_match, title: string, value: string) => {
    const url = safeSourceUrl(value);
    if (url) links.set(url, title.slice(0, 160));
    return "";
  });
  for (const match of remainingText.matchAll(/https?:\/\/[^\s<>"'\]\)\u3000-\u303f\uff00-\uffef]+/g)) {
    const url = safeSourceUrl(match[0].replace(/[.,;]+$/, ""));
    if (url && !links.has(url)) links.set(url, new URL(url).hostname);
  }
  return [...links].slice(0, 8).map(([url, title]) => ({ title, url }));
}

export function webSourcesFromText(text: string): AnswerSource[] {
  const sources: AnswerSource[] = [];
  const blocks = text.split(/\n\s*\n|\n(?=#{1,3}\s)/);
  for (const block of blocks) {
    const links = linksInSource(block);
    for (const link of links) {
      const titleLine = block.split("\n").find((line) => /^(?:标题|title)\s*[:：]/i.test(line.trim()));
      const heading = block.split("\n")[0]?.replace(/^#+\s*/, "").trim();
      const title = links.length === 1
        ? titleLine?.replace(/^(?:标题|title)\s*[:：]/i, "").trim() || (heading && !/https?:\/\//.test(heading) ? heading : link.title)
        : link.title;
      sources.push({ id: `web:${link.url}`, kind: "web", title: title.slice(0, 160), url: link.url, excerpt: block.trim().slice(0, 2500) });
    }
  }
  return mergeSources([], sources);
}

export function mergeSources(current: AnswerSource[], incoming: AnswerSource[]): AnswerSource[] {
  const sources = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) sources.set(source.id, source);
  return [...sources.values()].slice(0, 32);
}

/** Validate stored UI data again before rendering links from browser history. */
export function sourcesFromParts(parts: unknown[]): AnswerSource[] {
  let sources: AnswerSource[] = [];
  for (const value of parts) {
    const part = value as { type?: string; data?: { selection?: string; sources?: unknown[] } } | null;
    if (part?.type !== "data-sources" || part.data?.selection !== "cited" || !Array.isArray(part.data?.sources)) continue;
    const valid: AnswerSource[] = [];
    for (const value of part.data.sources.slice(0, 32)) {
      const source = value as AnswerSource | null;
      if (!source || !["knowledge", "web"].includes(source.kind) || typeof source.id !== "string" || typeof source.title !== "string" || typeof source.excerpt !== "string") continue;
      valid.push({
        id: source.id.slice(0, 2200), kind: source.kind,
        title: source.title.slice(0, 160), excerpt: source.excerpt.slice(0, 2500),
        url: safeSourceUrl(source.url),
        dataset: typeof source.dataset === "string" ? source.dataset.slice(0, 100) : undefined,
        links: Array.isArray(source.links) ? source.links.slice(0, 8).flatMap((link) => {
          const url = safeSourceUrl(link?.url);
          return url ? [{ url, title: typeof link?.title === "string" ? link.title.slice(0, 160) : new URL(url).hostname }] : [];
        }) : [],
      });
    }
    sources = mergeSources(sources, valid);
  }
  return sources;
}
