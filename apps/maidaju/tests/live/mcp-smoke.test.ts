// 只读冒烟：initialize + tools/list。仅在设置 MCD_MCP_TOKEN 时运行；不调用任何业务工具。
import { describe, expect, it } from "vitest";
import { LiveMcpTransport } from "@/server/mcp/live";
import { ToolRegistry } from "@/server/mcp/transport";

describe.skipIf(!process.env.MCD_MCP_TOKEN)("live MCP 只读冒烟", () => {
  it("tools/list 覆盖首版白名单", async () => {
    const reg = new ToolRegistry(LiveMcpTransport.fromEnv());
    const { missing } = await reg.init();
    console.log("missing:", missing);
    expect(missing).toEqual([]);
  }, 30_000);
});
