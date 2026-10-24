// 模拟数据（MOCK）：结构为假设形态，真实响应结构待 S2 联调核实。storeCode 为虚构数字。
export const MOCK_STORES = {
  data: {
    stores: [
      { storeCode: "90000001", storeName: "模拟门店A", address: "模拟路1号", businessHours: "07:00-23:00" },
      { storeCode: "90000002", storeName: "模拟门店B", address: "模拟路2号" },
      { storeCode: "MOCK-X", storeName: "非法编码门店" },
    ],
  },
};

export const MOCK_MEALS = {
  data: {
    categories: [
      {
        categoryName: "汉堡",
        meals: [
          { code: "MOCK-BURGER", name: "模拟香辣鸡腿堡", price: 2300, supportModify: 1 },
          { code: "MOCK-BURGER-MILD", name: "模拟板烧堡", price: 2400 },
        ],
      },
      {
        categoryName: "饮料",
        meals: [
          { code: "MOCK-COLA", name: "模拟可乐", price: 900, productType: "drink" },
          { code: "MOCK-ZERO", name: "模拟无糖可乐", price: 900, productType: "drink" },
        ],
      },
      { categoryName: "套餐", meals: [{ code: "MOCK-COMBO", name: "模拟双人餐", price: 5900, productType: "combo" }] },
    ],
  },
};

export const MOCK_COUPONS = { data: { coupons: [{ couponId: "MOCK-C1", couponCode: "MOCK-CC1", title: "模拟满减券" }] } };

export const MOCK_DETAIL = {
  data: {
    name: "模拟双人餐",
    supportModify: true,
    rounds: [
      {
        round: "1",
        name: "主食",
        choices: [
          { code: "MOCK-BURGER", name: "模拟香辣鸡腿堡", isDefault: 1, supportModify: true },
          { code: "MOCK-BURGER-MILD", name: "模拟板烧堡", isDefault: 0 },
        ],
      },
      { round: "2", name: "饮料", choices: [{ code: "MOCK-COLA", name: "模拟可乐", isDefault: 1 }] },
    ],
  },
};
