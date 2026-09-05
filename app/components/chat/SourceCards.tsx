import { sourceAnchor, sourcesFromParts } from "../../lib/sources";

export function SourceCards({ parts }: { parts: unknown[] }) {
  const sources = sourcesFromParts(parts);
  if (!sources.length) return null;
  return (
    <section aria-label="回答来源" className="ml-10 mt-3 w-[calc(100%-2.5rem)] max-w-2xl">
      <h3 className="mb-1 text-xs font-medium text-foreground/70">回答来源 · {sources.length}</h3>
      <p className="mb-2 text-[11px] text-foreground/50">仅展示最终回答引用的资料，点击卡片核对详情。</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {sources.map((source, index) => (
          <details data-source-anchor={sourceAnchor(source)} key={source.id} className="min-w-0 rounded-xl border border-border bg-surface p-3 open:sm:col-span-2">
            <summary className="cursor-pointer text-sm text-foreground">
              <span className="mb-1 block text-[11px] text-foreground/50">{source.kind === "knowledge" ? `知识库${source.dataset ? ` · ${source.dataset}` : ""}` : "网页"} · {index + 1}</span>
              <span className="break-words font-medium">{source.title}</span>
              <span className="mt-1 block text-[11px] text-primary-600">查看详情</span>
            </summary>
            <p className="mt-3 text-[11px] text-foreground/50">{source.kind === "knowledge" ? "知识库检索片段（最多展示 2500 字）" : "搜索结果摘要（非网页全文）"}</p>
            <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">{source.excerpt}</p>
            {source.url && <a href={source.url} target="_blank" rel="noopener noreferrer" className="mt-3 block break-all text-xs text-primary-600 underline">打开原网页 ↗ · {new URL(source.url).hostname}</a>}
            {!source.url && source.kind === "knowledge" && <p className="mt-2 text-[11px] text-foreground/50">该文档未提供直接原文链接，可核对上方检索片段。</p>}
            {source.links && source.links.length > 0 && <div className="mt-3 space-y-2">
              <p className="text-[11px] text-foreground/50">片段内链接</p>
              {source.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-primary-600 underline">{link.title} ↗ · {new URL(link.url).hostname}</a>)}
            </div>}
          </details>
        ))}
      </div>
    </section>
  );
}
