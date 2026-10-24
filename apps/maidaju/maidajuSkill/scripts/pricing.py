"""Promotion- and fee-aware pricing for group orders.

McDonald's China prices a group order in several layers:

1. **menu subtotal** — what ``catalog.py`` records (sticker price).
2. **order promotion** — 团餐 满折 / 满减, keyed to a 助餐服务 (GMS001 保鲜速达,
   GMS002 专人分餐, GMS003 专人摆台). The tier depends on the subtotal, so a
   larger basket can be *cheaper* than a smaller one (¥499 at full price vs
   ¥500 × 0.74 = ¥370). Budgeting on sticker prices is therefore wrong.
3. **fees** — delivery + packing, 麦乐送 / 团餐 only.

``calculate-price`` is the source of truth. This module builds a *model* so the
solver can optimise against the real payable amount:

* 满折 ``payable = subtotal × factor`` → scale every eligible product price by
  ``factor`` and keep the same budget; the solver then spends "discounted yuan".
* 满减 ``payable = subtotal − amount`` → prices unchanged, budget enlarged by
  ``amount``.
* products listed as ``type=2`` (不包含) never get the discount, so their price
  is left unscaled.

``plan.py`` reconciles the model against live ``calculate-price`` when
``--verify`` is used, and reports the difference.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import mcd_api

DISCOUNT_TYPE = "33"
REDUCE_TYPE = "31"

DEFAULT_DELIVERY_FEE = 6.0
DEFAULT_PACKING_FEE = 9.0


def _f(value, default: float = 0.0) -> float:
    try:
        return float(str(value).replace("¥", "").strip())
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Tier:
    """One step of a promotion ladder."""

    threshold: float          # 满 ¥threshold
    factor: float             # 折扣系数 (0.74 = 74 折 / discount 26)
    amount: float             # 满减金额, 0 for 满折
    service_code: str = ""
    service_name: str = ""
    promotion_id: str = ""

    @property
    def label(self) -> str:
        if self.amount:
            return f"满 ¥{self.threshold:.0f} 减 ¥{self.amount:.0f}"
        return f"满 ¥{self.threshold:.0f} 打 {self.factor * 10:.1f} 折"

    def payable(self, subtotal: float) -> float:
        """Product payable before delivery/packing fees."""
        return round(max(0.0, subtotal * self.factor - self.amount), 2)

    def capacity(self, budget: float) -> float:
        """Largest menu subtotal whose payable fits ``budget``."""
        if self.factor <= 0:
            return 0.0
        return (budget + self.amount) / self.factor

    def feasible(self, budget: float) -> bool:
        return self.capacity(budget) + 1e-9 >= self.threshold


@dataclass(frozen=True)
class Quote:
    subtotal: float           # menu price of everything
    discount: float           # promo saving (>=0)
    product_payable: float    # subtotal - discount
    packing: float
    delivery: float
    total: float              # what the store charges
    tier: Tier | None = None
    tier_label: str = ""
    service_name: str = ""
    next_hint: str = ""       # "再点 ¥X 可到下一档"

    def as_dict(self) -> dict:
        return {
            "subtotal": round(self.subtotal, 2),
            "discount": round(self.discount, 2),
            "product_payable": round(self.product_payable, 2),
            "packing": round(self.packing, 2),
            "delivery": round(self.delivery, 2),
            "total": round(self.total, 2),
            "tier_label": self.tier_label,
            "service_name": self.service_name,
            "next_hint": self.next_hint,
            "discount_kind": ("reduce" if self.tier and self.tier.amount else
                              "discount" if self.tier else ""),
            "has_promotion": self.discount > 0.001,
        }


@dataclass
class PriceModel:
    mode: str = "store"                      # store | delivery | catering
    service_code: str = ""
    service_name: str = ""
    tiers: tuple[Tier, ...] = ()
    excluded_codes: frozenset[str] = frozenset()
    delivery_fee: float = 0.0
    packing_fee: float = 0.0
    source: str = "门店菜单价"
    notes: list[str] = field(default_factory=list)

    # ---------------------------------------------------------------- helpers

    @property
    def has_fees(self) -> bool:
        return self.delivery_fee + self.packing_fee > 0.001

    @property
    def has_promotion(self) -> bool:
        return bool(self.tiers)

    def fees(self) -> float:
        return round(self.delivery_fee + self.packing_fee, 2)

    def tier_for_subtotal(self, subtotal: float) -> Tier | None:
        """The tier the store actually applies: highest threshold reached."""
        reached = [t for t in self.tiers if subtotal + 1e-9 >= t.threshold]
        return max(reached, key=lambda t: (t.threshold, -t.factor), default=None)

    def tier_for_budget(self, budget: float) -> Tier | None:
        """Best tier we can aim at: most menu subtotal for the payable budget.

        A tier only counts if the *entry* subtotal is itself affordable.
        """
        usable = [t for t in self.tiers if t.feasible(budget)]
        if not usable:
            return None
        return max(usable, key=lambda t: (t.capacity(budget), -t.threshold))

    def scale_products(self, products: list[dict], tier: Tier | None) -> list[dict]:
        """Return copies of ``products`` whose ``price`` is the promo price.

        The original sticker price is kept in ``menu_price`` so the rendered
        list still shows what the customer sees on the menu board.
        """
        out: list[dict] = []
        for p in products:
            q = dict(p)
            q["menu_price"] = p.get("menu_price", p["price"])
            if tier is not None and tier.factor != 1.0 and p["code"] not in self.excluded_codes:
                q["price"] = round(p["price"] * tier.factor, 2)
                q["discounted"] = True
            else:
                q["discounted"] = False
            out.append(q)
        return out

    def budget_for_tier(self, budget: float, tier: Tier | None) -> float:
        """Solver budget in *scaled* prices (fees already taken out)."""
        product_budget = max(0.0, budget - self.fees())
        if tier is None:
            return product_budget
        return round(product_budget + tier.amount, 2)

    # ----------------------------------------------------------------- quotes

    def quote(self, items: list[dict], budget: float | None = None) -> Quote:
        """Price a solved plan (items carry sticker ``unit_price``)."""
        subtotal = 0.0
        eligible = 0.0
        for it in items:
            line = it["unit_price"] * it["qty"]
            subtotal += line
            code = (it.get("order") or {}).get("productCode") or it.get("code") or ""
            if code not in self.excluded_codes:
                eligible += line
        return self.quote_subtotal(subtotal, budget, eligible)

    def quote_subtotal(self, subtotal: float, budget: float | None = None,
                       eligible: float | None = None) -> Quote:
        """Price a menu subtotal (used for the baseline / min-viable figure)."""
        eligible = subtotal if eligible is None else eligible
        tier = self.tier_for_subtotal(subtotal)
        discount = 0.0
        if tier is not None:
            if tier.amount:
                discount = min(tier.amount, eligible)
            else:
                discount = eligible * (1 - tier.factor)
        discount = round(discount, 2)
        product_payable = round(subtotal - discount, 2)
        return Quote(
            subtotal=round(subtotal, 2),
            discount=discount,
            product_payable=product_payable,
            packing=self.packing_fee,
            delivery=self.delivery_fee,
            total=round(product_payable + self.fees(), 2),
            tier=tier,
            tier_label=tier.label if tier else "",
            service_name=self.service_name,
            next_hint=self.next_hint(subtotal, budget),
        )

    def next_hint(self, subtotal: float, budget: float | None = None) -> str:
        """'再点 ¥X 可享 7 折' — only if that step is still affordable."""
        nxt = sorted((t for t in self.tiers if t.threshold > subtotal + 0.01),
                     key=lambda t: t.threshold)
        for tier in nxt:
            gap = tier.threshold - subtotal
            target = tier.payable(tier.threshold) + self.fees()
            if budget is None or target <= budget + 0.05:
                return f"再点 ¥{gap:.0f} 可享「{tier.label}」"
            return (f"再点 ¥{gap:.0f} 可享「{tier.label}」，"
                    f"实付约 ¥{target:.0f}（需加预算 ¥{target - budget:.0f}）")
        return ""

    def describe(self) -> str:
        bits = [self.source]
        if self.service_name:
            bits.append(f"助餐服务：{self.service_name}")
        if self.tiers:
            lo = min(self.tiers, key=lambda t: t.threshold)
            hi = max(self.tiers, key=lambda t: t.threshold)
            if lo is hi:
                bits.append(lo.label)
            else:
                bits.append(f"{lo.label} 起，最高 {hi.label}")
        if self.has_fees:
            bits.append(f"配送 ¥{self.delivery_fee:.0f} + 打包 ¥{self.packing_fee:.0f}")
        return "；".join(bits)


# ------------------------------------------------------------------ parsing


def parse_tiers(rules: list[dict], service_code: str | None = None,
                service_name: str = "") -> tuple[list[Tier], set[str]]:
    """Turn raw ``query-promotions`` rules into tiers + excluded product codes."""
    tiers: list[Tier] = []
    excluded: set[str] = set()
    for rule in rules or []:
        svc = str(rule.get("gmServiceCode") or "")
        if service_code and svc and svc != service_code:
            continue
        detail = rule.get("ruleDetail") or {}
        pid = str(rule.get("promotionId") or "")
        discount = detail.get("orderDiscount") or {}
        reduce = detail.get("orderReduce") or {}
        if discount:
            value = _f(discount.get("discount"))
            threshold = _f(discount.get("startDiscountPoint"))
            if 0 < value < 100 and threshold > 0:
                tiers.append(Tier(
                    threshold=threshold,
                    factor=round((100 - value) / 100, 4),
                    amount=0.0,
                    service_code=svc,
                    service_name=service_name,
                    promotion_id=pid,
                ))
        for step in reduce.get("reduceInfo") or []:
            amount = _f(step.get("reduceAmount"))
            threshold = _f(step.get("startDiscountPoint"))
            if amount > 0 and threshold > 0:
                tiers.append(Tier(
                    threshold=threshold,
                    factor=1.0,
                    amount=amount,
                    service_code=svc,
                    service_name=service_name,
                    promotion_id=pid,
                ))
        for prod in rule.get("products") or []:
            if str(prod.get("type")) == "2" and prod.get("productCode"):
                excluded.add(str(prod["productCode"]))
    # dedupe identical ladders coming from repeated rules
    seen: set[tuple] = set()
    unique: list[Tier] = []
    for t in sorted(tiers, key=lambda t: (t.threshold, t.factor)):
        key = (round(t.threshold, 2), t.factor, t.amount)
        if key in seen:
            continue
        seen.add(key)
        unique.append(t)
    return unique, excluded


# --------------------------------------------------------------- model build


def probe_fees(store_code: str, order_type: int, be_type: int, be_code: str | None,
               product_code: str, quantity: int, reservation: str | None = None,
               gm_service_code: str | None = None) -> tuple[float, float] | None:
    """Ask calculate-price for a realistic basket and read the fee lines.

    The packing fee is itself discounted / capped by the store, so guessing a
    per-item rate is worse than probing once at roughly the right order size.
    """
    items = [{"productCode": product_code, "quantity": max(1, min(99, int(quantity)))}]
    try:
        data = mcd_api.calculate_price(
            store_code, items, order_type, be_type, be_code, reservation, gm_service_code
        ).get("data") or {}
    except Exception:
        return None
    if not data or "packingPrice" not in data:
        return None
    return _f(data.get("deliveryPrice")) / 100, _f(data.get("packingPrice")) / 100


def build_model(store_code: str, order_type: int, be_type: int, be_code: str | None,
                budget: float, probe_code: str | None = None, people: int = 4,
                reservation: str | None = None, service_code: str | None = None,
                use_promotions: bool = True, verbose: bool = False) -> PriceModel:
    """Build the price model for the current store / order mode.

    For 团餐 it picks the 助餐服务 + 满折 tier that buys the most food for the
    budget; for 麦乐送 it probes delivery/packing fees; for 到店 it is a no-op.
    """
    if be_type != 6:
        if order_type != 2:
            return PriceModel(mode="store", source="到店菜单价（无配送/打包费）")
        delivery, packing = 0.0, 0.0
        probed = None
        if probe_code:
            probed = probe_fees(store_code, order_type, be_type, be_code,
                                probe_code, max(4, people * 3), reservation)
        if probed:
            delivery, packing = probed
            source = "麦乐送菜单价（含门店配送/打包费）"
        else:
            delivery, packing = DEFAULT_DELIVERY_FEE, DEFAULT_PACKING_FEE
            source = "麦乐送菜单价（配送/打包费为估算）"
        return PriceModel(
            mode="delivery", delivery_fee=round(delivery, 2), packing_fee=round(packing, 2),
            source=source,
            notes=["配送费/打包费随门店与订单金额浮动，最终以算价接口为准"],
        )

    assists = mcd_api.meal_assistance(store_code, order_type, be_type, be_code, reservation)
    usable = [a for a in assists if a.get("enable")]
    if service_code:
        usable = [a for a in usable if str(a.get("gmServiceCode")) == service_code]
    if not usable and assists:
        # every service is disabled (time window) — keep the default anyway so
        # the plan is still priced honestly, without a discount promise
        usable = [a for a in assists if a.get("selected")] or assists[:1]

    rules = mcd_api.promotions(store_code, order_type, be_type, be_code, reservation) \
        if use_promotions else []

    # fee probe (uses the selected service for accurate 团餐 pricing)
    probe_service = str(usable[0].get("gmServiceCode")) if usable else None
    delivery, packing = DEFAULT_DELIVERY_FEE, DEFAULT_PACKING_FEE
    probed = probe_fees(store_code, order_type, be_type, be_code, probe_code,
                        max(4, people * 3), reservation, probe_service) if probe_code else None
    if probed:
        delivery, packing = probed
    fees = delivery + packing
    product_budget = max(0.0, budget - fees)

    best: PriceModel | None = None
    best_capacity = -1.0
    for a in usable:
        code = str(a.get("gmServiceCode") or "")
        name = a.get("gmServiceName") or code
        tiers, excluded = parse_tiers(rules, code, name)
        model = PriceModel(
            mode="catering", service_code=code, service_name=name,
            tiers=tuple(tiers), excluded_codes=frozenset(excluded),
            delivery_fee=round(delivery, 2), packing_fee=round(packing, 2),
            source="团餐菜单价（含活动优惠）" if use_promotions else "团餐菜单价（未计活动）",
        )
        tier = model.tier_for_budget(product_budget)
        capacity = tier.capacity(product_budget) if tier else product_budget
        if tier is not None and capacity > best_capacity:
            best, best_capacity = model, capacity
        elif best is None:
            best, best_capacity = model, capacity

    if best is None:
        best = PriceModel(mode="catering", delivery_fee=round(delivery, 2),
                          packing_fee=round(packing, 2), source="团餐菜单价")

    if use_promotions:
        best.notes.append("团餐活动按助餐服务计算，换服务/换送达时段优惠会变")
    if not best.tiers:
        best.notes.append("当前门店/时段没有可用满折满减，按菜单价计")
    if verbose:
        print(f"[pricing] {best.describe()}", file=__import__("sys").stderr)
    return best


def apply_model(products: list[dict], model: PriceModel, budget: float
                ) -> tuple[list[dict], float, Tier | None]:
    """Scale products + budget for the solver; returns (products, budget, tier)."""
    tier = model.tier_for_budget(max(0.0, budget - model.fees()))
    scaled = model.scale_products(products, tier)
    return scaled, model.budget_for_tier(budget, tier), tier
