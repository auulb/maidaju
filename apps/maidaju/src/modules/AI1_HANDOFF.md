# AI-1 交接：点餐需求与菜单事实

## 范围
- `modules/intake`：点餐局 CRUD（乐观锁 revision）、成员保存、元→分换算、需求解析（规则 + 可选 LLM）。
- `modules/catalog`：门店搜索/明确选店、菜单+可用券+详情快照、事实派生与用户确认、`getPlanningContext()`。
- 测试：`tests/intake/*`、fixtures `tests/fixtures/intake/`（全部为模拟数据，code 带 MOCK 前缀）。

运行：`npm run typecheck && npm test`

## 依赖 AI-3（ports.ts）
- `ToolCaller`：直接传入 AI-3 的 `ToolRegistry`（结构兼容），AI-1 只调用 4 个只读工具。
- `IntakeRepository`：需 Prisma 实现；`memory-repo.ts` 仅供测试。
- `InvalidationSink`：AI-2/AI-3 注册，收到 `session_changed / members_changed / store_changed / menu_refreshed / fact_confirmed` 时失效候选、报价、授权。

## 契约变更提案（待 AI-3 合入）
1. `ErrorCode` 增加 `NOT_FOUND`（404）。当前用 `VALIDATION` + `details.notFound=true` 代替。
2. `PlanningContext`、`MenuSnapshot`、`Fact`、`MemberRequirement` 迁入 `src/contracts`（现位于 `catalog/types.ts`、`intake/types.ts`），供 AI-2 直接引用。

## 保证的行为
- 无城市/关键词不调用门店搜索；只能选择最近搜索结果中的门店。
- 换门店清空菜单快照与事实确认，并递增 revision。
- 到店请求只发 `beType=1, orderType=1, storeCode`（门店搜索为 `searchType=2, city, keyword`）；拒绝 `beCode/reservationDate/gmServiceCode/addressId`。
- 商品名称不产生任何事实或分类；缺字段一律 `pending`。用户确认记为 `user_confirmed`，与工具事实相反时记 `conflict`。
- "N 人不吃辣"未点名 → `unassignedRequirements` + 提问，不自动分配；软表达不转硬约束；模糊金额要求确认。
- LLM 输出经 Zod 校验，代号须在原文出现；最多纠正重试一次，失败回退规则解析。

## 已知限制 / 待真实验证
- MCP 真实响应结构未验证：`normalize.ts` 按常见字段名宽松提取，接通后须用真实响应补 fixture 并收紧。
- 菜单价格单位未核实，`priceFen` 默认为 null（估算不可用，以核价为准）；核实后通过 `refreshCatalog(..., { priceUnit })` 开启。
- 工具返回中尚无可靠的主食/辣度/糖分字段，`is_main` 等目前全部依赖用户确认。
- 页面与 API 路由尚未实现：等待 AI-3 的 Next.js 骨架。
