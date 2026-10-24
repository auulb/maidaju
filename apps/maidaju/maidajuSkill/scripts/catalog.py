"""Turn a live McDonald's China menu into planner candidates.

The MCP menu is *not* a flat SKU list: many rows are combos ("三件套") or
drinks with a size round. This module expands them into orderable products
with a price, a role breakdown (main / side / drink / dessert) and nutrition.

Pricing: menu price + the choice's `diffPrice`, i.e. the price the store will
actually charge for that configuration.

Nutrition: resolved per component from `nutrition.py`; combos are the sum of
their components. Anything that cannot be resolved is flagged `estimated`
so the plan can say so instead of pretending.
"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import mcd_api
import nutrition as nut

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLAGS_JSON = os.path.join(HERE, "data", "flags.json")

DEFAULT_FLAGS = {
    "spicy_keywords": ["辣", "龙焰", "麻小", "椒麻"],
    "sugarfree_keywords": ["无糖", "纯悦", "美式", "鲜萃", "浓缩", "锡兰红茶", "伯爵红茶", "零度"],
    "exclude_name_patterns": [
        "丝巾", "棒球帽", "水手帽", "按摩", "痒痒挠", "玩具", "礼盒", "公仔", "周边",
        "风味酱$", "蘸酱$",
    ],
    "role_overrides": {},
    "spicy_overrides": {},
}


def load_flags() -> dict:
    flags = json.loads(json.dumps(DEFAULT_FLAGS))
    if os.path.exists(FLAGS_JSON):
        with open(FLAGS_JSON, encoding="utf-8") as f:
            flags.update(json.load(f))
    return flags


DESSERT_RE = re.compile(r"新地|麦旋风|冰淇淋|圆筒|派$|阿芙佳朵|拉明顿|雪冰|蛋糕|甜筒")
MAIN_RE = re.compile(r"堡|卷|麦满分|巨无霸")
DRINK_RE = re.compile(r"可乐|雪碧|红茶|咖啡|美式|拿铁|奶铁|牛奶|豆浆|果汁|纯悦|怡泉|橙|柠柠|奶昔|麦炫酷|茶|水$")


def classify(name: str, flags: dict) -> str:
    override = flags.get("role_overrides", {}).get(name)
    if override:
        return override
    if DESSERT_RE.search(name):
        return "dessert"
    if MAIN_RE.search(name):
        return "main"
    if DRINK_RE.search(name):
        return "drink"
    return "side"


def is_spicy(name: str, flags: dict) -> bool:
    override = flags.get("spicy_overrides", {}).get(name)
    if override is not None:
        return bool(override)
    return any(k in name for k in flags["spicy_keywords"])


def is_sugarfree(name: str, flags: dict) -> bool:
    return any(k in name for k in flags["sugarfree_keywords"])


def _price(s) -> float:
    try:
        return float(str(s).replace("¥", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _diff(s) -> float:
    if not s:
        return 0.0
    m = re.search(r"([+-]?)\s*¥?\s*([\d.]+)", str(s))
    if not m:
        return 0.0
    v = float(m.group(2))
    return -v if m.group(1) == "-" else v


def _food_group(name: str, role: str) -> str:
    if role == "other":
        return ""
    if role == "main":
        return "汉堡/卷"
    if role == "dessert":
        return "甜品"
    if role == "drink":
        return "咖啡" if re.search(r"咖啡|美式|拿铁|奶铁|卡布|浓缩|阿芙佳朵", name) else "饮品"
    return "小食"


def _clean_category(name: str) -> str:
    return re.sub(r"\s+", "", name).replace("/", " / ")


class NutritionFallback:
    """Median per-role numbers, used only for items with no official record."""

    def __init__(self) -> None:
        self.median: dict[str, dict] = {}

    def fit(self, products: list[dict]) -> None:
        buckets: dict[str, list[dict]] = {}
        for p in products:
            if p["estimated"] or len(p["parts"]) != 1:
                continue
            buckets.setdefault(p["parts"][0]["role"], []).append(p["totals"])
        for role, rows in buckets.items():
            self.median[role] = {
                k: statistics.median([r[k] for r in rows])
                for k in ("kcal", "protein", "fat", "carb", "sodium")
            }

    def for_role(self, role: str) -> dict:
        return dict(self.median.get(role) or self.median.get("main") or {
            "kcal": 300, "protein": 12, "fat": 12, "carb": 30, "sodium": 500,
        })


def _add_nutrition(acc: dict, n: dict, qty: float = 1) -> None:
    acc["kcal"] += (n.get("kcal") or 0) * qty
    acc["protein"] += (n.get("protein_g") or 0) * qty
    acc["fat"] += (n.get("fat_g") or 0) * qty
    acc["carb"] += (n.get("carb_g") or 0) * qty
    acc["sodium"] += (n.get("sodium_mg") or 0) * qty


def _sum_parts(parts: list[dict]) -> dict:
    acc = {"kcal": 0.0, "protein": 0.0, "fat": 0.0, "carb": 0.0, "sodium": 0.0}
    for part in parts:
        for k in acc:
            acc[k] += part[k] * part["qty"]
    return {k: round(v, 1) for k, v in acc.items()}


def _resolve_part(name: str, role: str, qty: int, fallback: NutritionFallback,
                  flags: dict) -> dict:
    db = nut.db()
    if nut.IGNORE_RE.search(name) and not db.resolve(name):
        return {"name": name, "role": "other", "qty": qty, "kcal": 0.0, "protein": 0.0,
                "fat": 0.0, "carb": 0.0, "sodium": 0.0, "matched": None,
                "source": "condiment/packaging (0 kcal)", "estimated": False}
    mult = 1.0
    for alias, (target, m) in nut.ALIASES.items():
        if nut.norm(name) == nut.norm(alias):
            mult = m
            break
    hit = db.resolve(name)
    if hit:
        return {
            "name": name,
            "role": role,
            "qty": qty,
            "kcal": (hit["kcal"] or 0) * mult,
            "protein": (hit["protein_g"] or 0) * mult,
            "fat": (hit["fat_g"] or 0) * mult,
            "carb": (hit["carb_g"] or 0) * mult,
            "sodium": (hit["sodium_mg"] or 0) * mult,
            "matched": hit["name"],
            "source": hit["source"],
            "estimated": bool(hit.get("estimated")),
        }
    med = fallback.for_role(role)
    return {
        "name": name, "role": role, "qty": qty,
        **{k: med[k] for k in ("kcal", "protein", "fat", "carb", "sodium")},
        "matched": None, "source": "estimate(role median)", "estimated": True,
    }


def _payload(menu_raw: dict) -> dict:
    return (menu_raw.get("data") or {})


def build(store_code: str, order_type: int = 1, be_type: int = 1, be_code: str | None = None,
          reservation: str | None = None, verbose: bool = True) -> dict:
    flags = load_flags()
    raw = _payload(mcd_api.menu(store_code, order_type, be_type, be_code, reservation))
    meals = raw.get("meals") or {}
    categories: list[dict] = raw.get("categories") or []

    excluded_re = [re.compile(p) for p in flags["exclude_name_patterns"]]
    order: list[str] = []
    cat_of: dict[str, str] = {}
    for cat in categories:
        cname = _clean_category(cat.get("name", ""))
        for m in cat.get("meals") or []:
            code = str(m.get("code"))
            if code in cat_of or code not in meals:
                continue
            cat_of[code] = cname
            order.append(code)

    def menu_price(code: str) -> tuple[float, bool]:
        m = meals[code]
        price = _price(m.get("currentPrice"))
        original = _price(m.get("originalPrice"))
        # "随单购麦金卡优惠" prices only apply if the group also buys a membership
        # card, so budget with the honest (original) price instead.
        if "随单购" in (m.get("discountType") or "") and original > price:
            return original, True
        return price, False

    def keep(code: str) -> bool:
        name = meals[code].get("name", "")
        if not name or any(r.search(name) for r in excluded_re):
            return False
        return menu_price(code)[0] > 0

    order = [c for c in order if keep(c)]

    def fetch_detail(code: str) -> tuple[str, dict]:
        last: Exception | None = None
        for attempt in range(3):
            try:
                return code, mcd_api.meal_detail(store_code, code, order_type, be_type,
                                                 be_code, reservation)
            except Exception as e:  # a single broken detail must not kill the plan
                last = e
                time.sleep(0.6 * (attempt + 1))
        if verbose:
            print(f"  ! detail failed for {code}: {last}")
        return code, {}

    details: dict[str, dict] = {}
    # details are independent reads; fetch them concurrently (6 in flight)
    with ThreadPoolExecutor(max_workers=6) as pool:
        for code, payload in pool.map(fetch_detail, order):
            details[code] = payload

    def detail_data(code: str) -> dict:
        return details.get(code, {}).get("data") or {}

    # ---- pass 1: a-la-carte items (no rounds) so the fallback medians are real
    fallback = NutritionFallback()
    simple: list[dict] = []
    for code in order:
        d = detail_data(code)
        name = d.get("name") or meals[code].get("name")
        if not name:
            continue
        rounds = d.get("rounds") or []
        if rounds:
            continue
        role = classify(name, flags)
        part = _resolve_part(name, role, 1, fallback, flags)
        totals = _sum_parts([part])
        simple.append({
            "id": code, "code": code, "name": name,
            "category": cat_of.get(code, ""),
            "price": menu_price(code)[0],
            "card_required": menu_price(code)[1],
            "kind": "simple", "parts": [part], "totals": totals,
            "estimated": part["estimated"], "order": {"productCode": code, "quantity": 1},
        })
    fallback.fit(simple)

    products: list[dict] = []
    seen_ids: set[str] = set()

    def emit(p: dict) -> None:
        base = p["id"]
        pid, n = base, 2
        while pid in seen_ids:
            pid = f"{base}~{n}"
            n += 1
        p["id"] = pid
        seen_ids.add(pid)
        p["spicy"] = any(is_spicy(part["name"], flags) for part in p["parts"] if part["role"] in ("main", "side"))
        p["sugar_free"] = all(
            is_sugarfree(part["name"], flags)
            for part in p["parts"] if part["role"] == "drink"
        ) if any(part["role"] == "drink" for part in p["parts"]) else False
        p["roles"] = {r: sum(part["qty"] for part in p["parts"] if part["role"] == r)
                      for r in ("main", "side", "drink", "dessert")}
        p["groups"] = sorted({g for g in (_food_group(part["name"], part["role"])
                                         for part in p["parts"]) if g})
        p["sweet_drink"] = p["roles"]["drink"] - (p["roles"]["drink"] if p["sugar_free"] else 0)
        p["nutrition_quality"] = (
            "official" if not p["estimated"] and p["kind"] == "simple"
            else "derived" if not p["estimated"] else "partial_estimate"
        )
        products.append(p)

    for p in simple:
        emit(p)

    # ---- pass 2: rounds -> drink size variants and combos
    for code in order:
        d = detail_data(code)
        rounds = d.get("rounds") or []
        if not rounds:
            continue
        name = d.get("name") or meals[code].get("name")
        base_price, card_required = menu_price(code)
        cat = cat_of.get(code, "")

        def pick_defaults(rd: dict) -> list[dict]:
            choices = rd.get("choices") or []
            picked = [c for c in choices if str(c.get("isDefault")) == "1"]
            if not picked:
                need = max(1, int(rd.get("minQuantity") or 1))
                picked = choices[:need]
            return picked

        # a single round whose choices all share one role == a size/flavour picker
        # (drink sizes, pie flavours, ...). Expand it into real products.
        one_round_roles = {classify(c.get("name", ""), flags) for c in rounds[0].get("choices") or []}
        if len(rounds) == 1 and len(one_round_roles) == 1:
            rd = rounds[0]
            role = next(iter(one_round_roles))
            round_qty = int(rd.get("quantity") or 1)
            for c in rd.get("choices") or []:
                cname = c.get("name", "")
                part = _resolve_part(cname, role, round_qty, fallback, flags)
                price = base_price + (_diff(c.get("diffPrice")) or 0)
                if price <= 0:
                    continue
                emit({
                    "id": f"{code}:{c.get('code')}", "code": code, "name": cname, "category": cat,
                    "price": round(price, 2), "card_required": card_required,
                    "kind": "simple", "parts": [part],
                    "totals": _sum_parts([part]), "estimated": part["estimated"],
                    "order": {"productCode": code, "quantity": 1,
                              "roundList": [{"round": str(rd.get("id")), "comboItemList": [
                                  {"code": str(c.get("code")), "quantity": 1}]}]},
                    "option_code": str(c.get("code")),
                })
            continue

        # combo: default configuration
        def config(overrides: dict[int, dict] | None = None) -> tuple[list[dict], float, list[dict]]:
            parts: list[dict] = []
            extra = 0.0
            order_rounds: list[dict] = []
            for rd in rounds:
                rid = int(rd.get("id") or 0)
                choices = pick_defaults(rd)
                if overrides and rid in overrides:
                    oc = overrides[rid]
                    choices = [{**oc, "quantity": int(rd.get("quantity") or 1)}]
                for c in choices:
                    cname = c.get("name", "")
                    role = classify(cname, flags)
                    qty = int(c.get("quantity") or rd.get("quantity") or 1)
                    parts.append(_resolve_part(cname, role, qty, fallback, flags))
                    extra += _diff(c.get("diffPrice"))
                order_rounds.append({
                    "round": str(rd.get("id")),
                    "comboItemList": [{"code": str(c.get("code")), "quantity": int(c.get("quantity") or 1)}
                                      for c in choices],
                })
            return parts, extra, order_rounds

        parts, extra, order_rounds = config()
        if not parts:
            continue
        totals = _sum_parts(parts)
        emit({
            "id": code, "code": code, "name": name, "category": cat,
            "price": round(base_price + extra, 2), "card_required": card_required,
            "kind": "combo", "parts": parts,
            "totals": totals, "estimated": any(p["estimated"] for p in parts),
            "order": {"productCode": code, "quantity": 1, "roundList": order_rounds},
        })

        # combo + zero-sugar drink swap (the person who asked for 无糖)
        drink_round = next(
            (rd for rd in rounds
             if any(classify(c.get("name", ""), flags) == "drink" for c in rd.get("choices") or [])),
            None,
        )
        if drink_round:
            zc = min(
                (c for c in drink_round.get("choices") or []
                 if is_sugarfree(c.get("name", ""), flags) and classify(c.get("name", ""), flags) == "drink"),
                key=lambda c: (abs(_diff(c.get("diffPrice"))), 0 if "无糖" in c.get("name", "") else 1),
                default=None,
            )
            if zc:
                rid = int(drink_round.get("id") or 0)
                zparts, zextra, zorder = config({rid: zc})
                ztotals = _sum_parts(zparts)
                emit({
                    "id": f"{code}:sg", "code": code, "name": f"{name}（饮料换无糖）",
                    "category": cat, "price": round(base_price + zextra, 2),
                    "card_required": card_required, "kind": "combo",
                    "parts": zparts, "totals": ztotals,
                    "estimated": any(p["estimated"] for p in zparts),
                    "order": {"productCode": code, "quantity": 1, "roundList": zorder},
                })

    # The same drink can be reachable through two menu codes (e.g. regular 雪碧
    # and "学生专享饮品随心选"). Same name + same price => same thing to a user;
    # keep the row with the better nutrition record so variety is not inflated.
    merged: dict[tuple, dict] = {}
    for p in products:
        key = (p["name"], round(p["price"], 1))
        cur = merged.get(key)
        if cur is None or (cur["estimated"] and not p["estimated"]):
            merged[key] = p
    products = list(merged.values())
    products.sort(key=lambda p: (p["category"], p["price"]))
    if verbose:
        est = [p for p in products if p["estimated"]]
        print(f"menu items: {len(order)}, products: {len(products)}, "
              f"estimated-nutrition products: {len(est)}", file=sys.stderr)
        for p in est[:15]:
            print(f"  ? {p['name']} (¥{p['price']})", file=sys.stderr)
    return {
        "store_code": store_code,
        "order_type": order_type,
        "be_type": be_type,
        "be_code": be_code,
        "reservation": reservation,
        "categories": [_clean_category(c.get("name", "")) for c in categories],
        "products": products,
    }


if __name__ == "__main__":
    import sys

    store = sys.argv[1] if len(sys.argv) > 1 else "1450713"
    data = build(store)
    out = os.path.join(HERE, "data", "cache", f"catalog_{store}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print("wrote", out)
