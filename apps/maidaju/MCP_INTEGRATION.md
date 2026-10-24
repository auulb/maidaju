# MCP 接入说明（AI-3）

## 已验证
- Streamable HTTP：initialize + tools/list 通过（`tests/live/mcp-smoke.test.ts`，需设置 `MCD_MCP_TOKEN`）。
- 白名单工具全部存在：query-nearby-stores / query-meals / query-meal-detail / query-store-coupons / calculate-price / create-order / query-order / now-time-info。

## 未验证（真实链路阻塞点）
- calculate-price、create-order、query-order 的真实响应结构。`modules/checkout/normalize.ts` 按候选字段名解析，找不到整数分实付字段时 fail closed；首次真实核价后需对照响应修正字段并补 fixture。
- 支付入口字段名；未识别时 `payUrl=null`，界面提示打开麦当劳 APP。
- 上游是否支持幂等：按不支持处理，create-order 绝不自动重试。

## 参数规则（代码强制）
- 到店：`beType=1, orderType=1, storeCode`；`DiningContext` 为 strict，出现 `beCode` 直接报错。
- 禁止字段：beCode / reservationDate / gmServiceCode / addressId / withOrder / remark（`assertNoForbidden`）。
- 本地 `lineId` 不发往 MCP；券 couponId/couponCode 必须成对。
- 特调：选中用 selectedKey，未选中但 unselectedKey 非空也必须传（`buildModification`）。
- live 模式拒绝任何 `MOCK-` 编码；快照模式与 transport 模式不一致即拒绝。

## 交易状态机
- 报价：绑定 cartHash + sessionRevision + 候选版本；本地安全窗口 3 分钟（产品策略，非服务端锁价）。
- 授权：仅 `userConfirmed=true` 创建；取餐方式必须来自最新报价的 takeWayList；未确认事实需逐项接受；预算 fail/pending 拒绝。
- 下单：每个授权最多一次尝试（authorizationId 唯一）；先持久化 sending 再发送；超时/断连 → outcome_unknown 并冻结；启动时 `recoverStuckAttempts()` 把残留 sending 标为 outcome_unknown。
- 订单状态只来自 query-order，本地不写“已支付”。

## 对其他模块的接口
- AI-2 实现 `SnapshotSource`（getCheckoutSnapshot / getLatestVersion），快照须通过 `CheckoutSnapshot` schema。
- AI-1 的 `InvalidationSink` 应调用 `CheckoutService.invalidate(sessionId)`；AI-2 修改候选时调用 `invalidate(sessionId, candidateId)`。
