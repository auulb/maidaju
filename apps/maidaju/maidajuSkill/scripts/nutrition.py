"""Nutrition data for McDonald's China menu items.

Two official-ish sources, merged into one lookup index:

1. `list-nutrition-foods` from the McDonald's China MCP (per-item kcal/protein/
   fat/carb/sodium/calcium, updated continuously, includes current promo items).
2. The official nutrition calculator page
   https://www.mcdonalds.com.cn/index/Food/营养均衡/营养计算器
   Its data is embedded as `var raw_data = {...}` and also carries portion
   weight (grams), which the MCP list does not expose.

Refresh (network, optional — snapshots are committed so planning works offline):

    python3 nutrition.py refresh

Nothing here guesses silently: every entry records `source`, and `resolve()`
returns None when it cannot find a real record so the caller can mark the
number as an estimate in the user-facing plan.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import urllib.error
import urllib.request
from difflib import SequenceMatcher

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
OFFICIAL_JSON = os.path.join(DATA, "official_nutrition.json")
MCP_JSON = os.path.join(DATA, "mcp_nutrition.json")
MANUAL_JSON = os.path.join(DATA, "manual_nutrition.json")

CALC_URL = (
    "https://www.mcdonalds.com.cn/index/Food/"
    "%E8%90%A5%E5%85%BB%E5%9D%87%E8%A1%A1/%E8%90%A5%E5%85%BB%E8%AE%A1%E7%AE%97%E5%99%A8"
)

SIZES = ("迷你", "小", "中", "大", "超大")

# Menu wording -> nutrition-record wording. Value may carry a multiplier when the
# menu portion is a multiple of the record (e.g. 4 wings = 2 x "2块").
ALIASES: dict[str, tuple[str, float]] = {
    "苹果片一袋60g": ("苹果片", 1),
    "苹果片(60g)": ("苹果片", 1),
    "5块麦乐鸡": ("麦乐鸡5块", 1),
    "4块麦乐鸡": ("麦乐鸡4块", 1),
    "原味双层深海鳕鱼堡": ("双层深海鳕鱼堡", 1),
    "鱼排堡": ("儿童鱼排堡", 1),
    "麦辣鸡翅4块": ("麦辣鸡翅-2块", 2),
    "灰焰圆筒": ("圆筒冰淇淋", 1),
}

# Condiments / packaging / toys: real menu rows, but not calories we plan with.
IGNORE_RE = re.compile(r"风味酱|^蘸酱$|酱$|玩具|餐具|餐巾|湿巾|吸管|手提袋")


def norm(s: str) -> str:
    s = (s or "").strip()
    s = s.replace("™", "").replace("®", "")
    for token in ("（冰/热）", "(冰/热)", "冰/热"):
        s = s.replace(token, "")
    s = re.sub(r"[\s\u3000（）()【】\[\]“”\"'·•\-—–_,，.。、/+＋]", "", s)
    s = s.replace("大杯", "大").replace("中杯", "中").replace("小杯", "小")
    s = s.replace("（盒装）", "").replace("盒装", "")
    return s


def _split_size(n: str):
    for size in SIZES:
        if n.startswith(size) and len(n) > len(size):
            return n[len(size):], size
        if n.endswith(size) and len(n) > len(size):
            return n[: -len(size)], size
    return n, None


# --------------------------------------------------------------------- refresh


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            ctx = ssl._create_unverified_context()
            with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
                return r.read().decode("utf-8", "replace")
        raise


def fetch_official() -> list[dict]:
    html = _get(CALC_URL)

    m = re.search(r"var raw_data = (\{.*?\});\s*var raw_category_list", html, re.S)
    if not m:
        raise RuntimeError("nutrition calculator page layout changed: raw_data not found")
    raw = json.loads(m.group(1))

    entries: list[dict] = []
    seen: set[str] = set()
    for cat in raw["category_list"]:
        for pid in cat["Product"]:
            product = raw["Product"].get(pid)
            if not product:
                continue
            base = product["title"]
            for tid in product.get("ProductType") or []:
                ptype = raw["ProductType"].get(tid)
                if not ptype:
                    continue
                nt = ptype.get("nutrition") or []
                if len(nt) < 6:
                    continue
                # field order: [weight_g, energy_kj, protein, fat, carb, sodium,
                #               sugar?, sat_fat?, ..., cholesterol?, fiber?, ..., calcium]
                weight, kj = nt[0], nt[1]
                if not kj:
                    continue
                size = ptype["title"]
                names = [base]
                if size and size not in ("默认", "1个", "1份", "1盒", "一盒", "一袋"):
                    names = [f"{base}{size}", f"{size}{base}"]
                entry = {
                    "name": names[0],
                    "base": base,
                    "size": None if size in ("默认", "1个", "1份", "1盒", "一盒", "一袋") else size,
                    "weight_g": _num(weight),
                    "kcal": round(float(kj) / 4.184, 1),
                    "protein_g": _num(nt[2]),
                    "fat_g": _num(nt[3]),
                    "carb_g": _num(nt[4]),
                    "sodium_mg": _num(nt[5]),
                    "calcium_mg": _num(nt[13]) if len(nt) > 13 else None,
                    "source": "mcdonalds.com.cn/营养计算器",
                }
                for nm in names:
                    key = norm(nm)
                    if key and key not in seen:
                        seen.add(key)
                        entries.append({**entry, "name": nm})
    return entries


def fetch_mcp() -> list[dict]:
    import mcd_api

    text = mcd_api.nutrition_foods()
    entries: list[dict] = []
    header = None
    for line in text.splitlines():
        if line.startswith("[") and "{" in line:
            header = line.strip()
            continue
        if not header or line.rstrip().endswith("]:") or not line.strip():
            continue
        parts = [p.strip() for p in line.split(",")]
        if parts[0] in ("productName",) or len(parts) < 7:
            continue
        try:
            name = parts[0]
            kj, kcal, protein, fat, carb, sodium = (float(x) if x not in ("null", "") else 0.0
                                                   for x in parts[2:8])
        except ValueError:
            continue
        # header order: productName, nutritionDescription, energyKj, energyKcal,
        #               protein, fat, carbohydrate, sodium, calcium
        calcium = float(parts[8]) if len(parts) > 8 and parts[8] not in ("null", "") else None
        entries.append(
            {
                "name": name,
                "base": _split_size(norm(name))[0],
                "size": _split_size(norm(name))[1],
                "weight_g": None,
                "kcal": kcal or round(kj / 4.184, 1),
                "protein_g": protein,
                "fat_g": fat,
                "carb_g": carb,
                "sodium_mg": sodium,
                "calcium_mg": calcium,
                "source": "MCP list-nutrition-foods",
            }
        )
    return entries


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def refresh() -> tuple[int, int]:
    official = fetch_official()
    mcp = fetch_mcp()
    os.makedirs(DATA, exist_ok=True)
    with open(OFFICIAL_JSON, "w", encoding="utf-8") as f:
        json.dump(official, f, ensure_ascii=False, indent=1)
    with open(MCP_JSON, "w", encoding="utf-8") as f:
        json.dump(mcp, f, ensure_ascii=False, indent=1)
    return len(official), len(mcp)


# ----------------------------------------------------------------------- index


class NutritionDB:
    def __init__(self) -> None:
        self.exact: dict[str, dict] = {}
        self.by_base: dict[str, dict[str, dict]] = {}
        self._load()

    def _load(self) -> None:
        for path in (MCP_JSON, OFFICIAL_JSON, MANUAL_JSON):
            if not os.path.exists(path):
                continue
            if path == MANUAL_JSON:
                with open(path, encoding="utf-8") as f:
                    doc = json.load(f)
                for e in doc.get("entries", []):
                    e = {**e, "source": doc.get("source", "manual estimate"),
                         "estimated": True, "base": _split_size(norm(e["name"]))[0],
                         "size": _split_size(norm(e["name"]))[1]}
                    key = norm(e["name"])
                    if key and key not in self.exact:
                        self.exact[key] = e
                continue
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            for e in data:
                key = norm(e["name"])
                if not key:
                    continue
                # MCP numbers win on conflicts (closer to today's menu); official
                # fills gaps and contributes portion weight.
                if key in self.exact:
                    cur = self.exact[key]
                    if not cur.get("weight_g") and e.get("weight_g"):
                        cur["weight_g"] = e["weight_g"]
                else:
                    self.exact[key] = e
                base = e.get("base") or _split_size(key)[0]
                size = e.get("size") or _split_size(key)[1]
                if size:
                    self.by_base.setdefault(norm(base), {}).setdefault(norm(size), e)

    def resolve(self, name: str) -> dict | None:
        key0 = norm(name)
        for alias, (target, _mult) in ALIASES.items():
            if key0 == norm(alias):
                hit = self.resolve(target)
                if hit:
                    return hit
                break
        n = key0
        if not n:
            return None
        keys = [n]
        for pref in ("麦咖啡", "麦当劳", "麦记", "mccafe"):
            if n.startswith(pref) and len(n) > len(pref):
                keys.append(n[len(pref):])
        for key in keys:
            hit = self.exact.get(key)
            if hit:
                return hit
        n = keys[-1]

        base, size = _split_size(n)
        sizes = self.by_base.get(base)
        if not sizes and not re.match(r"[冰热]", base):
            for alt in (f"热{base}", f"冰{base}"):
                hit = self.exact.get(alt) or self.by_base.get(alt, {}).get(size or "中")
                if hit:
                    return hit
            for alt in (f"热{base}", f"冰{base}"):
                alt_sizes = self.by_base.get(alt)
                if alt_sizes:
                    sizes = alt_sizes
                    break
        if sizes:
            if size and size in sizes:
                return sizes[size]
            for pref in ("中", "默认", "小", "大", "迷你"):
                if pref in sizes:
                    return sizes[pref]
            return next(iter(sizes.values()))

        best, best_score = None, 0.0
        for key, e in self.exact.items():
            if abs(len(key) - len(n)) > 4:
                continue
            score = SequenceMatcher(None, n, key).ratio()
            if score > best_score:
                best, best_score = e, score
        return best if best_score >= 0.9 else None


_DB: NutritionDB | None = None


def db() -> NutritionDB:
    global _DB
    if _DB is None:
        _DB = NutritionDB()
    return _DB


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "refresh":
        o, m = refresh()
        print(f"official entries: {o}, mcp entries: {m}")
    else:
        d = db()
        print(f"indexed names: {len(d.exact)}, size variants: {sum(len(v) for v in d.by_base.values())}")
        for probe in sys.argv[1:]:
            print(probe, "->", d.resolve(probe))
