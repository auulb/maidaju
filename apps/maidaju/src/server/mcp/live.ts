// Streamable HTTP MCP 客户端（JSON-RPC 2.0）。token 仅从服务端环境变量读取。
import { McpNotSentError, McpOutcomeUnknownError, type McpTransport, type ToolResult } from "./transport";

type RpcResponse = { id?: number; result?: any; error?: { code: number; message: string } };

export class LiveMcpTransport implements McpTransport {
  readonly mode = "live" as const;
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;

  constructor(
    private endpoint: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    if (!endpoint || !token) throw new Error("MCD_MCP_ENDPOINT / MCD_MCP_TOKEN 未配置");
  }

  static fromEnv() {
    return new LiveMcpTransport(process.env.MCD_MCP_ENDPOINT ?? "", process.env.MCD_MCP_TOKEN ?? "");
  }

  private async post(body: object, timeoutMs: number): Promise<RpcResponse | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      // 连接级错误无法确认远端是否收到；只有明确的拒绝连接视为未发送
      if (e?.cause?.code === "ECONNREFUSED" || e?.cause?.code === "ENOTFOUND") throw new McpNotSentError(String(e.cause.code));
      throw new McpOutcomeUnknownError(e?.name === "TimeoutError" ? "请求超时" : "连接中断");
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202) return null;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`); // 明确被拒，不含 token
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      for (const d of datas.reverse()) {
        try {
          const msg = JSON.parse(d);
          if ("result" in msg || "error" in msg) return msg;
        } catch { /* 忽略非 JSON 帧 */ }
      }
      throw new Error("SSE 中未找到 JSON-RPC 响应");
    }
    return JSON.parse(text);
  }

  private ensureInit() {
    this.initialized ??= (async () => {
      const r = await this.post(
        { jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "maidaju", version: "0.1.0" } } },
        15_000,
      );
      if (r?.error) throw new Error(`MCP initialize 失败: ${r.error.message}`);
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 15_000);
    })().catch((e) => {
      this.initialized = null;
      throw e;
    });
    return this.initialized;
  }

  async listTools(): Promise<string[]> {
    await this.ensureInit();
    const r = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }, 15_000);
    if (r?.error) throw new Error(`tools/list 失败: ${r.error.message}`);
    return (r?.result?.tools ?? []).map((t: { name: string }) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ToolResult> {
    await this.ensureInit();
    const r = await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } },
      opts?.timeoutMs ?? 20_000,
    );
    if (!r) throw new McpOutcomeUnknownError("无响应体");
    if (r.error) return { ok: false, message: r.error.message, raw: r.error };
    const result = r.result ?? {};
    const text = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    let data: unknown = result.structuredContent ?? text;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { /* 保留文本 */ }
    }
    if (result.isError) return { ok: false, message: typeof data === "string" ? data : JSON.stringify(data), raw: result };
    return { ok: true, data, raw: result };
  }
}
