import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const STORE_VERSION = 1;

type EncryptedValue = {
  ciphertext: string;
  iv: string;
  tag: string;
};

type StoredModelConfig = {
  baseUrl: string;
  model: string;
  fallbackModel: string;
  apiKey: EncryptedValue;
  updatedAt: number;
};

type StoredUser = {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  modelConfig?: StoredModelConfig;
  agentGrants?: string[];
};

type AuthStore = {
  version: number;
  users: StoredUser[];
};

export type AuthUser = {
  id: string;
  username: string;
  createdAt: number;
};

export type ResolvedModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel: string;
  source: "user" | "server";
};

export type PublicModelConfig = {
  baseUrl: string;
  model: string;
  fallbackModel: string;
  apiKeyConfigured: boolean;
  source: "user" | "server";
};

export class AuthStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_username"
      | "weak_password"
      | "username_taken"
      | "registration_disabled"
      | "invalid_credentials"
      | "user_not_found"
      | "missing_api_key",
  ) {
    super(message);
    this.name = "AuthStoreError";
  }
}

function authDataDir(): string {
  return path.resolve(
    process.env.AUTH_DATA_DIR?.trim() ||
      path.join(/* turbopackIgnore: true */ process.cwd(), "data", "auth"),
  );
}

function storePath(): string {
  return path.join(authDataDir(), "users.json");
}

function secretsPath(): string {
  return path.join(authDataDir(), ".secrets.json");
}

function publicUser(user: StoredUser): AuthUser {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function normalizeUsername(value: string): string {
  return value.trim().normalize("NFKC");
}

function validateCredentials(username: string, password: string): void {
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw new AuthStoreError(
      "用户名需为 3–32 个字母、数字、点、下划线或连字符",
      "invalid_username",
    );
  }
  if (
    password.length < 8 ||
    password.length > 128 ||
    !/\p{L}/u.test(password) ||
    !/\p{N}/u.test(password)
  ) {
    throw new AuthStoreError(
      "密码需为 8–128 个字符，并同时包含字母和数字",
      "weak_password",
    );
  }
}

async function readStore(): Promise<AuthStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf8")) as AuthStore;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.users)) {
      throw new Error("认证数据版本不受支持");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, users: [] };
    }
    throw error;
  }
}

async function writeStore(store: AuthStore): Promise<void> {
  const directory = authDataDir();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = storePath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, target);
}

let mutationQueue: Promise<void> = Promise.resolve();

function mutateStore<T>(mutation: (store: AuthStore) => Promise<T> | T): Promise<T> {
  const run = mutationQueue.then(async () => {
    const store = await readStore();
    const result = await mutation(store);
    await writeStore(store);
    return result;
  });
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function passwordDigest(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, 64)) as Buffer;
}

function registrationEnabledFor(store: AuthStore): boolean {
  return (
    store.users.length === 0 ||
    process.env.AUTH_ALLOW_REGISTRATION?.trim().toLowerCase() === "true"
  );
}

export async function isRegistrationAllowed(): Promise<boolean> {
  return registrationEnabledFor(await readStore());
}

export async function registerUser(
  usernameValue: string,
  password: string,
): Promise<AuthUser> {
  const username = normalizeUsername(usernameValue);
  validateCredentials(username, password);
  return mutateStore(async (store) => {
    if (!registrationEnabledFor(store)) {
      throw new AuthStoreError("当前未开放新用户注册", "registration_disabled");
    }
    if (
      store.users.some(
        (user) => user.username.toLocaleLowerCase("zh-CN") === username.toLocaleLowerCase("zh-CN"),
      )
    ) {
      throw new AuthStoreError("用户名已存在", "username_taken");
    }
    const salt = randomBytes(16);
    const digest = await passwordDigest(password, salt);
    const user: StoredUser = {
      id: randomUUID(),
      username,
      passwordSalt: salt.toString("base64"),
      passwordHash: digest.toString("base64"),
      createdAt: Date.now(),
    };
    store.users.push(user);
    return publicUser(user);
  });
}

export async function authenticateUser(
  usernameValue: string,
  password: string,
): Promise<AuthUser> {
  const username = normalizeUsername(usernameValue);
  const store = await readStore();
  const user = store.users.find(
    (candidate) =>
      candidate.username.toLocaleLowerCase("zh-CN") ===
      username.toLocaleLowerCase("zh-CN"),
  );
  const expected = user
    ? Buffer.from(user.passwordHash, "base64")
    : Buffer.alloc(64);
  const actual = await passwordDigest(
    password.slice(0, 128),
    user ? Buffer.from(user.passwordSalt, "base64") : Buffer.alloc(16),
  );
  if (
    !user ||
    password.length > 128 ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new AuthStoreError("用户名或密码不正确", "invalid_credentials");
  }
  return publicUser(user);
}

export async function findUserById(userId: string): Promise<AuthUser | null> {
  const user = (await readStore()).users.find((candidate) => candidate.id === userId);
  return user ? publicUser(user) : null;
}

export async function getUserCount(): Promise<number> {
  return (await readStore()).users.length;
}

export async function getStoredAgentGrants(userId: string): Promise<string[]> {
  const user = (await readStore()).users.find((candidate) => candidate.id === userId);
  if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
  return Array.isArray(user.agentGrants) ? [...user.agentGrants] : [];
}

export async function saveStoredAgentGrants(
  userId: string,
  grants: string[],
): Promise<void> {
  await mutateStore((store) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
    user.agentGrants = [...new Set(grants)].slice(0, 16);
  });
}

export async function updateStoredAgentGrants(
  userId: string,
  update: (current: string[]) => string[],
): Promise<string[]> {
  return mutateStore((store) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
    const next = [...new Set(update(Array.isArray(user.agentGrants) ? [...user.agentGrants] : []))]
      .slice(0, 16);
    user.agentGrants = next;
    return [...next];
  });
}

type AuthSecrets = { sessionSecret: string; encryptionSecret: string };
let authSecretsPromise: Promise<AuthSecrets> | null = null;

async function loadOrCreateLocalSecrets(): Promise<AuthSecrets> {
  const sessionSecret = process.env.AUTH_SESSION_SECRET?.trim();
  const encryptionSecret = process.env.AUTH_ENCRYPTION_KEY?.trim();
  if (sessionSecret && encryptionSecret) return { sessionSecret, encryptionSecret };

  const target = secretsPath();
  try {
    const local = JSON.parse(await fs.readFile(target, "utf8")) as AuthSecrets;
    if (local.sessionSecret && local.encryptionSecret) {
      return {
        sessionSecret: sessionSecret || local.sessionSecret,
        encryptionSecret: encryptionSecret || local.encryptionSecret,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const local: AuthSecrets = {
    sessionSecret: sessionSecret || randomBytes(32).toString("base64url"),
    encryptionSecret: encryptionSecret || randomBytes(32).toString("base64url"),
  };
  await fs.mkdir(authDataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(local, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!sessionSecret || !encryptionSecret) {
    const saved = JSON.parse(await fs.readFile(target, "utf8")) as AuthSecrets;
    return {
      sessionSecret: sessionSecret || saved.sessionSecret,
      encryptionSecret: encryptionSecret || saved.encryptionSecret,
    };
  }
  return local;
}

export function getAuthSecrets(): Promise<AuthSecrets> {
  authSecretsPromise ??= loadOrCreateLocalSecrets();
  return authSecretsPromise;
}

async function encryptionKey(): Promise<Buffer> {
  const { encryptionSecret } = await getAuthSecrets();
  return createHash("sha256").update(encryptionSecret, "utf8").digest();
}

async function encrypt(value: string): Promise<EncryptedValue> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

async function decrypt(value: EncryptedValue): Promise<string> {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function getPublicModelConfig(
  userId: string,
): Promise<PublicModelConfig> {
  const user = (await readStore()).users.find((candidate) => candidate.id === userId);
  if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
  if (user.modelConfig) {
    return {
      baseUrl: user.modelConfig.baseUrl,
      model: user.modelConfig.model,
      fallbackModel: user.modelConfig.fallbackModel,
      apiKeyConfigured: true,
      source: "user",
    };
  }
  const model = process.env.CHAT_MODEL?.trim() || "deepseek-v4-flash";
  return {
    baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.deepseek.com",
    model,
    fallbackModel: process.env.CHAT_FALLBACK_MODEL?.trim() || model,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    source: "server",
  };
}

export async function getResolvedModelConfig(
  userId: string,
): Promise<ResolvedModelConfig> {
  const store = await readStore();
  const user = store.users.find((candidate) => candidate.id === userId);
  if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
  if (user.modelConfig) {
    return {
      baseUrl: user.modelConfig.baseUrl,
      apiKey: await decrypt(user.modelConfig.apiKey),
      model: user.modelConfig.model,
      fallbackModel: user.modelConfig.fallbackModel || user.modelConfig.model,
      source: "user",
    };
  }
  const model = process.env.CHAT_MODEL?.trim() || "deepseek-v4-flash";
  return {
    baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.deepseek.com",
    apiKey: process.env.OPENAI_API_KEY?.trim() || "",
    model,
    fallbackModel: process.env.CHAT_FALLBACK_MODEL?.trim() || model,
    source: "server",
  };
}

export async function saveUserModelConfig(
  userId: string,
  input: {
    baseUrl: string;
    model: string;
    fallbackModel: string;
    apiKey?: string;
  },
): Promise<PublicModelConfig> {
  return mutateStore(async (store) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
    const apiKey = input.apiKey?.trim();
    const encryptedKey = apiKey
      ? await encrypt(apiKey)
      : user.modelConfig?.apiKey;
    if (!encryptedKey) {
      throw new AuthStoreError("首次保存个人模型配置时必须填写 API Key", "missing_api_key");
    }
    user.modelConfig = {
      baseUrl: input.baseUrl,
      model: input.model,
      // Keep "no fallback" visible as blank in settings. Runtime resolution
      // still uses the primary model when this value is empty.
      fallbackModel: input.fallbackModel,
      apiKey: encryptedKey,
      updatedAt: Date.now(),
    };
    return {
      baseUrl: user.modelConfig.baseUrl,
      model: user.modelConfig.model,
      fallbackModel: user.modelConfig.fallbackModel,
      apiKeyConfigured: true,
      source: "user",
    };
  });
}

export async function clearUserModelConfig(userId: string): Promise<void> {
  await mutateStore((store) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new AuthStoreError("用户不存在", "user_not_found");
    delete user.modelConfig;
  });
}
