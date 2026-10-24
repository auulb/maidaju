import "./style.css";
import type { Order, OrderAttempt, OrderAuthorization, Quote } from "@/contracts";
import type { DiningSessionRecord } from "@/modules/ports";
import type { MemberInput } from "@/modules/intake/session";
import type { HardAvoid, MemberRequirement } from "@/modules/intake/types";
import type { FactAttribute, MenuSnapshot, StoreSummary } from "@/modules/catalog/types";
import type { Candidate, GenerateResult } from "@/modules/planning/types";

const app = document.querySelector<HTMLDivElement>("#app")!;
type AppData = {
  session: DiningSessionRecord; members: MemberRequirement[]; stores: StoreSummary[];
  menu: MenuSnapshot | null; candidates: Candidate[]; warnings?: string[];
  demoFacts: Record<string, Partial<Record<FactAttribute, boolean>>>;
  result?: GenerateResult;
};
type SetupDraft = { name: string; memberCount: string; budgetYuan: string; city: string; keyword: string; needTableware: boolean };
type MemberDraft = MemberInput & { capYuan: string; mainCount: string; preferences: string };
type Notice = { type: "ok" | "error" | "info"; text: string };
type Resume = {
  sessionId: string; step: number; candidateId: string | null; candidateVersion: number | null;
  quote: Quote | null; auth: OrderAuthorization | null; order: Order | null;
  attempt: OrderAttempt | null; frozen: boolean; takeWayCode: string;
};
const STORAGE = "maidaju.mock.v1";
const AVOIDS: Record<HardAvoid, string> = {
  spicy: "不吃辣", sugary_drink: "不喝含糖饮料", beef: "不吃牛肉", pork: "不吃猪肉", seafood: "不吃海鲜",
};
const FACTS: Record<FactAttribute, string> = {
  is_main: "是主食", contains_spicy: "含辣", is_sugary_drink: "含糖饮品",
  contains_beef: "含牛肉", contains_pork: "含猪肉", contains_seafood: "含海鲜",
};
const state = {
  data: null as AppData | null, step: 0, selectedCandidate: null as Candidate | null,
  setup: null as SetupDraft | null, members: [] as MemberDraft[],
  quote: null as Quote | null, auth: null as OrderAuthorization | null,
  order: null as Order | null, attempt: null as OrderAttempt | null,
  busy: false, frozen: false, notice: null as Notice | null,
  factsConfirmed: false, confirmed: false, acknowledged: new Set<string>(), takeWayCode: "",
};
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]!));
const yuan = (fen: number) => `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
const money = (fen: number | null | undefined) => fen == null ? "待核价" : `¥${yuan(fen)}`;
function parseFen(value: string): number | null {
  if (!value.trim()) return null;
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("预算请输入最多两位小数的金额，例如 25.50");
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly details: unknown = null) { super(message); }
}
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const out = await response.json() as { ok: boolean; data: T; error?: { code: string; message: string; details: unknown } };
  if (!out.ok || !response.ok) throw new ApiError(out.error?.code ?? "HTTP_ERROR", out.error?.message ?? "请求失败", out.error?.details);
  return out.data;
}
const post = <T>(url: string, data: unknown = {}) => request<T>(url, { method: "POST", body: JSON.stringify(data) });
const endpoint = (action: string) => `/api/sessions/${encodeURIComponent(state.data!.session.id)}/${action}`;
function persist() {
  try {
    if (!state.data) { sessionStorage.removeItem(STORAGE); return; }
    const saved: Resume = {
      sessionId: state.data.session.id, step: state.step,
      candidateId: state.selectedCandidate?.id ?? null, candidateVersion: state.selectedCandidate?.version ?? null,
      quote: state.quote, auth: state.auth, order: state.order, attempt: state.attempt,
      frozen: state.frozen, takeWayCode: state.takeWayCode,
    };
    sessionStorage.setItem(STORAGE, JSON.stringify(saved));
  } catch { /* 浏览器禁用存储时，仍可继续使用当前页面。 */ }
}
function clearCheckout() {
  state.quote = null; state.auth = null; state.order = null; state.attempt = null;
  state.frozen = false; state.confirmed = false; state.acknowledged.clear(); state.takeWayCode = "";
}
function applyData(data: AppData) {
  state.data = data;
  const s = data.session;
  state.setup = { name: s.name, memberCount: String(s.memberCount), budgetYuan: yuan(s.budgetFen), city: s.city ?? "", keyword: s.keyword ?? "", needTableware: s.needTableware };
  state.members = data.members.map((m) => ({ ...m, hardAvoid: [...m.hardAvoid], capYuan: m.budgetCapFen == null ? "" : yuan(m.budgetCapFen), mainCount: String(m.requiredMainCount), preferences: m.softPrefer.join("，") }));
  const selected = data.candidates.find((c) => c.id === state.selectedCandidate?.id && c.version === state.selectedCandidate?.version) ?? null;
  if (!selected || (state.quote && state.quote.sessionRevision !== s.revision)) clearCheckout();
  state.selectedCandidate = selected;
  state.factsConfirmed = false;
}
function busy() {
  app.setAttribute("aria-busy", String(state.busy));
  if (state.busy) {
    app.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button,input,select,textarea").forEach((el) => { el.disabled = true; });
    app.querySelector(".content")?.insertAdjacentHTML("afterbegin", '<div class="working" role="status">正在处理，请稍候…</div>');
  }
}
async function run(fn: () => Promise<void>, success?: string) {
  if (state.busy) return;
  state.busy = true; state.notice = null; busy();
  try {
    await fn();
    if (success) state.notice = { type: "ok", text: success };
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    state.notice = { type: "error", text: error instanceof ApiError ? `[${error.code}] ${message}` : message };
  } finally { state.busy = false; render(); }
}
function report(error: unknown) { state.notice = { type: "error", text: error instanceof Error ? error.message : "操作失败" }; render(); }
function card(title: string, body: string) { return `<section class="card"><div class="card-title"><h2>${esc(title)}</h2></div>${body}</section>`; }
function summary() {
  const s = state.data?.session;
  return s ? `<div class="session-summary"><strong>${esc(s.name)}</strong><span>${s.memberCount} 人</span><span>总预算 ${money(s.budgetFen)}</span><span>${esc(s.selectedStore?.name ?? `${s.city ?? ""} · ${s.keyword ?? "待选店"}`)}</span></div>` : "";
}
function render() {
  const steps = ["建局", "成员需求", "选店与菜单", "候选方案", "核价下单"];
  app.innerHTML = `<header class="topbar"><div class="brand"><span class="arches">M</span><span>麦搭局</span><small>多人点餐助手</small></div><div class="mode-pill">演示模式 · MOCK</div><button class="reset" data-action="reset">重新开始</button></header>
    <main class="page"><section class="hero"><div><p class="eyebrow">多人一起吃，先把选择变简单</p><h1>一桌人的餐盘，<em>一起搭出来。</em></h1><p class="sub">逐人设置需求、比较搭配方案，再核价和模拟下单。门店、餐品属性与订单均为演示数据。</p></div><div class="hero-mark" aria-hidden="true">🍔<span>+</span>🍟<span>+</span>🥤</div></section>
    <nav class="steps" aria-label="点餐步骤">${steps.map((label, i) => `<div class="step ${i === state.step ? "current" : i < state.step ? "done" : ""}" ${i === state.step ? 'aria-current="step"' : ""}><b>${i < state.step ? "✓" : i + 1}</b><span>${label}</span></div>`).join("")}</nav>
    ${summary()}${state.notice ? `<div class="notice ${state.notice.type}" role="${state.notice.type === "error" ? "alert" : "status"}">${esc(state.notice.text)}<button aria-label="关闭提示" data-action="dismiss">×</button></div>` : ""}
    <section class="content">${state.data ? [setupPage, membersPage, storePage, candidatesPage, checkoutPage][state.step]!() : welcomePage()}</section>
    <footer><span>麦搭局 · 本地体验版</span><span>界面显示元 · 内部使用整数分 · 服务重启后演示数据清空</span></footer></main>`;
  busy(); persist();
}
function welcomePage() {
  return `<div class="welcome"><div class="welcome-icon">🍱</div><h2>欢迎来到麦搭局</h2><p>为 6–20 人搭配餐盘，把每个人的需求放进同一份订单。</p><div class="feature-grid"><div><b>👥</b><strong>逐人需求</strong><span>忌口、主食份数与预算</span></div><div><b>🧩</b><strong>候选搭配</strong><span>比较餐盘与共享餐品</span></div><div><b>🧾</b><strong>核价确认</strong><span>查看实付和逐人分摊</span></div></div><button class="primary big" data-action="new">开始创建点餐局 →</button><p class="tiny">无需 token，不会连接真实账户或产生真实订单。</p></div>`;
}
function setupPage() {
  const d = state.setup!;
  return `<div class="two-col"><div>${card("创建一桌人的点餐局", `<p class="muted">保存后生效；修改需求会使已有候选和报价失效。</p><label>点餐局名称<input id="name" data-setup="name" maxlength="40" value="${esc(d.name)}" /></label><div class="form-row"><label>人数<input id="memberCount" data-setup="memberCount" type="number" min="6" max="20" value="${esc(d.memberCount)}" /></label><label>总预算（元）<input id="budgetYuan" data-setup="budgetYuan" inputmode="decimal" value="${esc(d.budgetYuan)}" /></label></div><div class="form-row"><label>城市<input id="city" data-setup="city" maxlength="20" value="${esc(d.city)}" /></label><label>位置关键词<input id="keyword" data-setup="keyword" maxlength="50" value="${esc(d.keyword)}" /></label></div><label class="check"><input id="tableware" type="checkbox" data-setup="needTableware" ${d.needTableware ? "checked" : ""} /> 需要餐具</label><button class="primary" data-action="save-setup">保存并继续 →</button>`)}</div><aside>${card("当前演示环境", '<div class="demo-box"><span class="demo-icon">🧪</span><div><b>MOCK 模式 · 到店自取</b><p>模拟门店与商品属性用于体验流程，不能作为真实餐品信息使用。</p></div></div><ul class="safe-list"><li>本地内存保存演示数据</li><li>支持刷新页面继续当前流程</li><li>核价后需明确确认才能模拟下单</li></ul>')}</aside></div>`;
}
function membersPage() {
  return `<div class="section-head"><div><p class="eyebrow">STEP 2 · 了解每个人</p><h2>成员需求</h2><p class="muted">硬性忌口用于约束检查，偏好作为搭配参考。</p></div><span class="count-badge">${state.members.length} 人</span></div>${card("逐人设置", `<div class="member-list">${state.members.map((m, i) => `<div class="member-editor"><div class="member-basics"><div class="member-num">${i + 1}</div><label>成员称呼<input class="member-alias" data-index="${i}" data-field="alias" maxlength="20" value="${esc(m.alias)}" /></label><label>主食份数<input type="number" min="0" max="5" data-index="${i}" data-field="mainCount" value="${esc(m.mainCount)}" /></label><label>个人上限（元，可不填）<input inputmode="decimal" data-index="${i}" data-field="capYuan" value="${esc(m.capYuan)}" placeholder="不单独限制" /></label></div><div class="avoid-options">${Object.entries(AVOIDS).map(([key, label]) => `<label class="member-toggle"><input type="checkbox" data-index="${i}" data-avoid="${key}" ${m.hardAvoid.includes(key as HardAvoid) ? "checked" : ""} />${label}</label>`).join("")}</div><label class="preference-label">其他偏好<input data-index="${i}" data-field="preferences" value="${esc(m.preferences)}" placeholder="例如：喜欢薯条，多项用逗号分开" /></label></div>`).join("")}</div><div class="tip">商品主食、辣度、糖分以明确事实为依据。未知事实会标为待确认。</div><div class="actions"><button class="secondary" data-action="back">← 上一步</button><button class="primary" data-action="save-members">保存需求并选店 →</button></div>`)}`;
}
function factTable() {
  const d = state.data!;
  const attrs = Object.keys(FACTS) as FactAttribute[];
  return `<details class="facts-panel"><summary>查看模拟商品事实（${d.menu!.items.length} 个商品）</summary><p class="tiny">以下为预设的演示属性，与真实餐品无关。缺少属性时显示「待确认」。</p><div class="table-scroll"><table class="fact-table"><thead><tr><th>模拟餐品</th>${attrs.map((a) => `<th>${FACTS[a]}</th>`).join("")}</tr></thead><tbody>${d.menu!.items.map((item) => `<tr><th>${esc(item.name)}</th>${attrs.map((attr) => { const value = d.demoFacts[item.code]?.[attr]; return `<td>${value === undefined ? "待确认" : value ? "是" : "否"}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}
function storePage() {
  const d = state.data!, menu = d.menu?.items ?? [];
  return `<div class="section-head"><div><p class="eyebrow">STEP 3 · 选择供应门店</p><h2>门店与菜单</h2><p class="muted">选择模拟门店，加载菜单，再检查演示属性。</p></div>${menu.length ? '<span class="status-chip">✓ 已加载菜单</span>' : ""}</div>
    ${card("① 搜索附近门店", `<button class="secondary" data-action="search-stores">${d.stores.length ? "重新搜索" : "搜索模拟门店"}</button><div class="store-list">${d.stores.map((s) => `<button class="store ${d.session.selectedStore?.storeCode === s.storeCode ? "selected" : ""}" data-store="${esc(s.storeCode)}"><span class="store-pin">⌖</span><span><b>${esc(s.name)}</b><small>${esc(s.address)} · ${esc(s.businessHours)}</small></span><i>${d.session.selectedStore?.storeCode === s.storeCode ? "✓" : "→"}</i></button>`).join("") || '<p class="empty">点击按钮搜索模拟门店。</p>'}</div>`)}
    ${d.session.selectedStore ? card("② 查看餐品菜单", `<div class="selected-store">已选择：<b>${esc(d.session.selectedStore.name)}</b></div><button class="primary" data-action="load-menu">${menu.length ? "刷新菜单" : "加载模拟菜单"} →</button>${menu.length ? `<div class="menu-grid">${menu.map((p) => `<div class="menu-item"><span class="food" aria-hidden="true">🍽️</span><div><b>${esc(p.name)}</b><small>${money(p.priceFen)} · ${p.category === "combo" ? "套餐" : p.category === "unknown" ? "分类待确认" : "单品"}</small></div></div>`).join("")}</div>${factTable()}<label class="confirm-check"><input type="checkbox" id="confirmFacts" ${state.factsConfirmed ? "checked" : ""} />我已查看并确认上述模拟属性用于本次演示</label>` : ""}`) : ""}
    ${d.warnings?.length ? `<div class="notice info">${d.warnings.map(esc).join("；")}</div>` : ""}<div class="actions"><button class="secondary" data-action="back">← 上一步</button>${menu.length ? '<div class="button-group"><button class="secondary" data-action="generate">保留待确认并生成</button><button class="primary" data-action="confirm-facts">确认模拟事实并生成方案 →</button></div>' : ""}</div>`;
}
const statusLabel = (status: string) => status === "pass" ? "✓ 满足" : status === "pending" ? "? 待确认" : "✗ 未满足";
const productName = (code: string) => state.data?.menu?.items.find((p) => p.code === code)?.name ?? code;
const memberName = (id: string | null) => state.data?.members.find((m) => m.memberId === id)?.alias ?? (id ?? "整局");
function candidateCard(c: Candidate, i: number) {
  const selected = state.selectedCandidate?.id === c.id;
  return `<article class="candidate ${selected ? "chosen" : ""}"><div class="candidate-top"><span class="candidate-no">方案 ${i + 1}</span><span class="profile">${esc(c.label)}</span><span class="constraint ${c.hardConstraintStatus}">${statusLabel(c.hardConstraintStatus)}</span></div><div class="candidate-price">${money(c.estimatedTotalFen)}<small> 菜单估算</small></div><div class="tray-grid">${c.memberOrder.map((id) => `<div class="tray"><b>${esc(memberName(id))}<span class="tray-cost">${money(c.estimatedMemberFen?.[id])}</span></b><span>${(c.trays[id] ?? []).map((code) => esc(productName(code))).join("、") || "无独享餐品"}</span></div>`).join("")}</div>${c.shared.length ? `<div class="shared-line">共享：${c.shared.map((p) => `${esc(productName(p.code))} ×${p.quantity}（${p.memberIds.map((id) => esc(memberName(id))).join("、")}）`).join("；")}</div>` : ""}<details class="check-details"><summary>查看约束检查 ${c.unresolvedFactIds.length ? `· ${c.unresolvedFactIds.length} 项事实待确认` : ""}</summary>${c.checks.map((check) => `<p class="check-line ${check.status}"><b>${esc(memberName(check.memberId))} · ${statusLabel(check.status)}</b><span>${esc(check.reason)}</span></p>`).join("")}</details><button class="choose-candidate ${selected ? "selected" : ""}" data-candidate="${esc(c.id)}">${selected ? "已选择此方案 ✓" : "选择此方案 →"}</button></article>`;
}
function candidatesPage() {
  const d = state.data!;
  return `<div class="section-head"><div><p class="eyebrow">STEP 4 · 逐人餐盘</p><h2>候选方案</h2><p class="muted">按购物车内容去重，每位成员金额为估算。实际金额以下一步核价为准。</p></div><span class="count-badge">${d.candidates.length} 套</span></div>${d.result ? `<div class="tip">${esc(d.result.message)}</div>` : ""}
    ${card(`比较 ${d.candidates.length} 套搭配`, d.candidates.length ? `<div class="candidates">${d.candidates.map(candidateCard).join("")}</div>` : `<div class="empty">当前搜索范围内未找到可行方案。</div>${d.result?.conflicts.map((c) => `<div class="conflict"><b>${esc(c.reason)}</b><p>${c.suggestions.map(esc).join("；")}</p></div>`).join("") ?? ""}`)}<div class="actions"><button class="secondary" data-action="back">← 返回菜单</button><button class="primary" data-action="quote" ${state.selectedCandidate ? "" : "disabled"}>核价并继续 →</button></div>`;
}
function pendingFacts(c: Candidate) {
  return c.unresolvedFactIds.length ? `<div class="pending-facts"><h3>逐项确认待核实事实</h3><p class="tiny">接受待确认不等于事实已被核实。也可以返回菜单，确认模拟属性后重新生成。</p>${c.unresolvedFactIds.map((id) => {
    const reasons = [...new Set(c.checks.filter((check) => check.factIds.includes(id) && check.status === "pending").map((check) => `${memberName(check.memberId)}：${check.reason}`))];
    return `<label class="confirm-check"><input type="checkbox" data-fact-id="${esc(id)}" ${state.acknowledged.has(id) ? "checked" : ""} /><span>我接受本项待确认：${esc(reasons.join("；") || id)}</span></label>`;
  }).join("")}</div>` : "";
}
function checkoutPage() {
  const q = state.quote, c = state.selectedCandidate;
  if (!q || !c) return '<div class="empty">报价已失效，请返回候选重新核价。<br/><button class="secondary" data-action="back">返回候选</button></div>';
  const expired = Date.now() > Date.parse(q.expiresAt);
  const locked = !!state.order || !!state.attempt || state.frozen;
  const gate = q.budgetOk === "pass" && !!q.takeWayOptions.length && !expired;
  return `<div class="section-head"><div><p class="eyebrow">STEP 5 · 核价与确认</p><h2>核价与下单</h2><p class="muted">本地确认窗口截至 ${esc(new Date(q.expiresAt).toLocaleTimeString("zh-CN"))}，不代表锁价。</p></div><span class="status-chip">${expired ? "报价窗口已过期" : "✓ 模拟核价完成"}</span></div><div class="checkout-grid"><div>${card("订单摘要", `<div class="total"><span>模拟实付</span><strong>${money(q.payableFen)}</strong></div><div class="price-line"><span>菜单原价</span><span>${money(q.originalFen)}</span></div><div class="price-line"><span>整局预算</span><span>${money(state.data!.session.budgetFen)}</span></div><div class="price-line"><span>预算状态</span><span class="constraint ${q.budgetOk}">${q.budgetOk === "pass" ? "✓ 在预算内" : q.budgetOk === "pending" ? "? 分摊待确认" : "✗ 超出预算"}</span></div><hr/><div class="order-lines">${c.items.map((item) => `<div><span>${esc(productName(item.productCode))}${item.roundList ? `<small>${item.roundList.flatMap((r) => r.comboItemList.map((p) => esc(productName(p.code)))).join("、")}</small>` : ""}</span><b>× ${item.quantity}</b></div>`).join("")}</div>`)}${card("逐人记账分摊", `<p class="tiny">${esc(q.allocationNote)}</p>${q.memberAllocatedFen ? `<div class="allocation-list">${c.memberOrder.map((id) => `<div><span>${esc(memberName(id))}</span><strong>${money(q.memberAllocatedFen![id])}</strong><small>上限：${money(c.memberBudgetCapFen[id]) === "待核价" ? "未单设" : money(c.memberBudgetCapFen[id])}</small></div>`).join("")}</div>` : '<p class="muted">尚无可靠的逐人分摊金额。</p>'}`)}</div><div>${card("选择取餐方式", `<div class="takeways">${q.takeWayOptions.map((t) => `<label class="takeway"><input type="radio" name="takeway" value="${esc(t.code)}" ${state.takeWayCode === t.code ? "checked" : ""} ${locked ? "disabled" : ""} /><span>${esc(t.label)}</span></label>`).join("") || '<p class="muted">核价未返回取餐方式，暂不能下单。</p>'}</div>${!locked ? `${pendingFacts(c)}<label class="confirm-check"><input type="checkbox" id="confirmOrder" ${state.confirmed ? "checked" : ""} />我已确认餐品、实付和取餐方式，同意创建模拟订单</label><button class="primary wide" data-action="create-order" ${gate ? "" : "disabled"}>确认并创建模拟订单 →</button>${!gate ? '<p class="notice error">当前报价过期、预算不通过或缺少取餐方式，请调整后重新核价。</p>' : ""}` : '<p class="tip">本次创建已提交，下单按钮已锁定。</p>'}<p class="tiny">创建成功不等于已支付。演示模式无真实支付链接。</p>`)}${orderResult()}</div></div><div class="actions"><button class="secondary" data-action="back">← 返回候选</button>${!locked ? '<button class="secondary" data-action="quote">重新核价</button>' : ""}</div>`;
}
function orderResult() {
  if (state.order) return card("订单结果", `<div class="order-result"><div class="success-icon">✓</div><h3>模拟订单已创建</h3><p>订单号：<code>${esc(state.order.orderId)}</code></p><p>实付：<b>${money(state.order.payableFen)}</b></p><p>当前状态：<b>${esc(state.order.serverStatus ?? "尚未查询")}</b></p><button class="secondary" data-action="refresh-order">查询最新状态</button></div>`);
  if (state.attempt?.status === "rejected") return card("创建未成功", `<div class="notice error">${esc(state.attempt.error ?? "模拟服务拒绝创建订单")}</div><button class="secondary" data-action="quote">重新核价并确认</button>`);
  if (state.frozen || state.attempt) return card("创建结果待核对", '<div class="notice info">本次创建结果尚未确认，已冻结再次下单。请保留当前页面与请求记录。</div>');
  return "";
}

async function generate(confirm: boolean) {
  if (confirm && !state.factsConfirmed) throw new Error("请先查看并勾选确认模拟商品属性");
  await run(async () => {
    if (confirm) applyData(await post<AppData>(endpoint("facts/confirm-all"), { confirmed: true, revision: state.data!.session.revision }));
    applyData(await post<AppData>(endpoint("candidates")));
    clearCheckout(); state.selectedCandidate = null; state.step = 3;
  }, "候选方案已生成");
}
async function action(name: string) {
  if (name === "dismiss") { state.notice = null; render(); return; }
  if (name === "new") return run(async () => {
    applyData(await post<AppData>("/api/session", { name: "周五聚餐", memberCount: 6, budgetYuan: "150", city: "上海市", keyword: "人民广场" }));
    state.step = 0; state.selectedCandidate = null; clearCheckout();
  }, "点餐局已创建");
  if (name === "reset") return run(async () => {
    await post("/api/reset"); state.data = null; state.setup = null; state.members = []; state.step = 0; state.selectedCandidate = null; clearCheckout();
  }, "演示已重置");
  if (name === "back") { state.step = Math.max(0, state.step - 1); state.confirmed = false; render(); return; }
  if (name === "save-setup") {
    const d = state.setup!;
    if (!d.name.trim()) throw new Error("请填写点餐局名称");
    if (!Number.isInteger(Number(d.memberCount)) || Number(d.memberCount) < 6 || Number(d.memberCount) > 20) throw new Error("人数需为 6–20 的整数");
    if (!parseFen(d.budgetYuan)) throw new Error("请填写大于 0 的总预算");
    return run(async () => {
      applyData(await post<AppData>(endpoint("setup"), { ...d, memberCount: Number(d.memberCount), revision: state.data!.session.revision }));
      state.step = 1;
    }, "点餐局设置已保存");
  }
  if (name === "save-members") {
    const members: MemberInput[] = state.members.map((m) => {
      const requiredMainCount = Number(m.mainCount);
      if (!m.alias.trim()) throw new Error("请填写每位成员的称呼");
      if (!m.mainCount || !Number.isInteger(requiredMainCount) || requiredMainCount < 0 || requiredMainCount > 5) throw new Error(`${m.alias} 的主食份数需为 0–5 的整数`);
      return { memberId: m.memberId, alias: m.alias.trim(), hardAvoid: m.hardAvoid, requiredMainCount, budgetCapFen: parseFen(m.capYuan), softPrefer: m.preferences.split(/[,，、;；\n]/).map((v) => v.trim()).filter(Boolean) };
    });
    return run(async () => { applyData(await post<AppData>(endpoint("members"), { members, revision: state.data!.session.revision })); state.step = 2; }, "成员需求已保存");
  }
  if (name === "search-stores") return run(async () => { applyData(await request<AppData>(endpoint("stores"))); }, "已找到模拟门店");
  if (name === "load-menu") return run(async () => { applyData(await post<AppData>(endpoint("catalog"), { revision: state.data!.session.revision })); }, "菜单加载完成");
  if (name === "confirm-facts" || name === "generate") return generate(name === "confirm-facts");
  if (name === "quote") {
    const c = state.selectedCandidate;
    if (!c) throw new Error("请先选择一套方案");
    if (state.frozen && !state.order && state.attempt?.status !== "rejected") throw new Error("上次创建结果尚未确认，不能再次提交");
    return run(async () => {
      const quote = await post<Quote>(endpoint("quote"), { candidateId: c.id, version: c.version });
      clearCheckout(); state.quote = quote; state.takeWayCode = quote.takeWayOptions[0]?.code ?? ""; state.step = 4;
    }, "核价完成，请核对逐人分摊");
  }
  if (name === "create-order") {
    if (!state.confirmed) throw new Error("请勾选确认框，明确同意创建模拟订单");
    if (!state.takeWayCode) throw new Error("请选择取餐方式");
    if (state.order || state.attempt || state.frozen) throw new Error("本次创建已提交，请查看订单结果");
    const pending = state.selectedCandidate!.unresolvedFactIds.filter((id) => !state.acknowledged.has(id));
    if (pending.length) throw new Error(`还有 ${pending.length} 项待确认事实未逐项接受`);
    const quote = state.quote!;
    if (Date.now() > Date.parse(quote.expiresAt)) throw new Error("报价窗口已过期，请重新核价");
    return run(async () => {
      state.auth ??= await post<OrderAuthorization>(endpoint("authorize"), { quoteId: quote.id, takeWayCode: state.takeWayCode, acknowledgedFactIds: [...state.acknowledged], userConfirmed: true });
      state.frozen = true; persist();
      const result = await post<{ attempt: OrderAttempt; order: Order | null }>(endpoint("order"), { authorizationId: state.auth.id, idempotencyKey: `web-${quote.id}` });
      state.attempt = result.attempt; state.order = result.order;
      state.notice = { type: result.order ? "ok" : "info", text: result.order ? "模拟订单已创建，可查询状态" : result.attempt.error ?? "创建请求已提交，尚无可确认的订单" };
    });
  }
  if (name === "refresh-order" && state.order) return run(async () => {
    state.order = await request<Order>(endpoint(`order/${encodeURIComponent(state.order!.orderId)}`));
  }, "订单状态已刷新");
}
app.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-action],[data-store],[data-candidate]");
  if (!target || state.busy) return;
  void (async () => {
    if (target.dataset.action) return action(target.dataset.action);
    if (target.dataset.store) return run(async () => { applyData(await post<AppData>(endpoint("store"), { storeCode: target.dataset.store, revision: state.data!.session.revision })); }, "已选择门店");
    if (target.dataset.candidate) {
      const candidate = state.data!.candidates.find((c) => c.id === target.dataset.candidate) ?? null;
      if (candidate?.id !== state.selectedCandidate?.id) clearCheckout();
      state.selectedCandidate = candidate; render();
    }
  })().catch(report);
});
app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.setup && state.setup) {
    if (input.dataset.setup === "needTableware") state.setup.needTableware = input.checked;
    else state.setup[input.dataset.setup as Exclude<keyof SetupDraft, "needTableware">] = input.value;
  }
  if (input.dataset.index !== undefined) {
    const m = state.members[Number(input.dataset.index)];
    if (!m) return;
    if (input.dataset.avoid) {
      const key = input.dataset.avoid as HardAvoid;
      m.hardAvoid = input.checked ? [...new Set([...m.hardAvoid, key])] : m.hardAvoid.filter((value) => value !== key);
    } else if (input.dataset.field) m[input.dataset.field as "alias" | "mainCount" | "capYuan" | "preferences"] = input.value;
  }
  if (input.id === "confirmFacts") state.factsConfirmed = input.checked;
  if (input.id === "confirmOrder") state.confirmed = input.checked;
  if (input.dataset.factId) input.checked ? state.acknowledged.add(input.dataset.factId) : state.acknowledged.delete(input.dataset.factId);
  if (input.name === "takeway") { state.takeWayCode = input.value; state.confirmed = false; const confirm = app.querySelector<HTMLInputElement>("#confirmOrder"); if (confirm) confirm.checked = false; }
});
async function restore() {
  let saved: Resume | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null") as Resume | null; } catch { /* 无存储时从欢迎页开始。 */ }
  if (!saved?.sessionId) { render(); return; }
  state.busy = true; render();
  try {
    applyData(await request<AppData>(`/api/state?sessionId=${encodeURIComponent(saved.sessionId)}`));
    state.selectedCandidate = state.data!.candidates.find((c) => c.id === saved!.candidateId && c.version === saved!.candidateVersion) ?? null;
    const validQuote = saved.quote?.sessionRevision === state.data!.session.revision && saved.quote?.candidateId === state.selectedCandidate?.id;
    if (validQuote) {
      state.quote = saved.quote; state.auth = saved.auth; state.order = saved.order; state.attempt = saved.attempt;
      state.frozen = saved.frozen; state.takeWayCode = saved.takeWayCode;
    }
    const maxStep = validQuote ? 4 : state.data!.candidates.length ? 3 : state.data!.session.selectedStore ? 2 : 1;
    state.step = Math.max(0, Math.min(Number(saved.step) || 0, maxStep));
    state.notice = { type: "info", text: "已恢复当前演示。下单确认与待确认事实需要重新勾选。" };
  } catch (error) {
    state.notice = { type: "info", text: error instanceof ApiError ? "演示数据已失效或服务已重启，请重新建局。" : "暂时无法恢复演示，请检查本地服务。" };
  } finally { state.busy = false; render(); }
}
void restore();
