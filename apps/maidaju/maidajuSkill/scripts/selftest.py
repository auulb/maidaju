#!/usr/bin/env python3
"""Invariant checks for the planner (no network needed).

Runs the solver against the cached catalog and asserts that every plan really
honours the hard constraints, spends the budget, and that the three profiles
stay meaningfully different. Exit code 1 on the first failed scenario.

    python3 selftest.py [catalog.json]
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))

import pricing  # noqa: E402
import solver  # noqa: E402
import trays  # noqa: E402

SCENARIOS = [
    dict(people=8, budget=300, no_spicy=2, no_sugar=1),
    dict(people=4, budget=150, no_spicy=0, no_sugar=0),
    dict(people=10, budget=500, no_spicy=10, no_sugar=3),
    dict(people=6, budget=220, no_spicy=3, no_sugar=2),
]


def density(plan: dict) -> float:
    return plan["totals"]["protein"] / max(plan["totals"]["kcal"], 1) * 1000


def check(products: list[dict], case: dict) -> None:
    c = solver.Constraints(**case)
    res = solver.solve(products, c)
    assert len(res["plans"]) == 3, "expected three plans"
    by = {p["profile"]: p for p in res["plans"]}

    for p in res["plans"]:
        tag = f"{case} / {p['label']}"
        assert not p["violations"], f"{tag}: {p['violations']}"
        assert p["cost"] <= c.budget + 0.05, f"{tag}: over budget {p['cost']}"
        assert p["counts"]["mains"] >= c.people, f"{tag}: too few mains"
        assert p["counts"]["drinks"] >= c.people, f"{tag}: too few drinks"
        assert p["counts"]["spicy_mains"] <= c.people - c.no_spicy, f"{tag}: spicy"
        assert p["counts"]["sugar_free_drinks"] >= c.no_sugar, f"{tag}: no sugar-free"
        assert p["counts"]["sweet_drinks"] <= c.people - c.no_sugar, f"{tag}: too sweet"
        total_items = sum(it["qty"] for it in p["items"])
        assert total_items >= c.people, f"{tag}: fewer items than people"
        # order payload must be usable by calculate-price
        for oi in p["order_items"]:
            assert oi["productCode"] and oi["quantity"] >= 1, f"{tag}: bad order payload"

    if res["min_viable_cost"] is not None and c.budget >= res["min_viable_cost"]:
        assert by["variety"]["cost"] >= c.budget * 0.85, "variety leaves too much budget unused"

    assert by["energy"]["totals"]["kcal"] >= by["variety"]["totals"]["kcal"] * 0.98, \
        f"energy plan is not the most caloric: {by['energy']['totals']['kcal']} vs {by['variety']['totals']['kcal']}"
    assert density(by["fitness"]) > density(by["variety"]), "fitness is not protein-dense"
    assert density(by["fitness"]) > density(by["energy"]), "fitness is not protein-dense"
    assert by["variety"]["counts"]["distinct_items"] >= by["fitness"]["counts"]["distinct_items"], \
        "variety is not the most varied"
    print(f"ok  {case}  energy={by['energy']['totals']['kcal']:.0f}kcal "
          f"fitness={density(by['fitness']):.0f}g/1000kcal "
          f"variety={by['variety']['counts']['distinct_items']} items")


TRAY_SCENARIOS = [
    (
        ["小王:no-spicy,budget=40", "小李:no-spicy,budget=40", "小张:no-sugar,budget=40",
         "小赵:budget=40", "小钱:budget=40", "小孙:budget=40", "小周:budget=40", "小吴:budget=40"],
        dict(people=8, budget=300, no_spicy=2, no_sugar=1),
    ),
    (
        ["阿明:no-spicy,budget=25", "阿华:no-spicy,budget=25", "阿强:no-sugar,budget=25",
         "阿珍:budget=25", "阿伟:budget=25", "阿芳:budget=25"],
        dict(people=6, budget=150, no_spicy=2, no_sugar=1),
    ),
    (
        [f"同学{i}" + (":no-spicy,budget=55" if i < 10 else ":budget=55") for i in range(10)],
        dict(people=10, budget=500, no_spicy=10, no_sugar=0),
    ),
    (
        ["小王:no-spicy,no-sugar,budget=40", "小李:no-beef,no-pork,no-seafood,budget=40",
         "小张:budget=40", "小赵:budget=40"],
        dict(people=4, budget=160, no_spicy=1, no_sugar=1,
             no_beef=1, no_pork=1, no_seafood=1),
    ),
]


def check_trays(products: list[dict], specs: list[str], case: dict) -> None:
    members = trays.parse_members(specs)
    assert len(members) == case["people"], "member count mismatch"
    derived = trays.member_constraints(members)
    for key in ("no_spicy", "no_sugar", "no_beef", "no_pork", "no_seafood", "veg"):
        assert derived[key] == case.get(key, 0), f"member tags do not match {key}"
    c = solver.Constraints(**case, member_profiles=[trays.profile_of(m) for m in members])
    res = solver.solve(products, c)
    for plan in res["plans"]:
        tag = f"trays {case['people']}p / {plan['label']}"
        alloc = trays.assign(plan, members)
        assert alloc["coverage"]["mains"] == case["people"], f"{tag}: uncovered main"
        assert alloc["coverage"]["drinks"] == case["people"], f"{tag}: uncovered drink"
        assert abs(alloc["allocated_total"] - plan["cost"]) <= 0.5, \
            f"{tag}: allocation {alloc['allocated_total']} != plan {plan['cost']}"
        hard = [x for x in alloc["conflicts"]
                if ("没有符合忌口" in x or "没有分到饮品" in x or "需要无糖饮品" in x)]
        assert not hard, f"{tag}: {hard}"
        for row, m in zip(alloc["members"], members):
            assert row["name"] == m.name, f"{tag}: member order changed"
            assert row["main"] is not None, f"{tag}: {m.name} has no main"
            assert row["drink"] is not None, f"{tag}: {m.name} has no drink"
            if m.no_spicy:
                assert not row["main"]["spicy"], f"{tag}: {m.name} got a spicy main"
            if m.no_sugar:
                assert row["drink"]["sugar_free"], f"{tag}: {m.name} got a sugary drink"
            if m.veg:
                assert "veg" in row["main"]["kinds"], f"{tag}: {m.name} got a non-veg main"
            for kind, flag in (("beef", m.no_beef), ("pork", m.no_pork),
                               ("seafood", m.no_seafood)):
                if flag:
                    assert kind not in row["main"]["kinds"], f"{tag}: {m.name} got {kind}"
            if m.budget:
                assert row["over_budget"] <= 0.05 or any(
                    m.name in x for x in alloc["conflicts"]), f"{tag}: silent budget overrun"
    print(f"ok  trays {case['people']}p  {len(members)} members x 3 plans")


def check_pricing(products: list[dict]) -> None:
    """Promotion ladder + fee model, using a captured 团餐 rules snapshot."""
    fixture = os.path.join(HERE, "data", "fixtures", "promotions_3330310.json")
    with open(fixture, encoding="utf-8") as f:
        rules = json.load(f)
    tiers, excluded = pricing.parse_tiers(rules, "GMS001", "保鲜速达")
    assert [t.threshold for t in tiers] == [300, 500, 1000, 2000], [t.threshold for t in tiers]
    assert [round(t.factor, 2) for t in tiers] == [0.78, 0.74, 0.70, 0.66]
    assert excluded == {"521742", "521743", "521744",
                        "9900005482", "9900005483", "9900005484"}

    model = pricing.PriceModel(
        mode="catering", service_code="GMS001", service_name="保鲜速达",
        tiers=tuple(tiers), excluded_codes=frozenset(excluded),
        delivery_fee=6.0, packing_fee=6.0,
    )
    # budget 300 - 12 fees = 288 product budget -> target the 满300/78折 step
    tier = model.tier_for_budget(288)
    assert tier is not None and tier.threshold == 300, tier
    assert model.budget_for_tier(300, tier) == 288
    assert abs(model.quote_subtotal(300).total - (300 * 0.78 + 12)) < 0.01
    # a bigger basket can be cheaper: 500 beats 499 after the tier jump
    assert model.quote_subtotal(500).total < model.quote_subtotal(499).total
    # excluded products never get the discount
    assert model.quote([{"unit_price": 300, "qty": 1, "code": "521742"}]).discount == 0
    assert model.quote([{"unit_price": 300, "qty": 1, "code": "901600"}]).discount > 0
    # 满减 ladders are parsed too
    reduce_rules = [{
        "promotionType": "31", "ruleCategory": 40, "gmServiceCode": "GMS002",
        "promotionId": "x", "products": [],
        "ruleDetail": {"orderReduce": {"reduceInfo": [
            {"startDiscountPoint": "100", "reduceAmount": "20"}]}},
    }]
    rtiers, _ = pricing.parse_tiers(reduce_rules, "GMS002")
    assert len(rtiers) == 1 and rtiers[0].amount == 20
    rmodel = pricing.PriceModel(tiers=tuple(rtiers))
    assert abs(rmodel.quote_subtotal(120).total - (120 - 20)) < 0.01
    assert rmodel.quote_subtotal(120).as_dict()["discount_kind"] == "reduce"

    # scaling only touches eligible products and keeps the sticker price
    scaled = model.scale_products(products, tier)
    for orig, new in zip(products, scaled):
        assert new["menu_price"] == orig["price"]
        if orig["code"] in excluded:
            assert new["price"] == orig["price"]
        else:
            assert abs(new["price"] - orig["price"] * 0.78) < 0.011

    # end-to-end skip: solve against promo prices, then re-quote at sticker price
    scaled, solve_budget, _ = pricing.apply_model(products, model, 300)
    case = dict(people=8, budget=solve_budget, no_spicy=2)
    res = solver.solve(scaled, solver.Constraints(**case))
    for plan in res["plans"]:
        q = model.quote(plan["items"], 300)
        assert q.total <= 300 + 0.05, f"promo plan over budget: {q.total}"
        assert q.subtotal >= 300, f"promo plan did not use the discount: {q.subtotal}"
        assert q.discount > 0
    print(f"ok  pricing  4 tiers, 78折@300, excluded={len(excluded)}, "
          f"sticker={model.quote(res['plans'][0]['items'], 300).subtotal:.0f} for ¥300")

    # per-person trays must absorb the order-level discount/fee share
    members = trays.parse_members([f"同事{i}" for i in range(8)])
    for plan in res["plans"]:
        q = model.quote(plan["items"], 300)
        plan["cost"], plan["subtotal"] = q.total, q.subtotal
        alloc = trays.assign(plan, members, order_adjustment=q.total - q.subtotal)
        assert abs(alloc["allocated_total"] - q.total) <= 0.6, \
            f"tray total {alloc['allocated_total']} != payable {q.total}"
        assert abs(alloc["members"][0]["order_share"] - (q.total - q.subtotal) / 8) < 0.02
    print("ok  pricing/trays  discount shared evenly across members")


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        HERE, "data", "fixtures", "catalog_1450713.json")
    if not os.path.exists(path):
        path = os.path.join(HERE, "data", "cache", "catalog_1450713.json")
    if not os.path.exists(path):
        raise SystemExit(f"missing catalog snapshot {path}; run scripts/catalog.py <storeCode> first")
    with open(path, encoding="utf-8") as f:
        products = json.load(f)["products"]
    for case in SCENARIOS:
        check(products, case)
    check_pricing(products)
    for specs, case in TRAY_SCENARIOS:
        check_trays(products, specs, case)
    try:
        trays.parse_members(["小王:whatever"])
    except trays.MemberSpecError:
        pass
    else:
        raise AssertionError("unknown member tag should be rejected")
    print("all scenarios passed")


if __name__ == "__main__":
    main()
