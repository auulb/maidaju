"""Three-way meal planner for a group order.

Given a product catalog (see catalog.py) and group constraints, searches three
baskets that each optimise a different goal:

  variety  "多元体验"  – as many different items / food groups as possible
  fitness  "健身活力"  – most protein, least fat/carb/energy, sugar-free drinks
  energy   "能量满格"  – most total energy within the budget

The search is a deterministic greedy seed + simulated annealing + hill-climb
polish. It is a heuristic: plans are "good", not proven optimal. Every plan is
re-checked against the hard constraints before being returned.
"""

from __future__ import annotations

import math
import random
import re
from collections import Counter
from dataclasses import dataclass, field

PROFILES = {
    "variety": {"label": "多元体验", "tagline": "花同样的钱，吃最多种类"},
    "fitness": {"label": "健身活力", "tagline": "蛋白质拉满，少油少糖少热量"},
    "energy": {"label": "能量满格", "tagline": "同样预算，热量与满足感最高"},
}

PROTEIN_KEYWORDS = {
    "beef": ["牛", "安格斯", "巨无霸", "吉士汉堡", "不素之霸", "汉堡包"],
    "pork": ["猪", "培根", "火腿"],
    "seafood": ["鱼", "鳕", "虾", "蟹"],
    "chicken": ["鸡"],
}
VEG_HINTS = ["玉米", "薯条", "苹果", "派", "新地", "麦旋风", "圆筒", "冰淇淋", "蔬菜", "沙拉",
             "咖啡", "美式", "拿铁", "奶铁", "茶", "可乐", "雪碧", "纯悦", "怡泉", "果汁", "豆浆",
             "牛奶", "芝士条", "薯饼", "油条", "拉明顿", "阿芙佳朵", "雪冰", "燕麦"]


@dataclass
class Constraints:
    people: int
    budget: float
    no_spicy: int = 0
    no_sugar: int = 0
    no_beef: int = 0
    no_pork: int = 0
    no_seafood: int = 0
    veg: int = 0
    min_kcal_per_person: float = 500
    max_sodium_per_person: float = 2600
    include_breakfast: bool = True
    exclude: list[str] = field(default_factory=list)
    # Per-member restriction sets (e.g. {"spicy","beef"}). Empty = aggregate only.
    member_profiles: list[frozenset] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.people = max(1, int(self.people))
        for k in ("no_spicy", "no_sugar", "no_beef", "no_pork", "no_seafood", "veg"):
            setattr(self, k, max(0, min(int(getattr(self, k)), self.people)))


def protein_kinds(name: str) -> set[str]:
    kinds = {k for k, kws in PROTEIN_KEYWORDS.items() if any(w in name for w in kws)}
    if not kinds and any(w in name for w in VEG_HINTS):
        kinds = {"veg"}
    return kinds


class Basket:
    __slots__ = ("counts", "cost", "kcal", "protein", "fat", "carb", "sodium",
                 "roles", "groups", "spicy_mains", "veg_mains", "beef_mains",
                 "pork_mains", "seafood_mains", "sweet", "sf", "est", "est_cost",
                 "qty", "dessert_ids")

    def __init__(self) -> None:
        self.counts: Counter[str] = Counter()
        self.cost = self.kcal = self.protein = self.fat = self.carb = self.sodium = 0.0
        self.roles: Counter[str] = Counter()
        self.groups: Counter[str] = Counter()
        self.spicy_mains = self.veg_mains = 0
        self.beef_mains = self.pork_mains = self.seafood_mains = 0
        self.sweet = self.sf = self.est = self.est_cost = self.qty = 0
        self.dessert_ids: set[str] = set()

    def copy(self) -> "Basket":
        b = Basket()
        b.counts = Counter(self.counts)
        b.roles = Counter(self.roles)
        b.groups = Counter(self.groups)
        b.dessert_ids = set(self.dessert_ids)
        for k in ("cost", "kcal", "protein", "fat", "carb", "sodium", "spicy_mains",
                  "veg_mains", "beef_mains", "pork_mains", "seafood_mains", "sweet",
                  "sf", "est", "est_cost", "qty"):
            setattr(b, k, getattr(self, k))
        return b

    def add(self, p: dict, sign: int = 1) -> None:
        q = sign
        pid = p["id"]
        self.counts[pid] += q
        if self.counts[pid] <= 0:
            del self.counts[pid]
        self.cost += p["price"] * q
        self.kcal += p["totals"]["kcal"] * q
        self.protein += p["totals"]["protein"] * q
        self.fat += p["totals"]["fat"] * q
        self.carb += p["totals"]["carb"] * q
        self.sodium += p["totals"]["sodium"] * q
        self.qty += q
        for role, n in p["roles"].items():
            if n:
                self.roles[role] += n * q
        for g in p["groups"]:
            self.groups[g] += q
            if self.groups[g] <= 0:
                del self.groups[g]
        mains = p["roles"]["main"] * q
        if mains:
            if p["spicy"]:
                self.spicy_mains += mains
            for part in p["parts"]:
                if part["role"] != "main":
                    continue
                kinds = protein_kinds(part["name"])
                if "beef" in kinds:
                    self.beef_mains += part["qty"] * q
                if "pork" in kinds:
                    self.pork_mains += part["qty"] * q
                if "seafood" in kinds:
                    self.seafood_mains += part["qty"] * q
                if "veg" in kinds:
                    self.veg_mains += part["qty"] * q
        self.sweet += p["sweet_drink"] * q
        self.sf += (p["roles"]["drink"] if p["sugar_free"] else 0) * q
        self.est += (1 if p["estimated"] else 0) * q
        if p["estimated"]:
            self.est_cost += p["price"] * q
        if p["roles"]["dessert"]:
            if self.counts.get(pid, 0) > 0:
                self.dessert_ids.add(pid)
            else:
                self.dessert_ids.discard(pid)

    @property
    def distinct(self) -> int:
        return len(self.counts)

    @property
    def distinct_groups(self) -> int:
        return len(self.groups)

    @property
    def dessert_kinds(self) -> int:
        return len(self.dessert_ids)


_BY_ID: dict[str, dict] = {}


def _objective(b: Basket, kind: str, c: Constraints) -> float:
    n = c.people
    if kind == "variety":
        score = 60 * b.distinct + 14 * b.distinct_groups + 3.0 * b.qty + 6 * b.dessert_kinds
        score -= 10.0 * max(0, b.qty - b.distinct)  # duplicates are the enemy of choice
        return score - 0.4 * max(0.0, b.kcal - 820 * n)
    if kind == "fitness":
        score = (9.0 * b.protein - 1.6 * b.fat - 1.0 * b.carb
                 + 4.0 * b.sf + 2.0 * b.veg_mains + 12.0 * b.distinct
                 + 3.0 * b.distinct_groups + 1.5 * b.qty)
        score -= 0.6 * max(0.0, b.kcal - 700 * n)
        score -= 2.5 * max(0.0, b.fat - 28 * n)
        score -= 0.3 * max(0.0, b.sodium - 2000 * n)
        return score
    score = (1.0 * b.kcal + 3.0 * b.protein + 8.0 * b.distinct
             + 10.0 * b.distinct_groups + 1.0 * b.qty)
    return score - 1.5 * max(0.0, b.kcal - 1000 * n)


def _penalty(b: Basket, c: Constraints) -> float:
    p = 0.0
    n = c.people
    if b.cost > c.budget:
        p += 20000.0 * (b.cost - c.budget)
    floor = c.budget * 0.88
    if b.cost < floor:
        p += 250.0 * (floor - b.cost)

    if b.roles["main"] < n:
        p += 6000.0 * (n - b.roles["main"])
    if b.roles["drink"] < n:
        p += 3500.0 * (n - b.roles["drink"])

    need_kcal = n * c.min_kcal_per_person
    if b.kcal < need_kcal:
        p += 10.0 * (need_kcal - b.kcal)
    over_sodium = b.sodium - n * c.max_sodium_per_person
    if over_sodium > 0:
        p += 0.8 * over_sodium

    if b.spicy_mains > n - c.no_spicy:
        p += 6000.0 * (b.spicy_mains - (n - c.no_spicy))
    if c.no_sugar and b.sf < c.no_sugar:
        p += 6000.0 * (c.no_sugar - b.sf)
    if b.sweet > n - c.no_sugar:
        p += 5000.0 * (b.sweet - (n - c.no_sugar))
    if c.veg and b.veg_mains < c.veg:
        p += 6000.0 * (c.veg - b.veg_mains)
    if c.no_beef and b.beef_mains > n - c.no_beef:
        p += 5000.0 * (b.beef_mains - (n - c.no_beef))
    if c.no_pork and b.pork_mains > n - c.no_pork:
        p += 5000.0 * (b.pork_mains - (n - c.no_pork))
    if c.no_seafood and b.seafood_mains > n - c.no_seafood:
        p += 5000.0 * (b.seafood_mains - (n - c.no_seafood))

    dessert_cap = max(2, math.ceil(n / 3) + 1)
    if b.roles["dessert"] > dessert_cap:
        p += 500.0 * (b.roles["dessert"] - dessert_cap)
    p += 25.0 * b.est + 0.9 * b.est_cost
    return p


def _score(b: Basket, kind: str, c: Constraints) -> float:
    return _objective(b, kind, c) - _penalty(b, c)


def _code_count(b: Basket, p: dict) -> int:
    """Total portions of the same menu product (its variants share `code`)."""
    return sum(q for pid, q in b.counts.items() if _BY_ID[pid]["code"] == p["code"])


def _cap(p: dict, c: Constraints) -> int:
    if p["roles"]["main"]:
        # sharing combos are capped so a plan does not become 4 identical platters
        if p["roles"]["main"] > 1:
            return max(1, min(2, c.people // p["roles"]["main"]))
        return max(2, math.ceil(c.people / 2))
    if p["roles"]["drink"]:
        return c.people
    if p["roles"]["dessert"]:
        return max(2, math.ceil(c.people / 3))
    return max(2, math.ceil(c.people / 2))


def _greedy(pool: list[dict], c: Constraints, kind: str) -> Basket:
    """Value-per-yuan greedy. Cheap constraint-filling items come first, so the
    seed is normally feasible before it starts spending on 'nice to have'."""
    b = Basket()
    for _ in range(600):
        best, best_density = None, 1e-6
        before = _score(b, kind, c)
        for p in pool:
            if _code_count(b, p) >= _cap(p, c):
                continue
            if b.cost + p["price"] > c.budget * 1.002:
                continue
            b.add(p, 1)
            delta = _score(b, kind, c) - before
            b.add(p, -1)
            density = delta / max(p["price"], 0.5)
            if density > best_density:
                best, best_density = p, density
        if not best:
            break
        b.add(best, 1)
    return b


def _cheapest(pool: list[dict], role: str, b: Basket, c: Constraints) -> dict | None:
    rows = [p for p in pool if p["roles"][role] > 0 and _code_count(b, p) < _cap(p, c)]
    rows.sort(key=lambda p: p["price"] / max(p["roles"][role], 1))
    return rows[0] if rows else None


def _repair(pool: list[dict], c: Constraints, kind: str, b: Basket) -> Basket:
    """Make a basket satisfy the hard constraints, cheaply.

    Used after every annealing run so the returned plan is always feasible when
    the menu can satisfy it at all (see min_viable_cost).
    """
    b = b.copy()
    for _ in range(120):
        changed = False

        # 1) over budget -> drop the most expensive non-essential item
        while b.cost > c.budget + 1e-9 and b.counts:
            removable = sorted(
                ((pid, q) for pid, q in b.counts.items()
                 if b.roles["main"] > c.people or _BY_ID[pid]["roles"]["main"] == 0),
                key=lambda kv: -_BY_ID[kv[0]]["price"] * kv[1],
            )
            if not removable:
                removable = sorted(b.counts.items(), key=lambda kv: -_BY_ID[kv[0]]["price"])
            b.add(_BY_ID[removable[0][0]], -1)
            changed = True

        # 2) not enough mains / drinks
        for role in ("main", "drink"):
            while b.roles[role] < c.people:
                p = _cheapest(pool, role, b, c)
                if p is None:
                    break
                if b.cost + p["price"] <= c.budget:
                    b.add(p, 1)
                    changed = True
                    continue
                extra = sorted(
                    ((pid, q) for pid, q in b.counts.items()
                     if _BY_ID[pid]["roles"][role] == 0),
                    key=lambda kv: -_BY_ID[kv[0]]["price"],
                )
                if not extra:
                    break
                b.add(_BY_ID[extra[0][0]], -1)
                changed = True

        # 3) too many spicy mains -> swap for a non-spicy main
        guard = 0
        while b.spicy_mains > c.people - c.no_spicy and b.roles["main"] > 0 and guard < 20:
            guard += 1
            spicy_pid = next((pid for pid in b.counts if _BY_ID[pid]["spicy"]
                              and _BY_ID[pid]["roles"]["main"]), None)
            if spicy_pid is None:
                break
            b.add(_BY_ID[spicy_pid], -1)
            cands = [p for p in pool if p["roles"]["main"] and not p["spicy"]
                     and _code_count(b, p) < _cap(p, c)]
            cands.sort(key=lambda p: p["price"])
            pick = next((p for p in cands if b.cost + p["price"] <= c.budget), None)
            if pick is None:
                b.add(_BY_ID[spicy_pid], 1)
                break
            b.add(pick, 1)
            changed = True

        # 4) too many sugary drinks -> swap for a sugar-free drink
        guard = 0
        while c.no_sugar and b.sweet > c.people - c.no_sugar and guard < 20:
            guard += 1
            sweet_pid = next((pid for pid in b.counts
                              if _BY_ID[pid]["roles"]["drink"] and not _BY_ID[pid]["sugar_free"]), None)
            if sweet_pid is None:
                break
            b.add(_BY_ID[sweet_pid], -1)
            cands = [p for p in pool if p["sugar_free"] and p["roles"]["drink"]
                     and _code_count(b, p) < _cap(p, c)]
            cands.sort(key=lambda p: p["price"])
            pick = next((p for p in cands if b.cost + p["price"] <= c.budget), None)
            if pick is None:
                b.add(_BY_ID[sweet_pid], 1)
                break
            b.add(pick, 1)
            changed = True

        if not changed:
            break
    return b


def _anneal(pool: list[dict], c: Constraints, kind: str, seed_basket: Basket,
            iterations: int, seed: int) -> Basket:
    rng = random.Random(seed)
    cur = seed_basket.copy()
    best = cur.copy()
    cur_s = best_s = _score(cur, kind, c)
    t0 = max(40.0, abs(cur_s) * 0.03)
    t1 = 0.8
    for i in range(iterations):
        t = t0 * (t1 / t0) ** (i / iterations)
        move = rng.random()
        present = list(cur.counts)
        if move < 0.55 or not present:
            p = rng.choice(pool)
            if _code_count(cur, p) >= _cap(p, c) or cur.cost + p["price"] > c.budget * 1.01:
                continue
            cur.add(p, 1)
            s = _score(cur, kind, c)
            if s >= cur_s or rng.random() < math.exp((s - cur_s) / t):
                cur_s = s
            else:
                cur.add(p, -1)
        elif move < 0.8:
            pid = rng.choice(present)
            cur.add(_BY_ID[pid], -1)
            s = _score(cur, kind, c)
            if s >= cur_s or rng.random() < math.exp((s - cur_s) / t):
                cur_s = s
            else:
                cur.add(_BY_ID[pid], 1)
        else:
            pid = rng.choice(present)
            p2 = rng.choice(pool)
            if p2["id"] == pid or _code_count(cur, p2) >= _cap(p2, c):
                continue
            cur.add(_BY_ID[pid], -1)
            if cur.cost + p2["price"] > c.budget * 1.01:
                cur.add(_BY_ID[pid], 1)
                continue
            cur.add(p2, 1)
            s = _score(cur, kind, c)
            if s >= cur_s or rng.random() < math.exp((s - cur_s) / t):
                cur_s = s
            else:
                cur.add(p2, -1)
                cur.add(_BY_ID[pid], 1)
        if cur_s > best_s:
            best, best_s = cur.copy(), cur_s
    return best


def _polish(pool: list[dict], c: Constraints, kind: str, b: Basket) -> Basket:
    cur = b.copy()
    cur_s = _score(cur, kind, c)
    for _ in range(4):
        improved = False
        for pid in list(cur.counts):
            for p2 in pool:
                if p2["id"] == pid or _code_count(cur, p2) >= _cap(p2, c):
                    continue
                if cur.cost - _BY_ID[pid]["price"] + p2["price"] > c.budget:
                    continue
                cur.add(_BY_ID[pid], -1)
                cur.add(p2, 1)
                s = _score(cur, kind, c)
                if s > cur_s + 1e-9:
                    cur_s = s
                    improved = True
                    break
                cur.add(p2, -1)
                cur.add(_BY_ID[pid], 1)
            if improved:
                break
        if not improved:
            break
    return cur


def _main_portions(b: Basket) -> list[dict]:
    """Every main portion in the basket, with the facts needed to match people."""
    out: list[dict] = []
    for pid, q in b.counts.items():
        p = _BY_ID[pid]
        for part in p["parts"]:
            if part["role"] != "main":
                continue
            name = part["name"]
            for _ in range(int(part["qty"]) * q):
                out.append({
                    "name": name,
                    "spicy": bool(part.get("spicy", p["spicy"])),
                    "kinds": protein_kinds(name),
                })
    return out


def _profile_ok(part: dict, profile: frozenset) -> bool:
    if "spicy" in profile and part["spicy"]:
        return False
    if "veg" in profile and "veg" not in part["kinds"]:
        return False
    for kind in ("beef", "pork", "seafood"):
        if kind in profile and kind in part["kinds"]:
            return False
    return True


def _unmatched_members(portions: list[dict], profiles: list[frozenset]) -> list[int]:
    """Indices of members that cannot be matched to a distinct main portion."""
    eligible = {
        mi: [pi for pi, p in enumerate(portions) if _profile_ok(p, prof)]
        for mi, prof in enumerate(profiles)
    }
    order = sorted(range(len(profiles)), key=lambda mi: (len(eligible[mi]), mi))
    owner: dict[int, int] = {}

    def dfs(mi: int, seen: set[int]) -> bool:
        for pi in eligible[mi]:
            if pi in seen:
                continue
            seen.add(pi)
            if pi not in owner or dfs(owner[pi], seen):
                owner[pi] = mi
                return True
        return False

    for mi in order:
        dfs(mi, set())
    matched = set(owner.values())
    return [mi for mi in range(len(profiles)) if mi not in matched]


def _fix_member_mains(pool: list[dict], c: Constraints, b: Basket,
                      profiles: list[frozenset]) -> Basket:
    """Swap mains until every member profile has an edible main.

    Aggregate counts ("3 beef mains <= 3 people who avoid beef") are not enough:
    one person may avoid beef *and* seafood, which needs a main that satisfies
    the intersection. This runs once per finished plan, so it stays cheap; the
    annealing objective is untouched.
    """
    if not profiles:
        return b
    b = b.copy()
    for _ in range(len(profiles) + 2):
        portions = _main_portions(b)
        unmatched = _unmatched_members(portions, profiles)
        if not unmatched:
            break
        prof = profiles[unmatched[0]]
        adds = [p for p in pool
                if p["roles"]["main"] and _code_count(b, p) < _cap(p, c)
                and all(_profile_ok({
                    "name": part["name"],
                    "spicy": bool(part.get("spicy", p["spicy"])),
                    "kinds": protein_kinds(part["name"]),
                }, prof) for part in p["parts"] if part["role"] == "main")]
        adds.sort(key=lambda p: (p["price"], p["name"]))
        rems = [pid for pid in b.counts if _BY_ID[pid]["roles"]["main"]]
        rems.sort(key=lambda pid: (_BY_ID[pid]["spicy"], -_BY_ID[pid]["price"]))
        fixed = False
        for add in adds:
            for pid in rems:
                retry = False
                b.add(_BY_ID[pid], -1)
                b.add(add, 1)
                if b.cost > c.budget + 1e-9 or _violations(b, c):
                    b.add(add, -1)
                    b.add(_BY_ID[pid], 1)
                    continue
                new_unmatched = _unmatched_members(_main_portions(b), profiles)
                if len(new_unmatched) < len(unmatched):
                    fixed = True
                    break
                b.add(add, -1)
                b.add(_BY_ID[pid], 1)
            if fixed:
                break
        if not fixed:
            break
    return b


def _violations(b: Basket, c: Constraints) -> list[str]:
    out: list[str] = []
    if b.cost > c.budget + 0.001:
        out.append(f"超出预算 ¥{b.cost - c.budget:.1f}")
    if b.roles["main"] < c.people:
        out.append(f"主食不足 {b.roles['main']}/{c.people}")
    if b.roles["drink"] < c.people:
        out.append(f"饮品不足 {b.roles['drink']}/{c.people}")
    if b.spicy_mains > c.people - c.no_spicy:
        out.append(f"辣味主食 {b.spicy_mains} > {c.people - c.no_spicy}")
    if c.no_sugar and b.sf < c.no_sugar:
        out.append(f"无糖饮品 {b.sf}/{c.no_sugar}")
    if b.sweet > c.people - c.no_sugar:
        out.append(f"含糖饮品 {b.sweet} > {c.people - c.no_sugar}")
    if c.veg and b.veg_mains < c.veg:
        out.append(f"素食主食 {b.veg_mains}/{c.veg}")
    if c.no_beef and b.beef_mains > c.people - c.no_beef:
        out.append(f"牛肉主食 {b.beef_mains} > {c.people - c.no_beef}")
    if c.no_pork and b.pork_mains > c.people - c.no_pork:
        out.append(f"猪肉主食 {b.pork_mains} > {c.people - c.no_pork}")
    if c.no_seafood and b.seafood_mains > c.people - c.no_seafood:
        out.append(f"海鲜主食 {b.seafood_mains} > {c.people - c.no_seafood}")
    if b.kcal < c.people * c.min_kcal_per_person * 0.95:
        out.append(f"总热量偏低 {b.kcal:.0f} kcal")
    return out


def _summary(b: Basket, c: Constraints, kind: str) -> dict:
    items = []
    for pid in sorted(b.counts, key=lambda x: (-_BY_ID[x]["roles"]["main"], _BY_ID[x]["price"])):
        p = _BY_ID[pid]
        q = b.counts[pid]
        items.append({
            "name": p["name"],
            "code": p["code"],
            "qty": q,
            "unit_price": p.get("menu_price", p["price"]),
            "menu_price": p.get("menu_price", p["price"]),
            "paid_unit_price": p["price"],
            "discounted": bool(p.get("discounted")),
            "subtotal": round(p.get("menu_price", p["price"]) * q, 1),
            "paid_subtotal": round(p["price"] * q, 1),
            "kcal": p["totals"]["kcal"],
            "protein": p["totals"]["protein"],
            "fat": p["totals"]["fat"],
            "carb": p["totals"]["carb"],
            "sodium": p["totals"]["sodium"],
            "roles": p["roles"],
            "spicy": p["spicy"],
            "sugar_free": p["sugar_free"],
            "estimated": p["estimated"],
            "kind": p["kind"],
            "parts": p["parts"],
            "order": p["order"],
        })
    order_items = []
    for it in items:
        entry = dict(it["order"])
        entry["quantity"] = it["qty"]
        order_items.append(entry)
    tot = {k: round(getattr(b, k), 1) for k in ("kcal", "protein", "fat", "carb", "sodium")}
    groups = set()
    for pid in b.counts:
        groups.update(_BY_ID[pid]["groups"])
    return {
        "profile": kind,
        "label": PROFILES[kind]["label"],
        "tagline": PROFILES[kind]["tagline"],
        "items": items,
        "totals": tot,
        "per_person": {k: round(v / c.people, 1) for k, v in tot.items()},
        "cost": round(b.cost, 1),
        "subtotal": round(sum(it["subtotal"] for it in items), 1),
        "per_person_cost": round(b.cost / c.people, 1),
        "counts": {
            "mains": b.roles["main"], "drinks": b.roles["drink"],
            "sides": b.roles["side"], "desserts": b.roles["dessert"],
            "distinct_items": b.distinct, "spicy_mains": b.spicy_mains,
            "sugar_free_drinks": b.sf, "sweet_drinks": b.sweet,
            "estimated_items": b.est,
        },
        "groups": sorted(groups),
        "estimated_names": [it["name"] for it in items if it["estimated"]],
        "constraints": {k: getattr(c, k) for k in
                        ("people", "budget", "no_spicy", "no_sugar", "no_beef", "no_pork",
                         "no_seafood", "veg")},
        "violations": _violations(b, c),
        "order_items": order_items,
    }


def _min_cost(products: list[dict], c: Constraints) -> float | None:
    def cheapest(role: str, count: int, extra_filter=None) -> float | None:
        rows = [p for p in products
                if p["roles"][role] and (extra_filter(p) if extra_filter else True)]
        if not rows:
            return None
        rows.sort(key=lambda p: p["price"] / max(p["roles"][role], 1))
        picked, total = 0, 0.0
        for p in rows:
            take = min(_cap(p, c), count - picked)
            total += p["price"] * take
            picked += p["roles"][role] * take
            if picked >= count:
                break
        return total if picked >= count else None

    mains = cheapest("main", c.people)
    drinks = cheapest("drink", c.people)
    if mains is None or drinks is None:
        return None
    if c.no_sugar:
        sfd = cheapest("drink", c.no_sugar, lambda p: p["sugar_free"])
        sweet = cheapest("drink", c.people - c.no_sugar, lambda p: not p["sugar_free"])
        if sfd is not None and sweet is not None:
            drinks = sfd + sweet
    return round(mains + drinks, 1)


def solve(products: list[dict], c: Constraints, exclude: list[str] | None = None) -> dict:
    global _BY_ID
    ex = [e for e in (exclude or c.exclude) if e]

    def usable(p: dict) -> bool:
        if not any(p["roles"].values()):
            return False
        if p["price"] <= 0 or p["totals"]["kcal"] <= 0:
            return False
        if any(e in p["name"] for e in ex):
            return False
        if not c.include_breakfast and re.search(r"麦满分|粥|油条|薯饼", p["name"]):
            return False
        return True

    pool = [p for p in products if usable(p)]
    _BY_ID = {p["id"]: p for p in pool}

    plans = []
    for kind in PROFILES:
        seed = _repair(pool, c, kind, _greedy(pool, c, kind))
        best = seed
        best_s = _score(best, kind, c)
        for s in (7, 19, 41, 73):
            cand = _anneal(pool, c, kind, seed, iterations=50000, seed=s)
            cand = _repair(pool, c, kind, cand)
            cand = _polish(pool, c, kind, cand)
            cand = _repair(pool, c, kind, cand)
            s_score = _score(cand, kind, c)
            if not _violations(cand, c) and s_score > best_s:
                best, best_s = cand, s_score
        if c.member_profiles:
            best = _fix_member_mains(pool, c, best, c.member_profiles)
        plans.append(_summary(best, c, kind))

    return {
        "constraints": {k: getattr(c, k) for k in
                        ("people", "budget", "no_spicy", "no_sugar", "no_beef", "no_pork",
                         "no_seafood", "veg", "min_kcal_per_person", "max_sodium_per_person")},
        "min_viable_cost": _min_cost(pool, c),
        "plans": plans,
        "pool_size": len(pool),
    }


if __name__ == "__main__":  # quick smoke test on a cached catalog
    import json
    import os
    import sys

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "data", "cache", "catalog_1450713.json")
    with open(path, encoding="utf-8") as f:
        cat = json.load(f)
    res = solve(cat["products"], Constraints(people=8, budget=300, no_spicy=2, no_sugar=1))
    for plan in res["plans"]:
        print(f"== {plan['label']} ¥{plan['cost']} ({plan['per_person_cost']}/人) "
              f"{plan['totals']['kcal']} kcal 蛋白{plan['totals']['protein']}g")
        for it in plan["items"]:
            print(f"   {it['qty']}x {it['name']} ¥{it['unit_price']}"
                  f"{'  [估算]' if it['estimated'] else ''}")
        print("   violations:", plan["violations"])
