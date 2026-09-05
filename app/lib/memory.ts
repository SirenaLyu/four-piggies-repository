import { z } from "zod";
import { EMPTY_USER_PROFILE, type UserProfile } from "./user-profile.ts";

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "请勿包含控制字符");
export const memoryChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profile"), major: text(50).or(z.literal("")), grade: text(30).or(z.literal("")) }).strict(),
  z.object({ action: z.literal("add"), content: text(500) }).strict(),
  z.object({ action: z.literal("update"), id: text(100), content: text(500) }).strict(),
  z.object({ action: z.literal("delete"), id: text(100) }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
]);
export type MemoryChange = z.infer<typeof memoryChangeSchema>;
export type UserMemory = {
  profile: UserProfile;
  entries: Array<{ id: string; content: string }>;
  version: number;
  onboarded: boolean;
};
export function emptyMemory(): UserMemory {
  return { profile: { ...EMPTY_USER_PROFILE }, entries: [], version: 0, onboarded: false };
}
export class MemoryConflictError extends Error {}
export function applyMemoryChange(current: UserMemory, input: MemoryChange, expectedVersion: number, newId: string): UserMemory {
  if (current.version !== expectedVersion) throw new MemoryConflictError("记忆已更新，请刷新后重试");
  const change = memoryChangeSchema.parse(input);
  const next: UserMemory = { ...current, profile: { ...current.profile }, entries: current.entries.map((entry) => ({ ...entry })), version: current.version + 1 };
  if (change.action === "profile") {
    next.profile = { major: change.major, grade: change.grade };
    next.onboarded = true;
  } else if (change.action === "dismiss") {
    next.onboarded = true;
  } else if (change.action === "add") {
    if (next.entries.some((entry) => entry.content === change.content)) return current;
    if (next.entries.length >= 50) throw new Error("最多保存 50 条记忆，请先删除不需要的内容");
    next.entries.push({ id: newId, content: change.content });
  } else {
    const index = next.entries.findIndex((entry) => entry.id === change.id);
    if (index === -1) throw new Error("该记忆不存在，请刷新后重试");
    if (change.action === "delete") next.entries.splice(index, 1);
    else next.entries[index].content = change.content;
  }
  return next;
}
