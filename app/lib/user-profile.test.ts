import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalizedSuggestions,
  isCompleteUserProfile,
  normalizeUserProfile,
  userProfileFingerprint,
} from "./user-profile.ts";

test("normalizes a valid profile", () => {
  const profile = normalizeUserProfile({ grade: "大二", major: "  计算机科学与技术  " });
  assert.deepEqual(profile, { grade: "大二", major: "计算机科学与技术" });
  assert.equal(isCompleteUserProfile(profile), true);
});

test("ignores legacy age and cleans major text", () => {
  assert.deepEqual(normalizeUserProfile({ age: 7, major: " 软件\n工程 " }), {
    grade: "",
    major: "软件 工程",
  });
});

test("profile fingerprint separates cached answers", () => {
  const first = normalizeUserProfile({ grade: "大一", major: "数学" });
  const second = normalizeUserProfile({ grade: "研一", major: "数学" });
  assert.notEqual(userProfileFingerprint(first), userProfileFingerprint(second));
});

test("suggestions reflect both grade and major", () => {
  const suggestions = buildPersonalizedSuggestions({ grade: "大二", major: "计算机科学" });
  assert.equal(suggestions.length, 6);
  assert.match(suggestions[0].text, /计算机科学.*项目或实验室/);
  assert.match(suggestions[1].text, /课程、科研和校园生活/);
});

test("does not repeat the 专业 suffix in suggestions", () => {
  const suggestions = buildPersonalizedSuggestions({ grade: "大二", major: "软件工程专业" });
  assert.doesNotMatch(suggestions[0].text, /专业专业/);
});
