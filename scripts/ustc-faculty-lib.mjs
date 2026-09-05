const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  middot: "·",
  nbsp: " ",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
};

export const ACHIEVEMENT_CATEGORIES = {
  papers: { label: "论文成果", pathPattern: /\/lwcg\// },
  patents: { label: "专利", pathPattern: /\/zlcg\// },
  books: { label: "著作成果", pathPattern: /\/zzcg\// },
  projects: { label: "科研项目", pathPattern: /\/kyxm\// },
  awards: { label: "获奖信息", pathPattern: /\/hjxx\// },
};

export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|section|article|div|li|h[1-6]|tr|dd|dt|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value) {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function anchorsFromHtml(html, baseUrl) {
  const anchors = [];
  const pattern = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const text = normalizeText(match[5]);
    if (!text) continue;
    try {
      anchors.push({ text, url: new URL(decodeEntities(match[3]), baseUrl).toString() });
    } catch {
      // Ignore malformed javascript pseudo-links and incomplete editor markup.
    }
  }
  return anchors;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function profileField(text, label) {
  const match = text.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  return match?.[1]?.trim() ?? "";
}

export function parseFacultyProfile(html, baseUrl) {
  const anchors = anchorsFromHtml(html, baseUrl);
  const text = stripHtml(html);
  const researchDirections = unique(
    anchors
      .filter(({ url, text: label }) => /\/yjfx\//.test(url) && label !== "研究方向")
      .map(({ text: label }) => label.replace(/^\s*\d+\s*[、.．)）-]\s*/, "").trim()),
  );
  const achievementPages = {};
  for (const [key, category] of Object.entries(ACHIEVEMENT_CATEGORIES)) {
    const match = anchors.find(({ url, text: label }) =>
      category.pathPattern.test(new URL(url).pathname) && label === category.label,
    );
    if (match) achievementPages[key] = match.url.replace(/^http:/, "https:");
  }
  const updatedMatch = text.match(
    /最后更新时间[：:]\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/,
  );

  return {
    researchDirections,
    achievementPages,
    education: profileField(text, "学历"),
    degree: profileField(text, "学位"),
    updatedDate: updatedMatch
      ? `${updatedMatch[1]}-${updatedMatch[2].padStart(2, "0")}-${updatedMatch[3].padStart(2, "0")}`
      : "",
  };
}

export function parseAchievementPage(html, categoryLabel, maxItems = 5) {
  const text = stripHtml(html);
  const anchors = anchorsFromHtml(html, "https://faculty.ustc.edu.cn/");
  const anchorItems = anchors
    .map(({ text: label }) => label)
    .filter((label) => /^\[\d+\]/.test(label));
  const textItems = [];
  for (const match of text.matchAll(/\[\d+\]\s*([\s\S]*?)(?=\n\[\d+\]|\n共\s*\d+\s*条|$)/g)) {
    const item = match[1].replace(/\s+/g, " ").trim();
    if (item) textItems.push(item);
  }
  const totalMatch = text.match(/共\s*(\d+)\s*条/);
  const items = unique((anchorItems.length ? anchorItems : textItems).map((item) =>
    item.replace(/^\[\d+\]\s*/, "").replace(/\s+/g, " ").trim(),
  )).slice(0, maxItems);

  return {
    category: categoryLabel,
    total: totalMatch ? Number(totalMatch[1]) : items.length,
    items,
  };
}

export function teacherRecordToMarkdown(teacher) {
  const lines = [
    `## 教师：${teacher.name}`,
    "",
    `- 姓名：${teacher.name}`,
    teacher.ename ? `- 英文名：${teacher.ename}` : "",
    `- 学院/机构：${teacher.college || "未填写"}`,
    teacher.unit && teacher.unit !== teacher.college ? `- 所在单位：${teacher.unit}` : "",
    `- 职称：${teacher.title || "教师主页未填写"}`,
    teacher.tutorQualifications.length > 0
      ? `- 导师资格：${teacher.tutorQualifications.join("、")}`
      : "",
    teacher.profile?.education ? `- 学历：${teacher.profile.education}` : "",
    teacher.profile?.degree ? `- 学位：${teacher.profile.degree}` : "",
    teacher.profile?.researchDirections?.length > 0
      ? `- 研究方向：${teacher.profile.researchDirections.join("；")}`
      : "- 研究方向：教师主页未公开填写",
    teacher.profile?.updatedDate ? `- 教师主页更新时间：${teacher.profile.updatedDate}` : "",
    `- 官方主页：${teacher.url}`,
  ].filter(Boolean);

  const achievementEntries = Object.entries(teacher.achievements ?? {});
  if (achievementEntries.length > 0) {
    lines.push("", `### ${teacher.name}的代表性成果（教师主页各栏目首屏）`, "");
    for (const [key, result] of achievementEntries) {
      const pageUrl = teacher.profile?.achievementPages?.[key];
      lines.push(`- ${teacher.name}的${result.category}：公开 ${result.total} 条${pageUrl ? `；栏目 ${pageUrl}` : ""}`);
      for (const item of result.items) {
        lines.push(`  - ${teacher.name}的${result.category}条目：${item}`);
      }
    }
  } else if (Object.keys(teacher.profile?.achievementPages ?? {}).length > 0) {
    lines.push("", `### ${teacher.name}的成果栏目`, "");
    for (const [key, pageUrl] of Object.entries(teacher.profile.achievementPages)) {
      lines.push(`- ${teacher.name}的${ACHIEVEMENT_CATEGORIES[key].label}：${pageUrl}`);
    }
  }

  return lines.join("\n");
}
