import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { evaluateCommand, parseCommandRules } from "./command-policy.ts";

const executable = path.resolve("C:\\Program Files\\nodejs\\node.exe");

test("命令规则同时约束程序和参数前缀", () => {
  const rulesJson = JSON.stringify([
    { executable, argsPrefix: ["--test"], allowAdditionalArgs: true },
  ]);
  assert.equal(evaluateCommand(executable, ["--test", "safe.test.ts"], { rulesJson }).allowed, true);
  assert.equal(evaluateCommand(executable, ["-e", "console.log(process.env)"], { rulesJson }).allowed, false);
});

test("旧版程序白名单不再允许任意参数", () => {
  assert.equal(evaluateCommand(executable, ["--version"], { legacyList: executable, rulesJson: "[]" }).allowed, true);
  assert.equal(evaluateCommand(executable, ["-e", "process.exit()"], { legacyList: executable, rulesJson: "[]" }).allowed, false);
});

test("非法命令规则安全地退化为空规则", () => {
  assert.deepEqual(parseCommandRules("not-json"), []);
  assert.deepEqual(parseCommandRules('[{"executable":"node","argsPrefix":[]}]'), []);
  assert.deepEqual(
    parseCommandRules(JSON.stringify([{ executable, argsPrefix: [], allowAdditionalArgs: true }])),
    [],
  );
});
