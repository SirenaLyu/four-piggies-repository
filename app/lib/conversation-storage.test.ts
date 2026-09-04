import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import {
  loadConversationMessages,
  saveConversationMessages,
  stripAttachmentPayloads,
} from "./conversation-storage.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    value: (key: string) => values.get(key) ?? "",
  };
}

const messages = [
  {
    id: "user-1",
    role: "user",
    parts: [
      { type: "text", text: "请阅读附件" },
      {
        type: "file",
        mediaType: "text/plain",
        filename: "notes.txt",
        url: "data:text/plain;base64,VGhpcyBpcyBhIHNlY3JldA==",
      },
    ],
  },
] as UIMessage[];

test("持久化前移除附件 data URL 并保留文件名提示", () => {
  const sanitized = stripAttachmentPayloads(messages);
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /VGhpcyBpcyBhIHNlY3JldA/);
  assert.match(serialized, /notes\.txt/);
  assert.match(serialized, /内容未保存在本地历史/);
});

test("保存和读取历史时不会重新引入附件负载", () => {
  const storage = memoryStorage();
  assert.equal(saveConversationMessages("chat-1", messages, storage), true);
  assert.doesNotMatch(storage.value("campus-ai-conversations:chat-1"), /base64/);
  const restored = loadConversationMessages("chat-1", storage);
  assert.equal(restored.length, 1);
  assert.match(JSON.stringify(restored), /notes\.txt/);
});
