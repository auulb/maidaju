# McD Feast Planner

把「8 个人、300 块、有人不吃辣、有人喝无糖」这类需求，变成 **三套可直接照着点** 的麦当劳组合：

| 方案 | 取向 | 怎么算 |
|---|---|---|
| 🎲 多元体验 | 吃得最丰富 | 单品数 ×60 + 品类数 ×14 + 份数 + 甜品种类 − 重复惩罚 |
| 💪 健身活力 | 蛋白质最划算 | 蛋白 ×9 − 脂肪 ×1.6 − 碳水 ×1.0 + 无糖饮品 + 单品数，人均热量 ≤700 kcal、脂肪 ≤28 g |
| ⚡ 能量满格 | 热量/主食管够 | 总热量 ×1 + 蛋白 ×3 + 品类数，人均热量软上限 1000 kcal |

三套都满足：预算内、每人 1 主食 + 1 饮品、辣味主食 ≤ 可吃辣人数、无糖饮品 ≥ 无糖人数。

给了成员名单后，还会输出 **逐人餐盘**：谁拿哪份主食/饮品、共享小食、个人分摊与个人预算是否够。

## 快速开始

```bash
cd .agents/skills/mcd-feast-planner

# 8 人 300 元：2 人不吃辣、1 人要无糖，门店取人民广场最近的一家
python3 scripts/plan.py --people 8 --budget 300 --no-spicy 2 --no-sugar 1 \
    --city 上海市 --keyword 人民广场

# 指定门店 / 选好后复核门店实际价格（不进入支付）
python3 scripts/plan.py --people 8 --budget 300 --store 1450713 --verify

# 团餐：自动选满折档位与助餐服务，按活动后实付规划
python3 scripts/plan.py --people 8 --budget 300 --be-type 6 --order-type 2 \
    --address-id 123456 --no-spicy 2 --no-sugar 1 --verify

# 逐人餐盘：名字 + 忌口 + 个人预算（budget 可省略）
python3 scripts/plan.py --budget 220 --store 1450713 \
    --member '小王:no-spicy,budget=50' --member '小李:no-sugar,budget=50' \
    --member 小张 --member 小赵 --member 小钱 --member 小孙
```

输出示例见 [`examples/sample-8p-300.md`](examples/sample-8p-300.md)；团餐示例见
[`examples/sample-8p-300-catering.md`](examples/sample-8p-300-catering.md)。

自检（离线；自带门店菜单快照，无需联网）：

```bash
python3 scripts/selftest.py
```

## 工作原理

```
query-nearby-stores ─┐
                     ├─► query-meals ─► query-meal-detail ─┐
用户参数(人数/预算/忌口) ┘                                 ├─► 候选目录（套餐/规格/价格）
list-nutrition-foods + 官网营养计算器 + 人工估算 ─────────┘
                                                             │
                                      贪心种子 → 模拟退火 → 修约束 → 局部搜索
                                                             │
                                        三套方案 + 逐品清单 + order_items
                                                             │
                                     逐人餐盘（--member）：匹配 → 共享 → 预算检查
                                                             │
                                              calculate-price 复核（可选）
```

- **菜单展开**：`query-meal-detail` 的 `rounds/choices` 还原子项、默认搭配、换无糖差价；「随单购麦金卡」套餐按原价计入预算。
- **营养匹配**：名称归一化（去括号/杯/空格）→「基础名 + 规格」→ 热/冰前缀 → 别名表；匹配不到用同类中位数并标 `≈`。
- **搜索**：固定随机种子，结果可复现；启发式，不承诺全局最优。
- **复核**：每套方案的 `order_items` 直接喂给 `calculate-price`，8 人示例三套与门店价格误差 0.0 元。
- **活动定价**：团餐先选助餐服务与满折/满减档位，把商品价按折扣缩放再求解；配送/打包费用一次算价探测。`--verify` 后用门店价做一次收敛（超预算就缩、剩太多就加）。
- **逐人餐盘**：把购买数量拆成单人份，用二分图最大匹配满足每人主食/饮品与忌口；小食进共享池按人均分摊；个人预算超了先换更便宜的同角色餐品，仍超就报冲突。

## 团餐 / 外送计费

团餐菜单价不等于实付：整单满额触发 78折/74折…，并叠加配送与打包费。`scripts/pricing.py` 把这层建模：

| 层 | 来源 | 处理 |
|---|---|---|
| 满折 `discount=26` | `query-promotions` | 74 折；按阶梯选档位，商品价 ×0.74 |
| 满减 `reduceInfo` | `query-promotions` | 预算 +减免额，价格不变 |
| 不参与商品 `type=2` | `query-promotions` | 按原价计 |
| 助餐服务 | `query-meal-assistance` | 选「同预算能买最多」的可用服务 |
| 配送/打包费 | `calculate-price` 探测 | 从预算中扣除，复核时用真实值 |

示例（8 人 / ¥300 / 2 人不吃辣 / 1 人无糖）：菜单价 ¥368，活动 −¥81，配送打包 +¥12，实付 ¥299；算价接口复核差额 **0.0 元**。

口径：活动按整单满额而非单份；档位跳变（¥499 全价 vs ¥500×0.78）意味着更大一单可能更便宜；部分助餐服务限 07:00–20:00。

## 数据来源

| 来源 | 内容 | 局限 |
|---|---|---|
| MCP `list-nutrition-foods` | 当前菜单营养，含当季新品 | 无克重；新品可能缺 |
| 麦当劳中国官网营养计算器 | 经典菜单营养 + 份量克重 | 更新慢（2025-04） |
| `data/manual_nutrition.json` | 新品人工估算 | **非官方**，方案中标 ≈ |

详见 [`references/data-sources.md`](references/data-sources.md)。

## 安装

把整个 `mcd-feast-planner/` 放到项目 `.agents/skills/` 或用户目录 `~/.agents/skills/` 下即可被 pi 发现（也可作为 pi package 分发）。需要能访问 `https://mcp.mcd.cn`；token 通过环境变量 `MCD_MCP_TOKEN` 覆盖，默认用 skill 内置的演示 token。

## 边界

- 默认终点是「方案 + 算价复核」，**不创建订单、不支付**。
- 价格/库存/菜单随门店与时段变化，换店需重跑。
- 辣度靠菜名 + `data/flags.json` 判断，不是官方分级；过敏原、清真等必须提示用户向门店确认。
- 素食支持有限：菜单几乎没有素食主食，无解时会明确列出未满足项。
- 逐人餐盘是分配视图，不是门店分装：套餐可被拆给不同人，共享小食无法按人隔离辣度。

## 目录

```
SKILL.md                    技能说明（给模型的工作流与口径）
scripts/plan.py             CLI 入口
scripts/pricing.py          团餐活动 + 配送/打包费定价模型
scripts/catalog.py          菜单 → 候选目录
scripts/nutrition.py        营养库 + 官网抓取
scripts/solver.py           三套方案搜索
scripts/trays.py            逐人餐盘与个人预算
scripts/selftest.py         离线不变量测试
scripts/mcd_api.py          MCP JSON-RPC 客户端
data/                       营养/规则快照 + 门店缓存 + 促销样本
examples/                   真实输出示例（到店 / 团餐）
```
