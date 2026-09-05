import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import type { ResolvedModelConfig } from "./auth-store";

export const EMBEDDING_MODEL = "BAAI/bge-m3";

// embeddingClient 仅供服务端脚本/后续向量功能使用。
export const embeddingClient = createOpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL,
  apiKey: process.env.EMBEDDING_API_KEY,
  name: "siliconflow-embed",
});

function isNetworkOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = `${error.name} ${error.message}`.toLowerCase();
  return /timeout|connect|eacces|econnreset|econnrefused|enotfound|network|fetch|socket|retry/i.test(
    msg,
  );
}

function configuredAllowedOrigins(): Set<string> {
  return new Set(
    (process.env.MODEL_BASE_URL_ALLOWLIST ?? "")
      .split(",")
      .map((value) => {
        try {
          return new URL(value.trim()).origin.toLowerCase();
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) {
    if (normalized.startsWith("::ffff:")) {
      return isPrivateIpv4(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    );
  }
  return false;
}

/** 用户可配置公开 HTTPS OpenAI 兼容端点；内网端点须由管理员加入白名单。 */
export function normalizeUserModelBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("API URL 不是合法网址");
  }
  if (url.username || url.password) throw new Error("API URL 不能包含用户名或密码");
  const allowed = configuredAllowedOrigins().has(url.origin.toLowerCase());
  if (!allowed && url.protocol !== "https:") {
    throw new Error("API URL 必须使用 HTTPS；内网地址需由管理员加入白名单");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !allowed &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      isPrivateAddress(hostname))
  ) {
    throw new Error("API URL 不能指向本机、内网或链路本地地址");
  }
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function assertSafeModelRequest(value: string): Promise<void> {
  const url = new URL(value);
  if (configuredAllowedOrigins().has(url.origin.toLowerCase())) return;
  normalizeUserModelBaseUrl(url.origin);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("模型 API 域名解析到了不安全的网络地址");
  }
}

const guardedModelFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  await assertSafeModelRequest(url);
  return fetch(input, { ...init, redirect: "error" });
};

export function createChatModel(config: ResolvedModelConfig) {
  if (!config.apiKey) {
    throw new Error("当前账号尚未配置模型 API Key，且服务器没有默认 Key");
  }
  const client = createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    name: config.source === "user" ? "user-chat" : "campus-chat",
    ...(config.source === "user" ? { fetch: guardedModelFetch } : {}),
  });
  const primary = config.model;
  const fallback = config.fallbackModel || primary;

  return wrapLanguageModel({
    model: client.chat(primary),
    modelId: primary,
    middleware: {
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (error) {
          if (fallback !== primary && isNetworkOrTimeoutError(error)) {
            console.warn(`[model] 主模型 ${primary} 调用失败，尝试备用模型 ${fallback}`);
            return client.chat(fallback).doStream(params);
          }
          throw error;
        }
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (error) {
          if (fallback !== primary && isNetworkOrTimeoutError(error)) {
            console.warn(`[model] 主模型 ${primary} 调用失败，尝试备用模型 ${fallback}`);
            return client.chat(fallback).doGenerate(params);
          }
          throw error;
        }
      },
    },
  });
}
