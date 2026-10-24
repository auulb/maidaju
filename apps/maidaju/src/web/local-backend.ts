// 静态部署（GitHub Pages / Vercel 静态站点）没有 Node 服务端进程。
// 这里把同一套模拟 API 跑在浏览器内：拦截 /api/* 请求，直接交给 handleApi 处理。
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApi } from "@/server/web-api";

type LocalReply = { status: number; body: string; headers: Record<string, string> };

/** 把一次请求交给 Node 风格的 handleApi，并收集它写回的状态码 / 响应体 */
export async function callLocalApi(method: string, url: string, payload: string): Promise<LocalReply> {
  const headers: Record<string, string> = {};
  let sent = false;
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (sent || !payload) return;
      sent = true;
      yield new TextEncoder().encode(payload);
    },
  } as unknown as IncomingMessage;
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name] = String(value);
    },
    end(chunk?: string) {
      this.headersSent = true;
      res.body = chunk ?? "";
    },
    body: "",
  };
  await handleApi(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: res.body, headers };
}

/** 当前环境是否存在真正的 /api 服务（本地 vite 开发服务器） */
export async function hasServerApi(): Promise<boolean> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    // 静态托管常见 SPA 回退会把 /api/health 也返回成 index.html，必须确认是 JSON 响应。
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return false;
    const data = (await response.json()) as { ok?: boolean } | null;
    return data?.ok === true;
  } catch {
    return false;
  }
}

/** 用浏览器内模拟后端接管 /api/* 请求；返回恢复函数 */
export function installLocalBackend(): () => void {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, globalThis.location.origin);
    if (!url.pathname.startsWith("/api/")) return original(input as RequestInfo, init);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const payload = typeof init?.body === "string" ? init.body : "";
    const reply = await callLocalApi(method, `${url.pathname}${url.search}`, payload);
    return new Response(reply.body, {
      status: reply.status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...reply.headers },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}
