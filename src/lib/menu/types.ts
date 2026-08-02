export type MenuCategory = "all" | "veg" | "non-veg" | "veg-non-veg" | "dessert";

export type FallbackDishKind =
  | "salad"
  | "pizza"
  | "pizza1"
  | "pasta"
  | "dumplings"
  | "platter"
  | "burger"
  | "dessert";

export interface DishAssetSet {
  glb?: string;
  usdz?: string;
  usdzReady: boolean;
}

export interface DishVisualConfig {
  targetSize: number;
  arScale: number;
  pedestalHeight: number;
  baseRotationDeg: number;
  fallbackKind: FallbackDishKind;
  accentColor: string;
}

export interface MenuDish {
  id: string;
  slug: string;
  name: string;
  category: MenuCategory;
  tagline: string;
  description: string;
  priceInr: number;
  calories: number;
  ingredients: string[];
  assets: DishAssetSet;
  visual: DishVisualConfig;
}

export interface MenuCategoryDefinition {
  id: MenuCategory;
  label: string;
  eyebrow: string;
  description: string;
}

export interface RestaurantMenu {
  brand: string;
  headline: string;
  subheadline: string;
  categories: MenuCategoryDefinition[];
  dishes: MenuDish[];
}

export type PlateSize = "half" | "full";

export type OrderStatus = "new" | "preparing" | "ready" | "completed";

export type PaymentMethod = "upi" | "card" | "netbanking" | "desk";

export interface OrderItem {
  dishId: string;
  dishName: string;
  plateSize: PlateSize;
  quantity: number;
  unitPriceInr: number;
}

export interface RestaurantOrder {
  orderId: string;
  customerToken?: string;
  transactionId?: string;
  paymentSignature?: string;
  tableNumber: string;
  chairCode?: string;
  location: string;
  customerName: string;
  mobileNumber: string;
  items: OrderItem[];
  totalInr: number;
  status: OrderStatus;
  paymentStatus: "paid";
  paymentMethod?: PaymentMethod;
  utrNumber?: string;
  payeeUpi?: string;
  createdAt: string;
}

