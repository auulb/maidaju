// 演示专用数据：所有属性均为人为设定，不代表麦当劳真实商品信息。
import type { FactAttribute } from "@/modules/catalog/types";

export const DEMO_PRODUCTS = [
  { code: "MOCK-BURGER", name: "香辣鸡腿堡（模拟）", price: 2300, emoji: "🍔", main: true, spicy: true },
  { code: "MOCK-BURGER-MILD", name: "板烧鸡腿堡（模拟）", price: 2400, emoji: "🍔", main: true },
  { code: "MOCK-WRAP", name: "鸡肉卷（模拟）", price: 1900, emoji: "🌯", main: true },
  { code: "MOCK-FRIES", name: "中份薯条（模拟）", price: 1100, emoji: "🍟" },
  { code: "MOCK-COLA", name: "可乐（模拟）", price: 900, emoji: "🥤", sugary: true },
  { code: "MOCK-ZERO", name: "零糖可乐（模拟）", price: 900, emoji: "🥤" },
  { code: "MOCK-COMBO", name: "汉堡双享餐（模拟）", price: 5900, emoji: "🍱", combo: true, spicy: true, sugary: true },
] satisfies { code: string; name: string; price: number; emoji: string; main?: boolean; spicy?: boolean; sugary?: boolean; combo?: boolean }[];

export const DEMO_STORES = {
  data: { stores: [
    { storeCode: "90000001", storeName: "人民广场体验店（模拟）", address: "模拟路 1 号 · 非真实餐厅", businessHours: "07:00–23:00（模拟）" },
    { storeCode: "90000002", storeName: "城市花园体验店（模拟）", address: "模拟路 2 号 · 非真实餐厅", businessHours: "08:00–22:00（模拟）" },
  ] },
};
export const DEMO_MEALS = { data: { meals: DEMO_PRODUCTS.map((p) => ({ ...p, productType: "combo" in p ? "combo" : "single" })) } };
export const DEMO_FACTS: Record<string, Record<FactAttribute, boolean>> = Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.code, {
  is_main: "main" in p && p.main === true,
  contains_spicy: "spicy" in p && p.spicy === true,
  is_sugary_drink: "sugary" in p && p.sugary === true,
  contains_beef: false,
  contains_pork: false,
  contains_seafood: false,
}]));

export function demoDetail(code: string) {
  const p = DEMO_PRODUCTS.find((p) => p.code === code);
  return { data: { name: p?.name ?? code, supportModify: false, rounds: code === "MOCK-COMBO" ? [
    { round: "1", name: "汉堡", choices: [{ code: "MOCK-BURGER", name: "香辣鸡腿堡（模拟）", isDefault: 1 }] },
    { round: "2", name: "饮料", choices: [{ code: "MOCK-COLA", name: "可乐（模拟）", isDefault: 1 }] },
  ] : [] } };
}
