import type { DeviceCapabilities } from "./capabilities";
import { gltfAssetCache } from "./asset-cache";
import type { MenuDish } from "@/lib/menu/types";

export interface DishAssetSelection {
  previewGlb: string | null;
  quickLookUsdz: string | null;
  quickLookReady: boolean;
  preloadGlbs: string[];
}

interface NetworkHints {
  saveData: boolean;
  effectiveType: string | null;
  downlinkMbps: number | null;
}

interface WarmDishOptions {
  priority?: "active" | "adjacent";
}

interface AssetLoadingProfile {
  maxResolvedEntries: number;
  preloadConcurrency: number;
  binaryPreloadConcurrency: number;
  backgroundGlbBudget: number;
  backgroundUsdzBudget: number;
  immediateGlbWarm: number;
  immediateUsdzWarm: number;
}

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean;
    effectiveType?: string;
    downlink?: number;
  };
};

function readNetworkHints(): NetworkHints {
  if (typeof navigator === "undefined") {
    return {
      saveData: false,
      effectiveType: null,
      downlinkMbps: null
    };
  }

  const connection = (navigator as NavigatorWithConnection).connection;

  return {
    saveData: Boolean(connection?.saveData),
    effectiveType: connection?.effectiveType ?? null,
    downlinkMbps:
      typeof connection?.downlink === "number" && Number.isFinite(connection.downlink)
        ? connection.downlink
        : null
  };
}

function shouldConstrainPreload(capabilities: DeviceCapabilities) {
  const hints = readNetworkHints();
  const slowEffectiveType =
    hints.effectiveType === "slow-2g" ||
    hints.effectiveType === "2g" ||
    hints.effectiveType === "3g";
  const slowDownlink = hints.downlinkMbps !== null && hints.downlinkMbps > 0 && hints.downlinkMbps < 1.6;

  return (
    capabilities.performanceTier === "constrained" ||
    hints.saveData ||
    slowEffectiveType ||
    slowDownlink
  );
}

function resolveAssetLoadingProfile(capabilities: DeviceCapabilities): AssetLoadingProfile {
  const constrained = shouldConstrainPreload(capabilities);

  if (constrained) {
    return {
      maxResolvedEntries: 4,
      preloadConcurrency: 1,
      binaryPreloadConcurrency: 1,
      backgroundGlbBudget: 0,
      backgroundUsdzBudget: 0,
      immediateGlbWarm: 1,
      immediateUsdzWarm: 1
    };
  }

  if (capabilities.isMobile) {
    return {
      maxResolvedEntries: capabilities.performanceTier === "high" ? 8 : 6,
      preloadConcurrency: 1,
      binaryPreloadConcurrency: 1,
      backgroundGlbBudget: 0,
      backgroundUsdzBudget: 0,
      immediateGlbWarm: 1,
      immediateUsdzWarm: 1
    };
  }

  if (capabilities.performanceTier === "high") {
    return {
      maxResolvedEntries: 18,
      preloadConcurrency: 3,
      binaryPreloadConcurrency: 2,
      backgroundGlbBudget: 20,
      backgroundUsdzBudget: 8,
      immediateGlbWarm: 4,
      immediateUsdzWarm: 2
    };
  }

  if (capabilities.performanceTier === "balanced") {
    return {
      maxResolvedEntries: 12,
      preloadConcurrency: 2,
      binaryPreloadConcurrency: 2,
      backgroundGlbBudget: 12,
      backgroundUsdzBudget: 5,
      immediateGlbWarm: 3,
      immediateUsdzWarm: 1
    };
  }

  return {
    maxResolvedEntries: 6,
    preloadConcurrency: 1,
    binaryPreloadConcurrency: 1,
    backgroundGlbBudget: 6,
    backgroundUsdzBudget: 2,
    immediateGlbWarm: 2,
    immediateUsdzWarm: 1
  };
}

export function configureAssetLoading(capabilities: DeviceCapabilities) {
  const profile = resolveAssetLoadingProfile(capabilities);
  gltfAssetCache.configure({
    maxResolvedEntries: profile.maxResolvedEntries,
    preloadConcurrency: profile.preloadConcurrency,
    binaryPreloadConcurrency: profile.binaryPreloadConcurrency
  });
  return profile;
}

function uniqueDishList(dishes: MenuDish[]) {
  const seen = new Set<string>();
  const result: MenuDish[] = [];

  dishes.forEach((dish) => {
    if (seen.has(dish.id)) {
      return;
    }

    seen.add(dish.id);
    result.push(dish);
  });

  return result;
}

function orderDishesFromIndex(dishes: MenuDish[], currentIndex: number) {
  if (dishes.length <= 1) {
    return dishes;
  }

  return dishes.map((_, offset) => dishes[(currentIndex + offset) % dishes.length]);
}

export function getAdjacentDishes(dishes: MenuDish[], currentIndex: number): MenuDish[] {
  if (dishes.length <= 1) {
    return dishes;
  }

  const previous = dishes[(currentIndex - 1 + dishes.length) % dishes.length];
  const current = dishes[currentIndex];
  const next = dishes[(currentIndex + 1) % dishes.length];

  return [previous, current, next];
}

export function selectPreloadDishes(
  dishes: MenuDish[],
  currentIndex: number,
  capabilities: DeviceCapabilities
) {
  if (dishes.length === 0) {
    return [];
  }

  const previous = dishes[(currentIndex - 1 + dishes.length) % dishes.length];
  const current = dishes[currentIndex];
  const next = dishes[(currentIndex + 1) % dishes.length];
  const constrained = shouldConstrainPreload(capabilities);

  if (constrained) {
    return [current];
  }

  if (capabilities.isMobile) {
    return uniqueDishList([current, next]);
  }

  return uniqueDishList([previous, current, next]);
}

export function resolveDishAssets(
  dish: MenuDish,
  dishes: MenuDish[],
  currentIndex: number,
  capabilities: DeviceCapabilities
): DishAssetSelection {
  const neighbors = getAdjacentDishes(dishes, currentIndex);
  const preloadGlbs =
    capabilities.performanceTier === "constrained"
      ? [dish.assets.glb].filter(Boolean) as string[]
      : neighbors
          .map((entry) => entry.assets.glb)
          .filter((value): value is string => Boolean(value));

  return {
    previewGlb: dish.assets.glb ?? null,
    quickLookUsdz: dish.assets.usdz ?? null,
    quickLookReady: dish.assets.usdzReady,
    preloadGlbs
  };
}

function runWhenBrowserIsIdle(task: () => void) {
  if (typeof window === "undefined") {
    return;
  }

  const idleCallback = (
    window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  if (idleCallback) {
    idleCallback(task, { timeout: 1800 });
    return;
  }

  window.setTimeout(task, 260);
}

function uniqueAssetUrls(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function warmDishForLaunch(
  dish: MenuDish,
  capabilities: DeviceCapabilities,
  options?: WarmDishOptions
) {
  const profile = resolveAssetLoadingProfile(capabilities);
  const constrained = shouldConstrainPreload(capabilities);
  const priority = options?.priority ?? "active";
  const queuePriority = priority === "active" ? "high" : "low";

  if (dish.assets.glb) {
    if (constrained && priority === "adjacent") {
      gltfAssetCache.preloadBinary(dish.assets.glb, { priority: "low" });
    } else {
      gltfAssetCache.preload(dish.assets.glb, { priority: queuePriority });
    }
  }

  if (
    capabilities.supportsQuickLook &&
    dish.assets.usdz &&
    (!constrained || priority === "active" || profile.maxResolvedEntries >= 8)
  ) {
    gltfAssetCache.preloadBinary(dish.assets.usdz, { priority: queuePriority });
  }
}

export function warmMenuAssetsInBackground(
  dishes: MenuDish[],
  capabilities: DeviceCapabilities,
  currentIndex: number
) {
  const profile = resolveAssetLoadingProfile(capabilities);

  if (dishes.length === 0) {
    return;
  }

  // Keep initial UX fast on mobile and on slow networks.
  if (capabilities.isMobile || profile.backgroundGlbBudget <= 0) {
    return;
  }

  const orderedDishes = orderDishesFromIndex(dishes, currentIndex);
  const glbUrls = uniqueAssetUrls(orderedDishes.map((dish) => dish.assets.glb)).slice(
    0,
    profile.backgroundGlbBudget
  );

  if (glbUrls.length === 0) {
    return;
  }

  const immediateCount = Math.min(profile.immediateGlbWarm, glbUrls.length);
  const immediateUrls = glbUrls.slice(0, immediateCount);
  const deferredUrls = glbUrls.slice(immediateCount);

  immediateUrls.forEach((url) => {
    gltfAssetCache.preload(url, { priority: "low" });
  });

  runWhenBrowserIsIdle(() => {
    if (deferredUrls.length > 0) {
      gltfAssetCache.preloadMany(deferredUrls, profile.preloadConcurrency);
    }
  });

  if (!capabilities.supportsQuickLook) {
    return;
  }

  const usdzUrls = uniqueAssetUrls(orderedDishes.map((dish) => dish.assets.usdz)).slice(
    0,
    profile.backgroundUsdzBudget
  );

  if (usdzUrls.length === 0) {
    return;
  }

  const immediateUsdz = usdzUrls.slice(0, Math.min(profile.immediateUsdzWarm, usdzUrls.length));
  const deferredUsdz = usdzUrls.slice(immediateUsdz.length);

  immediateUsdz.forEach((url) => {
    gltfAssetCache.preloadBinary(url, { priority: "low" });
  });

  runWhenBrowserIsIdle(() => {
    if (deferredUsdz.length > 0) {
      gltfAssetCache.preloadBinaryMany(deferredUsdz, profile.binaryPreloadConcurrency);
    }
  });
}

export function formatPrice(priceInr: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(priceInr);
}
