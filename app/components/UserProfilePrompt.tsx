import { Logo } from "./Logo";
import type { UserProfileDraft } from "./SettingsDrawer";

type UserProfilePromptProps = {
  open: boolean;
  busy: boolean;
  draft: UserProfileDraft;
  error: string;
  onDraftChange: (draft: UserProfileDraft) => void;
  onSave: () => Promise<boolean>;
  onDismiss: () => void;
};

export function UserProfilePrompt({
  open,
  busy,
  draft,
  error,
  onDraftChange,
  onSave,
  onDismiss,
}: UserProfilePromptProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-dialog-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
        className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-600">
            <Logo size={28} color="#FFFFFF" accent="#8FC0FF" />
          </div>
          <div>
            <h2
              id="profile-dialog-title"
              className="text-lg font-semibold text-foreground"
            >
              先认识一下你
            </h2>
            <p className="mt-1 text-sm leading-5 text-foreground/55">
              填写专业和年级，建立你的第一份记忆。之后，我会为你调整问题推荐、讲解深度和校园建议。
            </p>
          </div>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground/70">
              年级
            </span>
            <input
              autoFocus
              type="text"
              maxLength={30}
              value={draft.grade}
              onChange={(event) =>
                onDraftChange({ ...draft, grade: event.target.value })
              }
              placeholder="例如：大二、研一"
              className="w-full rounded-xl border border-border bg-muted px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary-400"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground/70">
              专业
            </span>
            <input
              type="text"
              maxLength={50}
              value={draft.major}
              onChange={(event) =>
                onDraftChange({ ...draft, major: event.target.value })
              }
              placeholder="例如：计算机科学与技术"
              className="w-full rounded-xl border border-border bg-muted px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary-400"
            />
          </label>
        </div>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <p className="mt-4 text-[11px] leading-4 text-foreground/40">
          记忆按账号保存，提问时发送给你配置的模型以定制回答。可在设置中管理，也可通过对话修改。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="rounded-lg px-4 py-2 text-sm text-foreground/60 hover:bg-muted"
          >
            稍后填写
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500"
          >
            保存并开始
          </button>
        </div>
      </form>
    </div>
  );
}
