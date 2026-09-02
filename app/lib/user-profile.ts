export interface UserProfile {
  age: number | null;
  major: string;
}

export const EMPTY_USER_PROFILE: UserProfile = {
  age: null,
  major: "",
};

const MIN_AGE = 10;
const MAX_AGE = 100;
const MAX_MAJOR_LENGTH = 50;

function normalizeMajor(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MAJOR_LENGTH);
}

function normalizeAge(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_AGE || parsed > MAX_AGE) {
    return null;
  }
  return parsed;
}

/** 对浏览器保存或请求传入的资料做统一校验，避免把任意内容写入提示词。 */
export function normalizeUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object") return { ...EMPTY_USER_PROFILE };
  const raw = value as Record<string, unknown>;
  return {
    age: normalizeAge(raw.age),
    major: normalizeMajor(raw.major),
  };
}

export function isCompleteUserProfile(profile: UserProfile): boolean {
  return profile.age !== null && profile.major.length > 0;
}

export function userProfileFingerprint(profile: UserProfile): string {
  return `${profile.age ?? "na"}:${profile.major.toLocaleLowerCase("zh-CN") || "none"}`;
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

function ageSpecificQuestion(age: number): string {
  if (age <= 17) return "入学前应该如何适应大学的学习节奏？";
  if (age <= 22) return "现阶段怎样平衡课程、科研和校园生活？";
  return "现阶段怎样平衡科研、实习与职业规划？";
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
  if (profile.age !== null) {
    suggestions.push({ text: ageSpecificQuestion(profile.age), color: "#f0edfb" });
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
