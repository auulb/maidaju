"""Assign a solved basket to named members (逐人餐盘).

The solver works on totals ("8 mains, 8 drinks"). This module takes one of its
plans and splits the actual portions between named people, so the output can
answer "小王到底拿到什么" instead of only "这桌一共点了什么".

Allocation rules
----------------
* Every member gets exactly one main portion that satisfies their own
  hard constraints, plus one drink (sugar-free when they asked for it).
* Matching is a real bipartite matching (Kuhn), so a no-spicy member cannot be
  starved by members who have no restrictions.
* Sides, desserts and any surplus stay in a shared pool. Its cost is split
  evenly, which is bookkeeping for this order only — not the store's per-head
  charge.
* An optional per-member budget is checked against (assigned + shared share).
  When it is exceeded we first try to swap in a cheaper main/drink; if that
  fails the conflict is reported instead of silently dropping the requirement.

Nothing here changes `order_items`: the tray is a view of the same purchase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import catalog
import solver

ROLE_ORDER = {"main": 0, "drink": 1, "side": 2, "dessert": 3}

SPICY_TAGS = {"no-spicy", "nospicy", "不吃辣", "免辣", "不要辣", "无辣"}
SUGAR_TAGS = {"no-sugar", "nosugar", "无糖", "不吃糖", "不要糖", "免糖"}
BEEF_TAGS = {"no-beef", "nobeef", "不吃牛", "不吃牛肉", "牛肉"}
PORK_TAGS = {"no-pork", "nopork", "不吃猪", "不吃猪肉", "猪肉"}
SEAFOOD_TAGS = {"no-seafood", "noseafood", "不吃海鲜", "海鲜"}
VEG_TAGS = {"veg", "vegetarian", "素食", "吃素", "不吃肉"}


class MemberSpecError(ValueError):
    pass


@dataclass
class Member:
    name: str
    no_spicy: bool = False
    no_sugar: bool = False
    no_beef: bool = False
    no_pork: bool = False
    no_seafood: bool = False
    veg: bool = False
    budget: float | None = None

    @property
    def flags(self) -> list[str]:
        out = []
        for label, on in (("不吃辣", self.no_spicy), ("无糖", self.no_sugar),
                          ("不吃牛肉", self.no_beef), ("不吃猪肉", self.no_pork),
                          ("不吃海鲜", self.no_seafood), ("素食", self.veg)):
            if on:
                out.append(label)
        return out


def _parse_budget(token: str) -> float:
    m = re.search(r"(\d+(?:\.\d+)?)", token)
    if not m:
        raise MemberSpecError(f"预算格式不对：{token!r}（示例：budget=35 或 预算=35）")
    return round(float(m.group(1)), 2)


def parse_members(specs: list[str]) -> list[Member]:
    """Parse repeatable `--member` values.

    Accepted shapes: ``小王``, ``小王:no-spicy,no-sugar``,
    ``小王:不吃辣,预算=35``, ``小李:budget=30``.
    """
    members: list[Member] = []
    seen: set[str] = set()
    for spec in specs:
        raw = (spec or "").strip()
        if not raw:
            continue
        name, sep, tail = raw.partition(":")
        name = name.strip()
        if not name:
            raise MemberSpecError(f"成员名不能为空：{raw!r}")
        if name in seen:
            raise MemberSpecError(f"成员重名：{name}（每人一个成员名，便于对上餐盘）")
        seen.add(name)
        m = Member(name=name)
        tags = [t.strip() for t in re.split(r"[,，;；、\s]+", tail)] if sep else []
        for tag in tags:
            if not tag:
                continue
            low = tag.lower()
            if low in SPICY_TAGS:
                m.no_spicy = True
            elif low in SUGAR_TAGS:
                m.no_sugar = True
            elif low in BEEF_TAGS:
                m.no_beef = True
            elif low in PORK_TAGS:
                m.no_pork = True
            elif low in SEAFOOD_TAGS:
                m.no_seafood = True
            elif low in VEG_TAGS:
                m.veg = True
            elif low.startswith(("budget", "预算", "上限", "cap")):
                m.budget = _parse_budget(tag)
            else:
                raise MemberSpecError(
                    f"看不懂成员 {name} 的标签 {tag!r}；"
                    "可用：no-spicy/不吃辣, no-sugar/无糖, no-beef, no-pork, "
                    "no-seafood, veg/素食, budget=35/预算=35"
                )
        members.append(m)
    return members


def profile_of(m: Member) -> frozenset:
    """Restriction set used by the solver to keep mains assignable."""
    s = set()
    if m.no_spicy:
        s.add("spicy")
    if m.no_beef:
        s.add("beef")
    if m.no_pork:
        s.add("pork")
    if m.no_seafood:
        s.add("seafood")
    if m.veg:
        s.add("veg")
    return frozenset(s)


def member_constraints(members: list[Member]) -> dict:
    return {
        "people": len(members),
        "no_spicy": sum(1 for m in members if m.no_spicy),
        "no_sugar": sum(1 for m in members if m.no_sugar),
        "no_beef": sum(1 for m in members if m.no_beef),
        "no_pork": sum(1 for m in members if m.no_pork),
        "no_seafood": sum(1 for m in members if m.no_seafood),
        "veg": sum(1 for m in members if m.veg),
    }


# --------------------------------------------------------------- portions


def _portions(plan: dict) -> list[dict]:
    """Explode a plan into single portions, each carrying a price share."""
    flags = catalog.load_flags()
    out: list[dict] = []
    for item in plan["items"]:
        parts = [p for p in (item.get("parts") or [])
                 if p.get("role") in ROLE_ORDER and int(p.get("qty") or 0) > 0]
        total = sum(int(p["qty"]) for p in parts)
        for unit in range(int(item["qty"])):
            if total <= 0:
                # Nothing assignable (e.g. a pure sauce bundle): keep it shared.
                out.append({
                    "role": "other", "name": item["name"], "share": item["unit_price"],
                    "spicy": False, "sugar_free": False, "kinds": set(),
                    "item": item["name"], "estimated": item["estimated"],
                })
                continue
            share = item["unit_price"] / total
            for part in parts:
                name = part["name"]
                for _ in range(int(part["qty"])):
                    out.append({
                        "role": part["role"],
                        "name": name,
                        "share": share,
                        "spicy": catalog.is_spicy(name, flags),
                        "sugar_free": catalog.is_sugarfree(name, flags),
                        "kinds": solver.protein_kinds(name),
                        "item": item["name"],
                        "estimated": item["estimated"],
                    })
    return out


def _main_ok(m: Member, p: dict) -> bool:
    if p["role"] != "main":
        return False
    if m.no_spicy and p["spicy"]:
        return False
    kinds = p["kinds"]
    if m.no_beef and "beef" in kinds:
        return False
    if m.no_pork and "pork" in kinds:
        return False
    if m.no_seafood and "seafood" in kinds:
        return False
    if m.veg and "veg" not in kinds:
        return False
    return True


def _drink_ok(m: Member, p: dict) -> bool:
    return p["role"] == "drink" and (not m.no_sugar or p["sugar_free"])


def _match(members: list[Member], portions: list[dict], ok, pool: list[int]) -> dict[int, int]:
    """Maximum bipartite matching member -> portion (Kuhn's algorithm)."""
    eligible: dict[int, list[int]] = {}
    for mi, m in enumerate(members):
        eligible[mi] = [pi for pi in pool if ok(m, portions[pi])]
    # the most restricted members pick first; DFS can still reassign them
    order = sorted(range(len(members)), key=lambda mi: (len(eligible[mi]), mi))
    owner: dict[int, int] = {}

    def dfs(mi: int, seen: set[int]) -> bool:
        for pi in sorted(eligible[mi], key=lambda i: (portions[i]["share"], i)):
            if pi in seen:
                continue
            seen.add(pi)
            if pi not in owner or dfs(owner[pi], seen):
                owner[pi] = mi
                return True
        return False

    for mi in order:
        dfs(mi, set())
    return {mi: pi for pi, mi in owner.items()}


def _pair_drinks(members: list[Member], portions: list[dict],
                 main_map: dict[int, int], drink_map: dict[int, int]) -> dict[int, int]:
    """Prefer the drink that ships inside the same combo as the member's main.

    Portions are matched independently (a combo can be split), which is
    sometimes the only feasible allocation, but a tray reads much better when
    the burger and the drink come from the same purchased unit. Swapping drinks
    afterwards keeps the matching size and all per-member constraints intact.
    """
    owner_of = {pi: mi for mi, pi in drink_map.items()}
    for mi, main_i in main_map.items():
        d_i = drink_map.get(mi)
        if d_i is None:
            continue
        if portions[d_i]["item"] == portions[main_i]["item"]:
            continue
        m = members[mi]
        same = [pi for pi, p in enumerate(portions)
                if p["role"] == "drink" and p["item"] == portions[main_i]["item"]
                and _drink_ok(m, p)]
        for pi in same:
            if pi == d_i:
                break
            owner = owner_of.get(pi)
            if owner is None:
                drink_map[mi] = pi
                owner_of[pi] = mi
                owner_of.pop(d_i, None)
                break
            other = members[owner]
            if _drink_ok(other, portions[d_i]):
                drink_map[mi], drink_map[owner] = pi, d_i
                owner_of[pi], owner_of[d_i] = mi, owner
                break
    return drink_map


# --------------------------------------------------------------- assignment


def assign(plan: dict, members: list[Member], order_adjustment: float = 0.0) -> dict:
    """Split a plan over named members.

    ``order_adjustment`` is the order-level difference between what the store
    charges and the sticker subtotal (fees minus promo discount). It is shared
    evenly, like any other shared cost — it is bookkeeping, not a real
    per-person surcharge.
    """
    if not members:
        return {"members": [], "shared": [], "conflicts": [], "coverage": {}}

    portions = _portions(plan)
    n = len(members)
    extra_per_head = order_adjustment / n if n else 0.0
    main_map = _match(members, portions, _main_ok, list(range(len(portions))))
    drink_pool = [i for i, p in enumerate(portions) if p["role"] == "drink"]
    drink_map = _match(members, portions, _drink_ok, drink_pool)
    drink_map = _pair_drinks(members, portions, main_map, drink_map)

    taken = set(main_map.values()) | set(drink_map.values())
    shared_idx = [i for i in range(len(portions)) if i not in taken]
    shared_cost = sum(portions[i]["share"] for i in shared_idx)
    shared_share = shared_cost / n if n else 0.0

    conflicts: list[str] = []
    rows: list[dict] = []
    for mi, m in enumerate(members):
        main_p = portions[main_map[mi]] if mi in main_map else None
        drink_p = portions[drink_map[mi]] if mi in drink_map else None
        if main_p is None:
            conflicts.append(f"{m.name} 没有符合忌口（{'/'.join(m.flags) or '无'}）的主食")
        if drink_p is None:
            if m.no_sugar:
                conflicts.append(f"{m.name} 需要无糖饮品，但方案里的无糖饮品已经分完")
            else:
                conflicts.append(f"{m.name} 没有分到饮品")
        assigned = (main_p["share"] if main_p else 0.0) + (drink_p["share"] if drink_p else 0.0)
        rows.append({
            "name": m.name,
            "flags": m.flags,
            "main": _brief(main_p),
            "drink": _brief(drink_p),
            "assigned_cost": round(assigned, 2),
            "shared_share": round(shared_share, 2),
            "order_share": round(extra_per_head, 2),
            "total_cost": round(assigned + shared_share + extra_per_head, 2),
            "budget": m.budget,
            "over_budget": 0.0,
        })

    # Per-member budget repair: swap in a cheaper unused main/drink when possible.
    for _ in range(3):
        rows, main_map, drink_map = _repair_budgets(
            rows, members, portions, main_map, drink_map, extra_per_head)
        if not any(r["over_budget"] > 0.05 for r in rows):
            break

    # Recompute shared after swaps (swaps only exchange assigned portions).
    taken = set(main_map.values()) | set(drink_map.values())
    shared_idx = [i for i in range(len(portions)) if i not in taken]
    shared_cost = sum(portions[i]["share"] for i in shared_idx)
    shared_share = shared_cost / n if n else 0.0
    for r in rows:
        r["shared_share"] = round(shared_share, 2)
        r["total_cost"] = round(r["assigned_cost"] + shared_share + extra_per_head, 2)
        r["over_budget"] = round(max(0.0, r["total_cost"] - r["budget"]), 2) if r["budget"] else 0.0
    for r in rows:
        if r["over_budget"] > 0.05:
            conflicts.append(
                f"{r['name']} 个人预算 ¥{r['budget']:.0f} 不够：分摊 ¥{r['total_cost']:.1f}"
                f"（超 ¥{r['over_budget']:.1f}），可加个人预算或去掉部分共享小食"
            )

    shared = _group_shared([portions[i] for i in shared_idx])
    covered_mains = sum(1 for r in rows if r["main"])
    covered_drinks = sum(1 for r in rows if r["drink"])
    return {
        "members": rows,
        "shared": shared,
        "conflicts": conflicts,
        "coverage": {"people": n, "mains": covered_mains, "drinks": covered_drinks},
        "allocated_total": round(sum(r["total_cost"] for r in rows), 2),
        "plan_cost": round(plan["cost"], 2),
    }


def _brief(p: dict | None) -> dict | None:
    if p is None:
        return None
    return {
        "name": p["name"],
        "spicy": p["spicy"],
        "sugar_free": p["sugar_free"],
        "kinds": sorted(p["kinds"]),
        "share": round(p["share"], 2),
        "from_item": p["item"],
    }


def _repair_budgets(rows, members, portions, main_map, drink_map, extra_per_head=0.0):
    """Bring over-budget members back under their cap without breaking constraints.

    Two moves are tried, cheapest first:
    * swap a main/drink with a cheaper one already assigned to another member
      (the other member must be able to eat/drink the expensive one);
    * swap with an unused cheaper portion, which shifts the difference into the
      shared pool — only when that does not push anybody else over budget.
    Shared cost is constant for the first move and changes for the second, so
    both effects are simulated before committing.
    """
    n = max(len(members), 1)
    used = set(main_map.values()) | set(drink_map.values())
    shared_share = sum(p["share"] for i, p in enumerate(portions) if i not in used) / n
    row_of = {r["name"]: r for r in rows}
    idx_of = {id(m): mi for mi, m in enumerate(members)}

    def total(r: dict, shared: float = shared_share) -> float:
        return r["assigned_cost"] + shared + extra_per_head

    for _ in range(4):
        over = [m for m in members if m.budget and total(row_of[m.name]) > m.budget + 0.05]
        if not over:
            break
        worst = max(over, key=lambda m: total(row_of[m.name]) - m.budget)
        mi = idx_of[id(worst)]
        row = row_of[worst.name]
        owner_of = {pi: mj for mj, pi in main_map.items()}
        owner_of.update({pi: mj for mj, pi in drink_map.items()})
        improved = False

        for role, mapping, ok in (("main", main_map, _main_ok), ("drink", drink_map, _drink_ok)):
            cur = mapping.get(mi)
            if cur is None:
                continue
            cur_share = portions[cur]["share"]
            best, best_owner = None, None
            for pi, p in enumerate(portions):
                if p["role"] != role or p["share"] >= cur_share - 0.05:
                    continue
                if not ok(worst, p):
                    continue
                owner = owner_of.get(pi)
                if owner == mi:
                    continue
                if owner is not None:
                    other = members[owner]
                    if not ok(other, portions[cur]):
                        continue
                    other_row = row_of[other.name]
                    if (other.budget
                            and total(other_row) - p["share"] + cur_share > other.budget + 0.05):
                        continue
                else:
                    delta_shared = (cur_share - p["share"]) / n
                    if any(m2.budget and m2 is not worst
                           and total(row_of[m2.name], shared_share + delta_shared) > m2.budget + 0.05
                           for m2 in members):
                        continue
                if best is None or p["share"] < portions[best]["share"]:
                    best, best_owner = pi, owner

            if best is None:
                continue

            if best_owner is not None:
                other_row = row_of[members[best_owner].name]
                mapping[best_owner] = cur
                other_row["assigned_cost"] = round(
                    other_row["assigned_cost"] - portions[best]["share"] + cur_share, 2)
                other_row[role] = _brief(portions[cur])
                mapping[mi] = best
                row["assigned_cost"] = round(row["assigned_cost"] - cur_share + portions[best]["share"], 2)
            else:
                # Move the expensive portion into the shared pool and take the
                # cheaper one; shared_share changes, so recompute it.
                mapping[mi] = best
                row["assigned_cost"] = round(row["assigned_cost"] - cur_share + portions[best]["share"], 2)
                used = set(main_map.values()) | set(drink_map.values())
                shared_share = sum(p["share"] for i, p in enumerate(portions) if i not in used) / n
            row[role] = _brief(portions[best])
            improved = True
            break

        if not improved:
            break
    return rows, main_map, drink_map


def _group_shared(portions: list[dict]) -> list[dict]:
    grouped: dict[tuple, dict] = {}
    for p in portions:
        key = (p["name"], p["spicy"], p["sugar_free"])
        g = grouped.get(key)
        if g is None:
            g = {
                "name": p["name"],
                "qty": 0,
                "spicy": p["spicy"],
                "sugar_free": p["sugar_free"],
                "cost": 0.0,
                "roles": set(),
            }
            grouped[key] = g
        g["qty"] += 1
        g["cost"] = round(g["cost"] + p["share"], 2)
        g["roles"].add(p["role"])
    out = list(grouped.values())
    for g in out:
        g["roles"] = sorted(g["roles"], key=lambda r: ROLE_ORDER.get(r, 9))
    out.sort(key=lambda g: (ROLE_ORDER.get(g["roles"][0], 9), g["name"]))
    return out


if __name__ == "__main__":  # smoke test against a cached catalog + plan
    import json
    import os

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(here, "data", "cache", "catalog_1450713.json"), encoding="utf-8") as f:
        products = json.load(f)["products"]
    ms = parse_members(["小王:no-spicy,budget=40", "小李:no-sugar,budget=40",
                        "小张", "小赵", "小钱", "小孙"])
    c = solver.Constraints(people=6, budget=220, no_spicy=1, no_sugar=1)
    res = solver.solve(products, c)
    for plan in res["plans"]:
        tr = assign(plan, ms)
        print(f"== {plan['label']} ¥{plan['cost']} trays={tr['coverage']}")
        for r in tr["members"]:
            print(f"   {r['name']:<4} | {r['main']['name'] if r['main'] else '-':<16}"
                  f" | {r['drink']['name'] if r['drink'] else '-':<18} | ¥{r['total_cost']}")
        print("   shared:", ", ".join(f"{g['name']}x{g['qty']}" for g in tr["shared"]))
        print("   conflicts:", tr["conflicts"])
