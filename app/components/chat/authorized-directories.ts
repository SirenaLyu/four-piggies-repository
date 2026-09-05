"use client";

type DirectoryResponse = {
  directories?: string[];
  error?: string;
};

async function parseResponse(response: Response): Promise<DirectoryResponse> {
  const data = (await response.json().catch(() => ({}))) as DirectoryResponse;
  if (!response.ok) {
    throw new Error(data.error || `目录服务返回 HTTP ${response.status}`);
  }
  return data;
}

/** 授权目录由服务端按登录用户持久化，浏览器不再充当授权来源。 */
export async function loadAuthorizedDirs(): Promise<string[]> {
  const data = await parseResponse(
    await fetch("/api/agent/directories", { cache: "no-store" }),
  );
  return Array.isArray(data.directories) ? data.directories : [];
}

export async function addAuthorizedDirectory(dir: string): Promise<string[]> {
  const data = await parseResponse(
    await fetch("/api/agent/directories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    }),
  );
  return Array.isArray(data.directories) ? data.directories : [];
}

export async function removeAuthorizedDirectory(dir: string): Promise<string[]> {
  const data = await parseResponse(
    await fetch("/api/agent/directories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    }),
  );
  return Array.isArray(data.directories) ? data.directories : [];
}
