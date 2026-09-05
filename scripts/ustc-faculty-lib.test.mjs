import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAchievementPage,
  parseFacultyProfile,
  teacherRecordToMarkdown,
} from "./ustc-faculty-lib.mjs";

test("教师主页解析研究方向、成果栏目和更新时间", () => {
  const parsed = parseFacultyProfile(
    `
      <li><strong>学历：</strong>研究生(博士后)</li>
      <li><strong>学位：</strong>博士</li>
      <a href="/flowice/zh_CN/yjfx/1/content/1.htm#yjfx">1、多媒体信息处理</a>
      <a href="/flowice/zh_CN/yjfx/1/content/2.htm#yjfx">2、人工智能安全</a>
      <a href="/flowice/zh_CN/lwcg/2/list/index.htm">论文成果</a>
      <div>最后更新时间：2026-9-4</div>
    `,
    "https://faculty.ustc.edu.cn/flowice/zh_CN/index.htm",
  );

  assert.deepEqual(parsed.researchDirections, ["多媒体信息处理", "人工智能安全"]);
  assert.equal(parsed.education, "研究生(博士后)");
  assert.equal(parsed.degree, "博士");
  assert.equal(parsed.updatedDate, "2026-09-04");
  assert.equal(
    parsed.achievementPages.papers,
    "https://faculty.ustc.edu.cn/flowice/zh_CN/lwcg/2/list/index.htm",
  );
});

test("成果页提取总数和首屏条目", () => {
  const parsed = parseAchievementPage(
    `<main><h1>论文成果</h1>
      <a href="content/1.htm">[1] 第一篇论文</a>
      <a href="content/2.htm">[2] 第二篇论文</a>
      <div>共14条&nbsp;&nbsp;1/2</div>
    </main>`,
    "论文成果",
    1,
  );
  assert.deepEqual(parsed, {
    category: "论文成果",
    total: 14,
    items: ["第一篇论文"],
  });
});

test("知识记录明确区分未填写字段与已公开成果", () => {
  const markdown = teacherRecordToMarkdown({
    name: "刘斌",
    ename: "Bin Liu",
    college: "网络空间安全学院",
    unit: "网络空间安全学院",
    title: "副教授",
    tutorQualifications: ["博士生导师", "硕士生导师"],
    url: "https://faculty.ustc.edu.cn/flowice/zh_CN/index.htm",
    profile: {
      education: "研究生(博士后)",
      degree: "博士",
      researchDirections: ["人工智能安全"],
      updatedDate: "2026-09-04",
      achievementPages: {},
    },
    achievements: {
      papers: { category: "论文成果", total: 2, items: ["第一篇论文"] },
    },
  });
  assert.match(markdown, /研究方向：人工智能安全/);
  assert.match(markdown, /刘斌的论文成果：公开 2 条/);
  assert.match(markdown, /刘斌的论文成果条目：第一篇论文/);
});
