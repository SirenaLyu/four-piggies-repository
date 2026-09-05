import assert from "node:assert/strict";
import test from "node:test";
import { applyMemoryChange, emptyMemory, MemoryConflictError, memoryChangeSchema } from "./memory.ts";

test("memory onboarding, add, edit and delete preserve unrelated facts", () => {
  const original = emptyMemory();
  const profile = applyMemoryChange(original, { action: "profile", major: "物理", grade: "大二" }, 0, "unused");
  const added = applyMemoryChange(profile, { action: "add", content: "喜欢实例" }, 1, "entry-1");
  const edited = applyMemoryChange(added, { action: "update", id: "entry-1", content: "喜欢简短回答" }, 2, "unused");
  assert.deepEqual(edited.profile, { major: "物理", grade: "大二" });
  assert.equal(edited.entries[0].content, "喜欢简短回答");
  assert.equal(added.entries[0].content, "喜欢实例");
  const deleted = applyMemoryChange(edited, { action: "delete", id: "entry-1" }, 3, "unused");
  assert.equal(deleted.entries.length, 0);
  assert.equal(deleted.onboarded, true);
  assert.deepEqual(original, emptyMemory());
});

test("stale changes, foreign entry IDs and oversized memories are rejected", () => {
  const saved = applyMemoryChange(emptyMemory(), { action: "add", content: "偏好" }, 0, "mine");
  assert.throws(() => applyMemoryChange(saved, { action: "delete", id: "mine" }, 0, ""), MemoryConflictError);
  assert.throws(() => applyMemoryChange(saved, { action: "delete", id: "someone-else" }, 1, ""), /不存在/);
  assert.equal(memoryChangeSchema.safeParse({ action: "add", content: "x".repeat(501) }).success, false);
  assert.equal(memoryChangeSchema.safeParse({ action: "profile", major: "数学", age: 20 }).success, false);
  const full = { ...saved, entries: Array.from({ length: 50 }, (_, i) => ({ id: String(i), content: String(i) })) };
  assert.throws(() => applyMemoryChange(full, { action: "add", content: "new" }, 1, "new"), /50/);
});

test("duplicate additions are idempotent and skipping onboarding persists", () => {
  const skipped = applyMemoryChange(emptyMemory(), { action: "dismiss" }, 0, "");
  assert.equal(skipped.onboarded, true);
  assert.deepEqual(skipped.profile, { major: "", grade: "" });
  const added = applyMemoryChange(skipped, { action: "add", content: "偏好" }, 1, "id");
  assert.deepEqual(applyMemoryChange(added, { action: "add", content: "偏好" }, 2, "other"), added);
});
