// 本地体验菜单：价格为演示价；营养逐项引用 Skill 内的 MCP 快照，缺失项标为估算。
import nutritionSnapshot from "../../../maidajuSkill/data/mcp_nutrition.json";
import type { FactAttribute, ItemCategory, Nutrition } from "@/modules/catalog/types";

type Product = {
  code: string; name: string; price: number; emoji: string; category: ItemCategory;
  nutrition: Nutrition; main?: boolean; spicy?: boolean; sugary?: boolean;
  beef?: boolean; pork?: boolean; seafood?: boolean; meat?: boolean;
};
const nutrient = (name: string, fallback?: number[]): Nutrition => {
  const n = nutritionSnapshot.find((n) => n.name === name);
  return n ? { kcal: n.kcal, protein: n.protein_g, fat: n.fat_g, carb: n.carb_g, sodium: n.sodium_mg, estimated: false, source: `Skill · ${n.source} · ${n.name}` }
    : { kcal: fallback?.[0] ?? 350, protein: fallback?.[1] ?? 15, fat: fallback?.[2] ?? 14, carb: fallback?.[3] ?? 35, sodium: fallback?.[4] ?? 600, estimated: true, source: "同类餐品人工估算，非官方数据" };
};
export const DEMO_PRODUCTS: Product[] = [
  { code: "MOCK-BURGER", name: "香辣鸡腿堡", price: 2300, emoji: "🍔", category: "main", main: true, spicy: true, meat: true, nutrition: nutrient("麦辣鸡腿汉堡") },
  { code: "MOCK-BURGER-MILD", name: "板烧鸡腿堡", price: 2400, emoji: "🍔", category: "main", main: true, meat: true, nutrition: nutrient("板烧鸡腿堡") },
  { code: "MOCK-WRAP", name: "鸡肉卷", price: 1900, emoji: "🌯", category: "main", main: true, meat: true, nutrition: nutrient("鸡肉卷", [365, 20, 13, 40, 880]) },
  { code: "MOCK-BASIC", name: "汉堡包", price: 1400, emoji: "🍔", category: "main", main: true, beef: true, meat: true, nutrition: nutrient("汉堡包") },
  { code: "MOCK-BIGMAC", name: "巨无霸", price: 2700, emoji: "🍔", category: "main", main: true, beef: true, meat: true, nutrition: nutrient("巨无霸") },
  { code: "MOCK-FISH", name: "麦香鱼", price: 2200, emoji: "🐟", category: "main", main: true, seafood: true, meat: true, nutrition: nutrient("麦香鱼") },
  { code: "MOCK-PORK", name: "猪柳麦满分", price: 1800, emoji: "🥪", category: "main", main: true, pork: true, meat: true, nutrition: nutrient("猪柳麦满分") },
  { code: "MOCK-FRIES", name: "中份薯条", price: 1100, emoji: "🍟", category: "side", nutrition: nutrient("中薯条") },
  { code: "MOCK-NUGGETS", name: "麦乐鸡 5 块", price: 1300, emoji: "🍗", category: "side", meat: true, nutrition: nutrient("麦乐鸡5块") },
  { code: "MOCK-CORN", name: "小杯玉米杯", price: 700, emoji: "🌽", category: "side", nutrition: nutrient("小杯玉米杯") },
  { code: "MOCK-APPLE", name: "苹果片", price: 600, emoji: "🍎", category: "side", nutrition: nutrient("苹果片") },
  { code: "MOCK-COLA", name: "可乐中杯", price: 900, emoji: "🥤", category: "drink", sugary: true, nutrition: nutrient("可乐中杯") },
  { code: "MOCK-ZERO", name: "无糖可口可乐中杯", price: 900, emoji: "🥤", category: "drink", nutrition: nutrient("无糖可口可乐中杯") },
  { code: "MOCK-TEA", name: "锡兰红茶", price: 600, emoji: "🍵", category: "drink", nutrition: nutrient("锡兰红茶") },
  { code: "MOCK-COFFEE", name: "冰美式中杯", price: 1200, emoji: "☕", category: "drink", nutrition: nutrient("冰美式中杯") },
  { code: "MOCK-ICE", name: "圆筒冰淇淋", price: 600, emoji: "🍦", category: "dessert", nutrition: nutrient("圆筒冰淇淋") },
  { code: "MOCK-PIE", name: "香芋派", price: 800, emoji: "🥧", category: "dessert", nutrition: nutrient("香芋派") },
  { code: "MOCK-COMBO", name: "汉堡双享餐", price: 5900, emoji: "🍱", category: "combo", main: true, spicy: true, sugary: true, meat: true,
    nutrition: { kcal: 632, protein: 24, fat: 24, carb: 78, sodium: 1208, estimated: false, source: "Skill MCP 营养快照 · 默认香辣堡 + 可乐相加" } },
  { code: "MOCK-FIT-COMBO", name: "板烧无糖轻享餐", price: 2800, emoji: "🍱", category: "combo", main: true, meat: true,
    nutrition: { kcal: 444, protein: 25, fat: 18, carb: 43, sodium: 1077, estimated: false, source: "Skill MCP 营养快照 · 默认板烧堡 + 玉米杯 + 无糖可乐相加" } },
];
export const DEMO_STORES = { data: { stores: [
  { storeCode: "90000001", storeName: "人民广场体验店", address: "模拟路 1 号 · 演示门店", businessHours: "07:00–23:00（模拟）" },
  { storeCode: "90000002", storeName: "城市花园体验店", address: "模拟路 2 号 · 演示门店", businessHours: "08:00–22:00（模拟）" },
] } };
export const DEMO_MEALS = { data: { meals: DEMO_PRODUCTS.map((p) => ({ ...p, productType: p.category })) } };
export const DEMO_FACTS: Record<string, Record<FactAttribute, boolean>> = Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.code, {
  is_main: p.main === true, contains_spicy: p.spicy === true, is_sugary_drink: p.sugary === true,
  contains_beef: p.beef === true, contains_pork: p.pork === true, contains_seafood: p.seafood === true, contains_meat: p.meat === true,
}]));
export function demoDetail(code: string) {
  const p = DEMO_PRODUCTS.find((p) => p.code === code);
  const components = code === "MOCK-COMBO" ? ["MOCK-BURGER", "MOCK-COLA"] : code === "MOCK-FIT-COMBO" ? ["MOCK-BURGER-MILD", "MOCK-CORN", "MOCK-ZERO"] : [];
  return { data: { name: p?.name ?? code, supportModify: false, rounds: components.map((c, i) => ({
    round: String(i + 1), name: `搭配 ${i + 1}`, choices: [{ code: c, name: DEMO_PRODUCTS.find((p) => p.code === c)!.name, isDefault: 1 }],
  })) } };
}
