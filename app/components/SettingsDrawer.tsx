import type { AssistantCapabilities } from "../lib/capabilities";
import type { SignedInUser } from "./AuthGate";
import { ModelConfigPanel } from "./ModelConfigPanel";

const THEME_COLORS = [
  { key: "blue", label: "科大蓝", color: "#0046ad" },
  { key: "purple", label: "紫罗兰", color: "#7c3aed" },
  { key: "teal", label: "青碧", color: "#0d9488" },
  { key: "rose", label: "玫瑰红", color: "#e11d48" },
] as const;

const CAPABILITY_OPTIONS: Array<{
  key: keyof AssistantCapabilities;
  label: string;
  description: string;
}> = [
  {
    key: "knowledgeBase",
    label: "知识库检索",
    description: "查询校园政策、办事流程和校内资料",
  },
  {
    key: "webSearch",
    label: "联网搜索",
    description: "查询最新通知、活动和公开网络信息",
  },
  {
    key: "agent",
    label: "Agent 能力",
    description: "按账号授权本地目录；读取、修改和执行逐次确认",
  },
];

type AppearanceMode = "auto" | "light" | "dark";

export type UserProfileDraft = {
  age: string;
  major: string;
};

export type SettingsDrawerProps = {
  open: boolean;
  user: SignedInUser;
  controlsDisabled: boolean;
  capabilities: AssistantCapabilities;
  profileDraft: UserProfileDraft;
  profileError: string;
  skipIntro: boolean;
  darkMode: AppearanceMode;
  themeColor: string;
  onClose: () => void;
  onCapabilitiesChange: (capabilities: AssistantCapabilities) => void;
  onProfileDraftChange: (draft: UserProfileDraft) => void;
  onSaveProfile: () => boolean;
  onSkipIntroChange: (skip: boolean) => void;
  onDarkModeChange: (mode: AppearanceMode) => void;
  onThemeColorChange: (color: string) => void;
};

export function SettingsDrawer({
  open,
  user,
  controlsDisabled,
  capabilities,
  profileDraft,
  profileError,
  skipIntro,
  darkMode,
  themeColor,
  onClose,
  onCapabilitiesChange,
  onProfileDraftChange,
  onSaveProfile,
  onSkipIntroChange,
  onDarkModeChange,
  onThemeColorChange,
}: SettingsDrawerProps) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-96 max-w-full bg-surface border-l border-border z-50 shadow-xl flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">设置</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-foreground/60 hover:text-foreground text-lg leading-none"
            aria-label="关闭设置"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          <ModelConfigPanel user={user} />
          <div className="border-t border-border" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSaveProfile();
            }}
          >
            <label className="mb-2 block text-xs font-medium text-foreground/70">
              个人资料
            </label>
            <div className="grid grid-cols-[92px_1fr] gap-2">
              <input
                type="number"
                min={10}
                max={100}
                inputMode="numeric"
                value={profileDraft.age}
                onChange={(event) =>
                  onProfileDraftChange({
                    ...profileDraft,
                    age: event.target.value,
                  })
                }
                placeholder="年龄"
                aria-label="年龄"
                className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary-400"
              />
              <input
                type="text"
                maxLength={50}
                value={profileDraft.major}
                onChange={(event) =>
                  onProfileDraftChange({
                    ...profileDraft,
                    major: event.target.value,
                  })
                }
                placeholder="专业，如计算机科学"
                aria-label="专业"
                className="min-w-0 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary-400"
              />
            </div>
            {profileError && (
              <p className="mt-2 text-[11px] text-danger">{profileError}</p>
            )}
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-[11px] leading-4 text-foreground/40">
                保存在当前浏览器，提问时用于定制回答。
              </p>
              <button
                type="submit"
                className="shrink-0 rounded-md bg-primary-600 px-3 py-1.5 text-xs text-white hover:bg-primary-500"
              >
                保存
              </button>
            </div>
          </form>
          <div>
            <label className="mb-2 block text-xs font-medium text-foreground/70">
              AI 能力边界
            </label>
            <div className="space-y-2">
              {CAPABILITY_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className={`flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 ${
                    controlsDisabled
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={capabilities[option.key]}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      onCapabilitiesChange({
                        ...capabilities,
                        [option.key]: event.target.checked,
                      })
                    }
                    className="mt-0.5 h-4 w-4 rounded border-border accent-primary-600"
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground/80">
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-foreground/45">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-foreground/40">
              关闭的能力不会发送给模型，也不会在服务端注册对应工具。
              {controlsDisabled ? " 请等待当前操作结束后再修改。" : ""}
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-2 block">
              开场动画
            </label>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipIntro}
                onChange={(event) => onSkipIntroChange(event.target.checked)}
                className="w-4 h-4 rounded border-border accent-primary-600"
              />
              <span className="text-sm text-foreground/80">跳过开场动画</span>
            </label>
            <p className="text-[11px] text-foreground/40 mt-1 ml-7">
              开启后下次启动将直接进入主界面
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-2 block">
              外观模式
            </label>
            <div className="flex gap-2">
              {(["auto", "light", "dark"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onDarkModeChange(mode)}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                    darkMode === mode
                      ? "bg-primary-50 border-primary-400 text-primary-600"
                      : "border-border text-foreground/60 hover:bg-muted"
                  }`}
                >
                  {mode === "auto"
                    ? "跟随系统"
                    : mode === "light"
                      ? "浅色"
                      : "深色"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-2 block">
              主题色
            </label>
            <div className="flex gap-3">
              {THEME_COLORS.map((theme) => (
                <button
                  key={theme.key}
                  type="button"
                  onClick={() => onThemeColorChange(theme.key)}
                  className={`w-9 h-9 rounded-full border-2 transition-all ${
                    themeColor === theme.key
                      ? "border-foreground scale-110 shadow-md"
                      : "border-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: theme.color }}
                  title={theme.label}
                  aria-label={`主题色：${theme.label}`}
                />
              ))}
            </div>
            <p className="text-[11px] text-foreground/40 mt-2">
              {THEME_COLORS.find((theme) => theme.key === themeColor)?.label ?? ""}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
