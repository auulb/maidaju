#!/usr/bin/env python3
"""CLI: build a McDonald's China group plan and render it as chat-ready markdown.

Examples
--------
# 8 people, ¥300, 2 avoid spicy, 1 wants sugar-free, nearest store to a landmark
python3 plan.py --people 8 --budget 300 --no-spicy 2 --no-sugar 1 \
    --city 上海市 --keyword 人民广场

# pin the store / use 麦乐送
python3 plan.py --people 8 --budget 300 --store 1450713
python3 plan.py --people 8 --budget 300 --address-id 123456 --be-type 2

# verify every plan with the live calculate-price tool (no payment)
python3 plan.py ... --verify
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))

import catalog  # noqa: E402
import mcd_api  # noqa: E402
import pricing  # noqa: E402
import solver  # noqa: E402
import trays  # noqa: E402

PROFILE_ICON = {"variety": "🎲", "fitness": "💪", "energy": "⚡"}
PROFILE_WHY = {
    "variety": "把预算摊到最多的单品上：汉堡、小食、甜品、咖啡都能尝到。",
    "fitness": "蛋白质密度最高、控制热量与脂肪；饮品优先无糖。",
    "energy": "同样预算塞进最多热量和主食，适合大胃王/久待场景。",
}


def money(v: float) -> str:
    return f"¥{v:.1f}".replace(".0", "") if abs(v - round(v)) < 0.05 else f"¥{v:.1f}"


def resolve_store(args) -> tuple[dict, list[dict]]:
    if args.store:
        return ({"storeCode": args.store, "storeName": args.store_name or args.store,
                 "beCode": args.be_code}, [])
    if args.address_id:
        stores = mcd_api.delivery_stores(args.address_id, args.be_type)
        if not stores:
            raise SystemExit("该地址没有可配送门店，请换地址或改用 --store 指定门店")
        s = stores[0]
        return ({"storeCode": s.get("storeCode") or s.get("code"),
                 "storeName": s.get("storeName") or s.get("name", ""),
                 "beCode": s.get("beCode")}, stores[1:])
    if args.be_type in (2, 6):
        # 麦乐送/团餐 are address-bound: nearby-stores cannot answer for them
        addresses = mcd_api.delivery_addresses()
        if not addresses:
            raise SystemExit("还没有配送地址：请用 delivery-create-address 新建，或传 --address-id")
        if len(addresses) > 1:
            rows = "\n".join(
                f"  {a.get('addressId')}  {a.get('contactName')}  {a.get('fullAddress')}"
                for a in addresses[:5])
            raise SystemExit(f"有多个配送地址，请用 --address-id 指定：\n{rows}")
        args.address_id = addresses[0].get("addressId")
        return resolve_store(args)
    if args.city and args.keyword:
        stores = mcd_api.nearby_stores(args.city, args.keyword, be_type=args.be_type)
        if not stores:
            raise SystemExit(f"没有找到「{args.keyword}」附近的门店，换个地标试试")
        s = stores[0]
        return ({"storeCode": s["storeCode"], "storeName": s.get("storeName", ""),
                 "beCode": s.get("beCode"), "address": s.get("address", ""),
                 "distance": s.get("distance")}, stores[1:])
    raise SystemExit("需要门店：--store，或 --city + --keyword，或 --address-id")


def render(data: dict, store: dict, alternatives: list[dict], args,
           model: pricing.PriceModel | None = None) -> str:
    c = data["constraints"]
    plans = data["plans"]
    people = c["people"]
    when = datetime.now().strftime("%Y-%m-%d %H:%M")

    lines: list[str] = []
    lines.append(f"## 🍔 {people} 人 · 预算 {money(c['budget'])} · 三套搭配方案")
    meta = f"门店：**{store.get('storeName')}**（{store['storeCode']}）"
    if store.get("address"):
        meta += f" · {store['address']}"
    lines.append(meta)
    constraints = [f"{people} 人", f"预算 {money(c['budget'])}"]
    if c["no_spicy"]:
        constraints.append(f"{c['no_spicy']} 人不吃辣")
    if c["no_sugar"]:
        constraints.append(f"{c['no_sugar']} 人要无糖")
    for label, key in (("不吃牛肉", "no_beef"), ("不吃猪肉", "no_pork"), ("不吃海鲜", "no_seafood"),
                       ("素食", "veg")):
        if c[key]:
            constraints.append(f"{c[key]} 人{label}")
    lines.append(f"约束：{' · '.join(constraints)}　菜单时间：{when}")
    if model is not None and (model.has_promotion or model.has_fees):
        lines.append(f"计价：{model.describe()}")
    lines.append("")

    lines.append("| 方案 | 总价 | 人均 | 总热量 | 人均热量 | 蛋白质 | 蛋白密度 | 单品数 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for p in plans:
        density = p["totals"]["protein"] / max(p["totals"]["kcal"], 1) * 1000
        lines.append(
            f"| {PROFILE_ICON[p['profile']]} {p['label']} | {money(p['cost'])} | "
            f"{money(p['per_person_cost'])} | {p['totals']['kcal']:.0f} kcal | "
            f"{p['per_person']['kcal']:.0f} kcal | {p['totals']['protein']:.0f} g | "
            f"{density:.0f} g/1000kcal | {p['counts']['distinct_items']} |"
        )
    lines.append("")

    signatures = {frozenset((it["name"], it["qty"]) for it in p["items"]) for p in plans}
    if len(signatures) == 1:
        lines.append("> 预算偏紧，三套方案在可行解上趋同（先保证每人主食+饮品）。"
                     "加一些预算或减少人数就能拉开差异。")
        lines.append("")

    letters = "ABCD"
    verified = data.get("verification") or {}
    for i, p in enumerate(plans):
        icon = PROFILE_ICON[p["profile"]]
        quote = p.get("quote") or {}
        lines.append(f"### {letters[i]}. {icon} {p['label']} · {p['tagline']}")
        price_line = f"**{money(p['cost'])}，人均 {money(p['per_person_cost'])}**"
        if quote.get("subtotal", p["cost"]) > p["cost"] + 0.05 or quote.get("discount"):
            price_line += f"（原价 {money(quote['subtotal'])}"
            if quote.get("discount"):
                price_line += f" − 活动 {money(quote['discount'])}"
            fee = quote.get("packing", 0) + quote.get("delivery", 0)
            if fee:
                price_line += f" + 配送/打包 {money(fee)}"
            price_line += "）"
        elif quote.get("packing") or quote.get("delivery"):
            price_line += f"（含配送/打包 {money(quote.get('packing', 0) + quote.get('delivery', 0))}）"
        v = verified.get(p["profile"]) or {}
        if v.get("server_price") is not None:
            delta = v.get("delta", 0)
            mark = "一致" if abs(delta) < 0.5 else f"差 {delta:+.1f}"
            price_line += f"　·　门店算价 {money(v['server_price'])}（{mark}）"
        lines.append(price_line)
        lines.append(
            f"{p['totals']['kcal']:.0f} kcal（人均 {p['per_person']['kcal']:.0f}）· "
            f"蛋白 {p['totals']['protein']:.0f} g（人均 {p['per_person']['protein']:.0f} g）"
        )
        if quote.get("tier_label") or quote.get("next_hint"):
            parts = []
            if quote.get("tier_label"):
                parts.append(f"活动：{quote['tier_label']}（{quote.get('service_name', '')}）")
            if quote.get("next_hint"):
                parts.append(quote["next_hint"])
            lines.append("　".join(parts))
        counts = p["counts"]
        lines.append(
            f"结构：主食 {counts['mains']} · 小食 {counts['sides']} · 饮品 {counts['drinks']}"
            f" · 甜品 {counts['desserts']}　｜　{PROFILE_WHY[p['profile']]}"
        )
        lines.append("")
        lines.append("| 单品 | 数量 | 单价 | 小计 | 热量 | 蛋白 |")
        lines.append("|---|---|---|---|---|---|")
        for it in p["items"]:
            looks_like_set = any(k in it["name"] for k in
                                 ("套餐", "三件套", "四件套", "分享餐", "双人餐", "随心配", "乐园餐", "盒"))
            is_set = it["kind"] == "combo" and sum(it["roles"].values()) >= 2
            name = it["name"] + ("（套餐）" if is_set and not looks_like_set else "")
            if it["estimated"]:
                name = "≈ " + name
            flags = []
            if it["spicy"]:
                flags.append("🌶")
            if it["sugar_free"]:
                flags.append("无糖")
            if flags:
                name += " `" + "/".join(flags) + "`"
            lines.append(
                f"| {name} | {it['qty']} | {money(it['unit_price'])} | {money(it['subtotal'])} | "
                f"{it['kcal'] * it['qty']:.0f} | {it['protein'] * it['qty']:.0f} g |"
            )
        lines.append("")
        spicy_ok = people - c["no_spicy"]
        alloc = [f"🌶 辣味主食 {counts['spicy_mains']} 份（不吃辣 {c['no_spicy']} 人可拿剩下的 "
                 f"{max(0, counts['mains'] - counts['spicy_mains'])} 份不辣）"] if counts["spicy_mains"] else []
        if c["no_sugar"]:
            alloc.append(f"🥤 无糖饮品 {counts['sugar_free_drinks']} 份（其中 {c['no_sugar']} 份给无糖需求）")
        if alloc:
            lines.append(" · ".join(alloc))
        est_cost = sum(it["subtotal"] for it in p["items"] if it["estimated"])
        if p["estimated_names"]:
            lines.append(f"≈ 营养为估算：{'、'.join(p['estimated_names'])}")
        if quote.get("discount_kind") == "discount" and model is not None:
            skipped = [it["name"] for it in p["items"]
                       if it["code"] in model.excluded_codes]
            if skipped:
                lines.append(f"不参与折扣（按原价）：{'、'.join(skipped)}")
        if p["cost"] and est_cost / p["cost"] > 0.2:
            lines.append(
                f"⚠️ 估算营养的商品占 {est_cost / p['cost']:.0%} 金额，"
                "热量/蛋白只适合横向参考，追求准数可让我换掉这些新品重算。"
            )
        if p["violations"]:
            lines.append(f"⚠️ 未能完全满足：{'；'.join(p['violations'])}")
        if p.get("trays"):
            lines.extend(render_trays(p["trays"], c))
        lines.append("")

    if data["min_viable_cost"] is not None:
        lines.append(
            f"> 底线成本：这家店要满足「{people} 人各 1 主食 + 1 饮品」最低约 "
            f"{money(data['min_viable_cost'])}；当前预算 {money(c['budget'])}。"
        )
    if alternatives:
        names = "、".join(f"{s.get('storeName')}（{s.get('storeCode')}）" for s in alternatives[:3])
        lines.append(f"> 备选门店：{names}。想换门店告诉我编号即可。")
    lines.append("")
    lines.append(
        "> 价格为门店菜单价：套餐按页面默认搭配计价，饮料换无糖按门店差价；"
        "标 ≈ 的单品官方营养表暂未收录，热量/蛋白为估算值。"
    )
    if model is not None and (model.has_promotion or model.has_fees):
        lines.append(
            "> 总价已按门店规则折算：团餐活动按整单满额触发（不是每份打折），"
            "配送/打包费为订单级费用；逐人餐盘里的「分摊」已按人均包含这部分差额。"
        )
    lines.append("")
    lines.append("下一步：回复 **A / B / C** 选一套，我会用门店算价接口复核实际价格（不进入支付）。")
    return "\n".join(lines)


def render_trays(t: dict, c: dict) -> list[str]:
    """Render the per-member allocation (逐人餐盘) for one plan."""
    if not t.get("members"):
        return []
    lines = ["#### 逐人餐盘", ""]
    lines.append("| 成员 | 主食 | 饮品 | 分摊 | 个人预算 |")
    lines.append("|---|---|---|---|---|")
    for r in t["members"]:
        def cell(p, marks=True):
            if not p:
                return "—"
            label = p["name"]
            tags = []
            if marks and p["spicy"]:
                tags.append("🌶")
            if marks and p["sugar_free"]:
                tags.append("无糖")
            if tags:
                label += " `" + "/".join(tags) + "`"
            return label

        budget = f"¥{r['budget']:.0f}" if r.get("budget") else "—"
        if r.get("over_budget"):
            budget = f"¥{r['budget']:.0f} ⚠️ 超 ¥{r['over_budget']:.1f}"
        elif r.get("budget"):
            budget += " ✓"
        flags = f" `{'/'.join(r['flags'])}`" if r.get("flags") else ""
        lines.append(
            f"| {r['name']}{flags} | {cell(r['main'])} | {cell(r['drink'])} | "
            f"¥{r['total_cost']:.1f} | {budget} |"
        )
    lines.append("")
    if t.get("shared"):
        per = t["members"][0]["shared_share"] if t["members"] else 0
        items = "、".join(f"{g['name']} ×{g['qty']}" for g in t["shared"])
        lines.append(f"共享（人均 ¥{per:.1f}）：{items}")
    order_share = (t["members"][0].get("order_share") or 0) if t.get("members") else 0
    if abs(order_share) >= 0.05:
        sign = "+" if order_share > 0 else "−"
        label = "配送/打包费" if order_share > 0 else "活动优惠"
        lines.append(f"订单级{label}按人均 {sign}¥{abs(order_share):.1f} 分摊（已在「分摊」列计入）")
    if c.get("no_spicy") and any(g["spicy"] for g in t.get("shared") or []):
        lines.append("> 共享里有辣味小食，请留给能吃辣的成员。")
    if t.get("conflicts"):
        lines.append(f"⚠️ 餐盘冲突：{'；'.join(t['conflicts'])}")
    return lines


def verify(data: dict, store: dict, args,
           model: pricing.PriceModel | None = None) -> dict[str, dict]:
    """Ask the live calculate-price tool to price each plan (no order is created)."""
    out: dict[str, dict] = {}
    for p in data["plans"]:
        try:
            resp = mcd_api.calculate_price(
                store["storeCode"], p["order_items"], args.order_type, args.be_type,
                store.get("beCode"), args.reservation,
                model.service_code if model is not None and model.mode == "catering" else None,
            )
            d = resp.get("data") or {}
            if not d or "price" not in d:
                out[p["profile"]] = {"error": "算价接口未返回价格（该门店/模式可能不支持算价）"}
                continue
            server = (d.get("price") or 0) / 100
            coupon = d.get("enjoyed") or {}
            out[p["profile"]] = {
                "server_price": server,
                "computed": p["cost"],
                "delta": round(server - p["cost"], 2),
                "original": (d.get("originalPrice") or 0) / 100,
                "discount": (d.get("discount") or 0) / 100,
                "delivery": (d.get("deliveryPrice") or 0) / 100,
                "packing": (d.get("packingPrice") or 0) / 100,
                "promotion": coupon.get("promotionName") or "",
                "next_balance": (d.get("enjoyable") or {}).get("balance"),
                "items": [f"{x.get('productName')} x{x.get('quantity')}"
                          for x in d.get("productList", [])],
            }
        except Exception as e:  # network / promo quirks should not kill the plan
            out[p["profile"]] = {"error": str(e)}
    return out


def apply_quotes(data: dict, model: pricing.PriceModel, people: int, budget: float) -> None:
    """Replace solver (promo-scaled) costs with the payable amount."""
    for plan in data["plans"]:
        q = model.quote(plan["items"], budget)
        plan["quote"] = q.as_dict()
        plan["subtotal"] = q.subtotal
        plan["discount"] = q.discount
        plan["fees"] = round(q.packing + q.delivery, 2)
        plan["cost"] = q.total
        plan["per_person_cost"] = round(q.total / people, 1) if people else 0.0
        plan.setdefault("constraints", {})["budget"] = budget
    data.setdefault("constraints", {})["budget"] = budget

    if data.get("min_viable_cost") is not None:
        tier = model.tier_for_budget(max(0.0, budget - model.fees()))
        raw = float(data["min_viable_cost"])
        subtotal = raw / tier.factor if tier and tier.factor else raw
        data["min_viable_cost_raw"] = raw
        data["min_viable_cost_menu"] = round(subtotal, 1)
        data["min_viable_cost"] = model.quote_subtotal(subtotal, budget).total


def reconcile(data: dict, cons: solver.Constraints, products: list[dict],
              model: pricing.PriceModel, store: dict, args) -> tuple[dict, dict]:
    """Verify with calculate-price, then re-solve once if the model was off.

    Promotions + fees mean the model can only approximate the payable amount;
    the store is authoritative. One shrink pass (over budget) and one top-up
    pass (left too much money unspent) keep the plan honest without looping.
    """
    verification = verify(data, store, args, model)
    for step in range(2):
        prices = {k: v["server_price"] for k, v in verification.items()
                  if "server_price" in v}
        if not prices:
            return verification, data
        over = max(prices.values()) - args.budget
        leftover = args.budget - max(prices.values())
        if over > 0.5:
            cons.budget = max(0.0, cons.budget - (over + 1.0))
        elif step == 0 and leftover > max(8.0, args.budget * 0.1):
            cons.budget += leftover * 0.75
        else:
            return verification, data
        data = solver.solve(products, cons)
        apply_quotes(data, model, args.people, args.budget)
        verification = verify(data, store, args, model)
    return verification, data


def main() -> None:
    ap = argparse.ArgumentParser(description="McDonald's China group meal planner")
    ap.add_argument("--people", type=int, help="number of people (optional when --member is used)")
    ap.add_argument("--budget", type=float, required=True, help="total budget in CNY")
    ap.add_argument("--member", action="append", default=[], metavar="NAME[:tag,...]",
                    help="named member, e.g. '小王:no-spicy,no-sugar,budget=35' (repeatable; "
                         "enables per-person trays)")
    ap.add_argument("--no-spicy", type=int, default=0)
    ap.add_argument("--no-sugar", type=int, default=0, help="people who want sugar-free drinks")
    ap.add_argument("--no-beef", type=int, default=0)
    ap.add_argument("--no-pork", type=int, default=0)
    ap.add_argument("--no-seafood", type=int, default=0)
    ap.add_argument("--veg", type=int, default=0, help="vegetarians (best effort)")

    ap.add_argument("--store", help="storeCode")
    ap.add_argument("--store-name")
    ap.add_argument("--be-code")
    ap.add_argument("--city")
    ap.add_argument("--keyword")
    ap.add_argument("--address-id")
    ap.add_argument("--be-type", type=int, default=1, choices=[1, 2, 5, 6])
    ap.add_argument("--order-type", type=int, default=1, choices=[1, 2])
    ap.add_argument("--reservation", help="yyyy-MM-dd HH:mm")
    ap.add_argument("--no-breakfast", action="store_true")
    ap.add_argument("--exclude", action="append", default=[], help="keyword to exclude, repeatable")
    ap.add_argument("--min-kcal", type=float, default=500, help="min kcal per person")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--no-promo", action="store_true",
                    help="ignore 团餐 满折/满减 and price at menu price")
    ap.add_argument("--gm-service", help="pin a 助餐服务 code (GMS001/002/003)")
    ap.add_argument("--json", help="write machine-readable result")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    members: list[trays.Member] = []
    if args.member:
        try:
            members = trays.parse_members(args.member)
        except trays.MemberSpecError as e:
            raise SystemExit(str(e))
        if args.people is not None and args.people != len(members):
            raise SystemExit(f"--people {args.people} 与 --member 数量 {len(members)} 不一致")
        derived = trays.member_constraints(members)
        for key, label in (("no_spicy", "不吃辣"), ("no_sugar", "无糖"),
                           ("no_beef", "不吃牛肉"), ("no_pork", "不吃猪肉"),
                           ("no_seafood", "不吃海鲜"), ("veg", "素食")):
            explicit = getattr(args, key)
            if explicit and explicit != derived[key] and not args.quiet:
                print(f"[members] --{key.replace('_', '-')} {explicit} 与成员标签算出的 "
                      f"{derived[key]} 不一致，按成员标签为准", file=sys.stderr)
            setattr(args, key, derived[key])
        args.people = len(members)
        if all(m.budget for m in members):
            cap_total = round(sum(m.budget for m in members), 2)
            if cap_total < args.budget:
                if not args.quiet:
                    print(f"[members] 个人预算合计 ¥{cap_total:.1f} < 总预算 ¥{args.budget:.1f}，"
                          "按个人预算合计求解", file=sys.stderr)
                args.budget = cap_total
    if args.people is None:
        raise SystemExit("需要 --people，或用 --member 给出每位成员")

    store, alternatives = resolve_store(args)
    if args.be_type in (5, 6, 2) and not store.get("beCode"):
        # beCode belongs to the store; pull it from the store list when missing
        if args.city and args.keyword:
            for s in mcd_api.nearby_stores(args.city, args.keyword, be_type=args.be_type):
                if s.get("storeCode") == store["storeCode"]:
                    store["beCode"] = s.get("beCode")
                    break

    cat = catalog.build(store["storeCode"], args.order_type, args.be_type, store.get("beCode"),
                        args.reservation, verbose=not args.quiet)
    cheapest = min((p for p in cat["products"] if p["roles"]["main"]),
                   key=lambda p: p["price"], default=None)
    model = pricing.build_model(
        store["storeCode"], args.order_type, args.be_type, store.get("beCode"),
        budget=args.budget, probe_code=(cheapest or {}).get("code"), people=args.people,
        reservation=args.reservation, service_code=args.gm_service,
        use_promotions=not args.no_promo, verbose=not args.quiet,
    )
    products, solve_budget, tier = pricing.apply_model(cat["products"], model, args.budget)

    cons = solver.Constraints(
        people=args.people, budget=solve_budget,
        no_spicy=args.no_spicy, no_sugar=args.no_sugar,
        no_beef=args.no_beef, no_pork=args.no_pork, no_seafood=args.no_seafood,
        veg=args.veg, min_kcal_per_person=args.min_kcal,
        include_breakfast=not args.no_breakfast,
        exclude=args.exclude,
        member_profiles=[trays.profile_of(m) for m in members],
    )
    data = solver.solve(products, cons)
    apply_quotes(data, model, args.people, args.budget)
    data["pricing"] = {
        "mode": model.mode,
        "service_code": model.service_code,
        "service_name": model.service_name,
        "tier": tier.label if tier else "",
        "tier_threshold": tier.threshold if tier else None,
        "tier_factor": tier.factor if tier else None,
        "excluded_codes": sorted(model.excluded_codes),
        "delivery_fee": model.delivery_fee,
        "packing_fee": model.packing_fee,
        "description": model.describe(),
        "solve_budget": round(solve_budget, 2),
    }

    if args.verify:
        data["verification"], data = reconcile(data, cons, products, model, store, args)
        for profile, v in data["verification"].items():
            label = solver.PROFILES[profile]["label"]
            if "error" in v:
                print(f"[verify] {label}: 算价失败 {v['error']}", file=sys.stderr)
            else:
                print(f"[verify] {label}: 计划 {v['computed']:.1f} → 门店 {v['server_price']:.1f}"
                      f"（差 {v['delta']:+.1f}）"
                      + (f" · {v['promotion']}" if v.get("promotion") else ""),
                      file=sys.stderr)

    if members:
        for plan in data["plans"]:
            plan["trays"] = trays.assign(
                plan, members, order_adjustment=plan["cost"] - plan["subtotal"])
        data["members"] = [
            {"name": m.name, "flags": m.flags, "budget": m.budget} for m in members
        ]
    data["store"] = store
    data["generated_at"] = datetime.now().isoformat(timespec="seconds")

    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)

    print(render(data, store, alternatives, args, model))


if __name__ == "__main__":
    main()
