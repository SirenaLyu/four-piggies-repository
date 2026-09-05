export interface UserProfile {
  grade: string;
  major: string;
}

export const EMPTY_USER_PROFILE: UserProfile = {
  grade: "",
  major: "",
};

const MAX_MAJOR_LENGTH = 50;

function normalizeMajor(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MAJOR_LENGTH);
}

/** 对浏览器保存或请求传入的资料做统一校验，避免把任意内容写入提示词。 */
export function normalizeUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object") return { ...EMPTY_USER_PROFILE };
  const raw = value as Record<string, unknown>;
  return {
    grade: normalizeMajor(raw.grade).slice(0, 30),
    major: normalizeMajor(raw.major),
  };
}

export function isCompleteUserProfile(profile: UserProfile): boolean {
  return profile.grade.length > 0 && profile.major.length > 0;
}

export function userProfileFingerprint(profile: UserProfile): string {
  return `${profile.grade || "none"}:${profile.major.toLocaleLowerCase("zh-CN") || "none"}`;
}

type SuggestedQuestion = {
  text: string;
  color: string;
};

function majorSpecificQuestion(major: string): string {
  const label = major.endsWith("专业") ? major : `${major}专业`;
  if (/计算机|软件|人工智能|网络|数据|信息安全/.test(major)) {
    return `${label}有哪些适合本科生的项目或实验室？`;
  }
  if (/数学|统计/.test(major)) {
    return `${label}如何安排课程与科研入门？`;
  }
  if (/物理|天文|量子/.test(major)) {
    return `${label}有哪些科研入门机会？`;
  }
  if (/化学|材料|生物|医学|生命/.test(major)) {
    return `${label}如何选择实验室和科研方向？`;
  }
  if (/电子|自动化|机械|工程|核|能源/.test(major)) {
    return `${label}有哪些适合参加的竞赛或实践项目？`;
  }
  if (/管理|经济|金融|工商/.test(major)) {
    return `${label}怎样兼顾课程、实习和能力提升？`;
  }
  return `${label}应该怎样规划课程和发展方向？`;
}

function gradeSpecificQuestion(grade: string): string {
  if (/大一|本科一年级/.test(grade)) return "如何适应大学学习并安排基础课程？";
  if (/研|博/.test(grade)) return "现阶段怎样平衡科研、论文与职业规划？";
  return "现阶段怎样平衡课程、科研和校园生活？";
}

export function buildPersonalizedSuggestions(
  value: UserProfile,
): SuggestedQuestion[] {
  const profile = normalizeUserProfile(value);
  const suggestions: SuggestedQuestion[] = [];
  if (profile.major) {
    suggestions.push({ text: majorSpecificQuestion(profile.major), color: "#e8f0fb" });
  } else {
    suggestions.push({ text: "课程怎么选？", color: "#e8f0fb" });
  }
  if (profile.grade.length > 0) {
    suggestions.push({ text: gradeSpecificQuestion(profile.grade), color: "#f0edfb" });
  } else {
    suggestions.push({ text: "如何规划大学阶段的学习？", color: "#f0edfb" });
  }
  return [
    ...suggestions,
    { text: "食堂有哪些？", color: "#fdf0e3" },
    { text: "图书馆开放时间？", color: "#e8f5ec" },
    { text: "社团活动怎么加入？", color: "#fdf6e3" },
    { text: "查看近期教学日历", color: "#fdeef0" },
  ];
}
