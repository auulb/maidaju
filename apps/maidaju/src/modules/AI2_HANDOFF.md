# AI-2 交接：逐人餐盘与候选规划

## 范围
`src/modules/planning/`（纯函数 + 服务，不调用 MCP、不持有凭据、不创建订单）

| 文件 | 子任务 | 内容 |
|---|---|---|
| `catalog.ts` | B1 | PlanningContext → 规划目录；事实索引；套餐默认 roundList；成员×商品硬约束判定 |
| `build.ts` | B1 | 餐盘+共享 → `OrderItem[]`/`Assignment[]`；估算金额；数量守恒检查 |
| `check.ts` | B1 | 确定性约束检查器：结构、主食、不能接受项、个人/整局预算 |
| `search.ts` | B2 | 成员筛选 → 每人有限餐盘 → beam search → 去重；冲突输出 |
| `service.ts` | B2/B4/B6 | `PlanningService`：generate / applyManualEdit / replanAffectedMembers / getCheckoutSnapshot / invalidate；`validatePricedCandidate()` |
| `explain.ts` | B5 | 确定性模板解释；可选 LLM 改写 + 输出校验，失败回退模板 |
| `repo.ts` | — | `CandidateRepository` 端口 + 内存实现（仅测试） |

测试：`tests/planning/`（全部 MOCK 数据）。运行：`npm run typecheck && npm test`

## 与其他模块的接口
- **AI-1 → AI-2**：只消费 `getPlanningContext()` 的结果，不读 AI-1 表。
- **AI-2 → AI-3**：`PlanningService` 直接实现 AI-3 的 `SnapshotSource`（`getCheckoutSnapshot` / `getLatestVersion`），输出经 `CheckoutSnapshot` schema 校验。已与 `CheckoutService` 做 mock 联调测试。
- **AI-3 → AI-2**：`validatePricedCandidate(snapshot, { payableFen, lineAmountsFen, organizerAllocationFen? })`，复用 AI-3 `allocation.ts` 的最大余数法。
- **失效**：`PlanningService` 实现 `InvalidationSink`，AI-1 的任何 revision 变更会把旧候选标 `stale`，快照不可再取 → AI-3 核价/授权自然失败。

## 保证的行为
- 未知事实一律 `pending`，绝不判 `pass`；即使 AI-1 未生成 Fact 记录，也按 `${menuId}:${code}:${attr}` 生成稳定 ID 进入 `unresolvedFactIds`，确保 AI-3 `FACT_PENDING` 闸门拦截（有测试）。
- 主食只认 `is_main` 已核实事实；工具分类 side/drink/dessert 只能排除主食；商品名不参与任何判定（软偏好关键词仅用于排序）。
- 共享主食不计入个人最低主食要求；每行顶层分配数量之和 = 购买数量；套餐子项不单独计费；无半份商品。
- 缺价格时 `estimatedTotalFen=null`、`priceSource="unknown"`，预算检查 `pending`。
- 候选按订单商品+数量去重；只有一解时只输出 1 套；“适度共享”找不到合法共享项时不输出。
- 预算/约束不可行时只返回冲突与需用户选择的建议，不自动放宽；文案为“当前搜索范围内未找到”，截断时注明。
- 候选版本不可原地覆盖；手工调整/局部重配生成新版本，旧版本 `superseded`，旧版本号提交返回 `STALE_REVISION`。
- 局部重配：未点名成员只有在原餐盘出现明确违反/不可构建时才调整，并写入具体原因；受影响成员原餐盘仍合法则不动；剩余预算不够时返回冲突而不改动他人（测试统计“无理由改动”= 0）。
- 实价复核：优先服务端行金额 → 组织者确认且合计 = 实付的分摊表 → 否则个人上限 `pending`。
- LLM 解释出现编码、未给出的数字、“全部满足”（与检查结果矛盾）或安全承诺时拒绝并回退模板。

## 基准（本机 vitest，MOCK 6 个商品）
- 6 人：3 套候选，5016 节点，约 1ms
- 20 人：3 套候选，21816 节点，约 5ms
- `truncated=true` 来自每人餐盘上限 8 的截断，属于预期。真实菜单规模下需重新测量，以上不代表真实性能。

## 契约变更提案（待 AI-3 合入）
1. `ErrorCode` 增加 `NOT_FOUND`（与 AI-1 提案相同）；当前用 `VALIDATION` + `details.notFound=true`。
2. `Candidate` 持久化实体：字段见 `planning/types.ts`，Prisma 实现 `CandidateRepository`（`insert` 对 id+version 唯一）。

## 已知限制 / 待做
- 页面与 API 路由（候选页、餐盘卡片、`POST /api/sessions/:id/candidate-jobs`、`PATCH /api/candidates/:id`）等待 AI-3 Next.js 骨架与 Job worker。
- 套餐只按详情默认项构建；默认项不唯一时标为不可构建，需用户选择（尚无 UI）。特调序列化由 AI-3 `buildModification` 负责，规划层不生成 modification。
- 局部重配目前仅用“保留原餐盘优先”作为变动惩罚，未对共享项做重新优化。
- 优惠券不参与规划（只在核价时由 AI-3 处理）。
- 真实菜单尚无可靠主食/辣度/糖分字段，实际候选在用户确认事实前都会是 `pending`。
