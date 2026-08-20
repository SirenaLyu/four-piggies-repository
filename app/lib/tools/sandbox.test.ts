import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizePath, resolveInside } from "./sandbox";

describe("authorizePath", () => {
  const dirs = ["C:\\work\\docs", "D:\\data"];

  it("接受授权目录内路径", () => {
    const r = authorizePath("C:\\work\\docs\\a.txt", dirs);
    assert.equal(r.ok, true);
  });

  it("拒绝未授权目录", () => {
    assert.equal(authorizePath("C:\\secret\\a.txt", dirs).ok, false);
  });

  it("拒绝 .. 逃逸（词法）", () => {
    assert.equal(authorizePath("C:\\work\\docs\\..\\..\\Windows\\x.txt", dirs).ok, false);
  });

  it("拒绝 .. 逃逸（resolve 后）", () => {
    assert.equal(authorizePath("C:\\work\\docs\\sub\\..\\..\\..\\x.txt", dirs).ok, false);
  });

  it("嵌套路径通过", () => {
    assert.equal(authorizePath("C:\\work\\docs\\nested\\f.txt", dirs).ok, true);
  });

  it("目录本身通过", () => {
    assert.equal(authorizePath("C:\\work\\docs", dirs).ok, true);
  });
});

describe("resolveInside", () => {
  it("合法相对路径拼接到 cwd", () => {
    const r = resolveInside("sub\\a.txt", "C:\\work\\docs");
    assert.equal(r.ok, true);
    assert.equal(r.path, "C:\\work\\docs\\sub\\a.txt");
  });

  it("拒绝绝对路径逃逸", () => {
    assert.equal(resolveInside("C:\\Windows\\x.txt", "C:\\work\\docs").ok, false);
  });

  it("拒绝 .. 逃逸", () => {
    assert.equal(resolveInside("..\\..\\x.txt", "C:\\work\\docs").ok, false);
  });

  it("拒绝越过根的 ..", () => {
    assert.equal(resolveInside("..\\sibling.txt", "C:\\work\\docs").ok, false);
  });

  it("接受根内部被消解的 ..", () => {
    const r = resolveInside("sub\\..\\a.txt", "C:\\work\\docs");
    assert.equal(r.ok, true);
    assert.equal(r.path, "C:\\work\\docs\\a.txt");
  });
});
