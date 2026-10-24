# 营养与价格数据来源

这套方案里所有数字都能追溯到下面三个来源之一。**没有来源的数字一律标 ≈。**

## 1. MCP `list-nutrition-foods`（主来源）

- 调用：麦当劳中国 MCP（`https://mcp.mcd.cn`）工具 `list-nutrition-foods`
- 快照：`data/mcp_nutrition.json`（由 `scripts/nutrition.py refresh` 生成）
- 字段：`productName, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`
- 特点：跟随当前菜单更新（含当季新品）；名称直接带规格（`中薯条`、`可乐中杯`、`无糖可口可乐中杯`），和 `query-meals` 的名称最接近。
- 局限：没有份量克重；部分新品/联名品不在表内。

## 2. 麦当劳中国官网营养计算器（补充来源）

- 页面：<https://www.mcdonalds.com.cn/index/Food/营养均衡/营养计算器>
- 数据不在接口里，而是直接内嵌在 HTML 的 `var raw_data = {...}` 中（2025-04 版，213 条）。
- 抓取：`scripts/nutrition.py` 用正则取出 `raw_data`，按 `Product × ProductType` 展开成「商品 + 规格」条目，例如 `可乐` + `中` → `可乐中`。
- 字段顺序（`ProductType.nutrition` 数组）：

  | 索引 | 含义 | 用途 |
  |---|---|---|
  | 0 | 份量（g） | 参考 |
  | 1 | 能量（kJ） | kcal = kJ ÷ 4.184 |
  | 2 | 蛋白质（g） | ✅ |
  | 3 | 脂肪（g） | ✅ |
  | 4 | 碳水化合物（g） | ✅ |
  | 5 | 钠（mg） | ✅ |
  | 6–12 | 其他（糖/饱和脂肪等） | 未纳入本轮计算 |
  | 13 | 钙（mg） | 参考 |

- 已用浏览器（Chromium 打开营养计算器）核对页面实际模型：巨无霸 `[220g, 2146kJ, 27P, 26F, 42C, 961Na, …]` → 513 kcal；可乐中杯 443g / 147 kcal；中薯条 109g / 289 kcal，与本地快照一致。
- 特点：有份量克重，覆盖经典常规菜单。
- 局限：更新频率低于 MCP，新品缺失；无「添加糖」字段，所以「无糖」按商品名判断（无糖可乐 / 纯悦 / 美式 / 鲜萃 / 锡兰红茶等），不是实验室检测。

## 3. `data/manual_nutrition.json`（人工估算，非官方）

- 用途：补官网/MCP 都没有的当季新品（龙焰系列、心形薯饼、麦炫酷、奶昔、灰焰圆筒等）。
- 每条都带 `estimated: true`，进入方案时显示为 `≈`，并且求解器会给估算项加惩罚，优先选有官方数据的品。
- **不要**把这些数字对外说成官方营养数据；需要更准的数字时，直接删掉对应条目，让方案改用同类中位数估算（仍标 ≈）。

## 合并优先级

`MCP > 官网 > 人工估算`，按名称归一化后匹配：

1. 去空格、括号、引号、`™`，`大杯/中杯/小杯 → 大/中/小`，`（冰/热）` 去掉；
2. 先精确匹配，再按「基础名 + 规格」匹配，再尝试补 `热/冰` 前缀；
3. `麦咖啡™美式`、`苹果片一袋(60g)`、`麦辣鸡翅4块` 这类名称用 `ALIASES` 映射（后者带 ×2 倍率）；
4. 都没命中 → 返回 `None`，由 `catalog.py` 用同角色中位数估算并标 `estimated`。

## 价格来源

价格全部来自 `query-meals` 的 `currentPrice` / `originalPrice`，不是营养表推算的。

- `discountType` 含 **随单购**（麦金卡 / 早餐卡）时，`currentPrice` 是买卡后的价格。`catalog.py` 改用 `originalPrice` 计入预算，否则 300 元预算会被高估成 600 元购买力。
- 套餐价格 = 菜单价 + 所选 `choices[].diffPrice`（如「饮料换无糖」、薯条换大）。
- 最终以 `calculate-price` 返回的 `data.price`（单位：分）为准；`plan.py --verify` 会逐套对比。

### 团餐活动与费用

| 数据 | 工具 | 字段 | 处理 |
|---|---|---|---|
| 满折 | `query-promotions` | `promotionType=33`, `orderDiscount.discount` | `discount=26` → 实付 74%（`factor=(100-26)/100`）；`startDiscountPoint` 为门槛（元） |
| 满减 | `query-promotions` | `promotionType=31`, `orderReduce.reduceInfo[]` | 阶梯 `startDiscountPoint` / `reduceAmount` |
| 不参与商品 | `query-promotions` | `products[].type=2` | 该 `productCode` 不打折 |
| 助餐服务 | `query-meal-assistance` | `gmServiceCode`, `enable`, `selected`, `unusableReason` | 只用 `enable=true`；不同服务折扣阶梯不同 |
| 配送/打包 | `calculate-price` 探测 | `deliveryPrice`, `packingPrice` | 从预算中扣除；最终以整单算价为准 |

口径：

- 活动是**整单满额**触发，不是每份打折；档位跳变（¥499 全价 vs ¥500×0.78）意味着更大一单可能更便宜。预算必须按实付算。
- 打包费本身也会被门店折扣/封顶（实测 1 件 ¥1.1、5 件 ¥3、20 件 ¥9），所以脚本用一次同规模探测而不是按件硬乘。
- 实测快照：`data/fixtures/promotions_3330310.json`（杭州下沙宝龙，保鲜速达 300→78折、500→74折、1000→70折、2000→66折），`selftest.py` 用它做离线回归。
- 团餐菜单价通常高于到店同品（例：汉堡包 ¥15 vs ¥14），换模式必须重跑。
- 支持时间窗：部分助餐服务 `enable=false`（如专人分餐仅 07:00–20:00 送达），脚本不选。


## 刷新方式

```bash
cd <skill>/scripts
python3 nutrition.py refresh     # 拉 MCP + 官网，覆盖 data/*.json 快照
rm -rf ../data/cache             # 需要时清掉门店菜单缓存
python3 catalog.py 1450713       # 重新生成某门店的候选目录（顺带打印缺失营养的品）
```

如果官网改版导致 `raw_data` 取不到，用浏览器（pi 的 playwright MCP）打开营养计算器页面，查看页面源码里的 `var raw_data`，或直接把页面表格整理成同结构 JSON；不要凭记忆填数。

## 已知不可靠的地方（必须在方案里说）

- 新品营养为估算（`≈`），尤其**龙焰系列、麦炫酷、心形薯饼、奶昔**。
- 组合餐营养是子项相加，门店实际配方/克重可能略有差异。
- 辣度仅按菜名 + `data/flags.json` 人工覆盖，不是官方分级；严格忌辣者建议多留不辣主食。
- 过敏原、清真、宗教饮食无法由本数据集判断，必须提示用户向门店确认。
- 菜单、价格、库存随门店与时段变化；换店/换时段要重跑。
