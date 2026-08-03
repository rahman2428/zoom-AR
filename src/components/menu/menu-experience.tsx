"use client";

import { AnimatePresence, motion } from "framer-motion";
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  configureAssetLoading,
  formatPrice,
  resolveDishAssets,
  selectPreloadDishes,
  warmDishForLaunch,
  warmMenuAssetsInBackground
} from "@/lib/ar/assets";
import { resolveRenderEngine } from "@/lib/ar/engines/resolve-engine";
import { openQuickLook } from "@/lib/ar/quick-look";
import type { CartItem, MenuCategory, MenuDish, PlateSize, RestaurantMenu } from "@/lib/menu/types";
import { useArCapabilities } from "@/hooks/use-ar-capabilities";
import { useQuickLookAvailability } from "@/hooks/use-quick-look-availability";
import { CameraArModal } from "@/components/rendering/camera-ar-modal";
import { RenderStage, type RenderStageHandle } from "@/components/rendering/render-stage";
import { CategoryTabs } from "./category-tabs";
import { OrderPanel } from "./order-panel";
import { OrderTracker } from "./order-tracker";
import { ActiveOrderBanner } from "./active-order-banner";

interface MenuExperienceProps {
  menu: RestaurantMenu;
}

function matchesDishQuery(query: string, dish: RestaurantMenu["dishes"][number]) {
  if (!query) {
    return true;
  }

  const searchableContent = [
    dish.name,
    dish.tagline,
    dish.description,
    dish.category,
    ...dish.ingredients
  ]
    .join(" ")
    .toLowerCase();

  return searchableContent.includes(query);
}

function buildInitialIndexes(menu: RestaurantMenu) {
  return menu.categories.reduce<Record<MenuCategory, number>>((indexes, category) => {
    indexes[category.id] = 0;
    return indexes;
  }, {} as Record<MenuCategory, number>);
}

function deriveHalfPlatePrice(fullPlatePriceInr: number) {
  return Math.max(120, Math.round((fullPlatePriceInr * 0.62) / 10) * 10);
}

function isSameOriginAssetUrl(url: string | null) {
  if (!url || typeof window === "undefined") {
    return true;
  }

  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

export function MenuExperience({ menu }: MenuExperienceProps) {
  const capabilities = useArCapabilities();
  const stageRef = useRef<RenderStageHandle | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<MenuCategory>(menu.categories[0].id);
  const [indexByCategory, setIndexByCategory] = useState<Record<MenuCategory, number>>(
    buildInitialIndexes(menu)
  );
  const [searchInput, setSearchInput] = useState("");
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [orderPanelOpen, setOrderPanelOpen] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [trackerOrderId, setTrackerOrderId] = useState<string | undefined>();
  const [trackerCustomerToken, setTrackerCustomerToken] = useState<string | undefined>();
  const [launchState, setLaunchState] = useState<"idle" | "launching">("idle");
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartPortion, setCartPortion] = useState<PlateSize>("full");
  const [cartToast, setCartToast] = useState<{ message: string; timestamp: number } | null>(null);
  const [fullScreen3D, setFullScreen3D] = useState(false);

  // Load persistent cart from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("zoom_ar_customer_cart_items");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setCartItems(parsed);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  function updateCartState(newCart: CartItem[]) {
    setCartItems(newCart);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("zoom_ar_customer_cart_items", JSON.stringify(newCart));
      } catch {
        // ignore
      }
    }
  }

  function handleAddToCart(dishToAdd: MenuDish, plateSize: PlateSize = "full") {
    const cartItemId = `${dishToAdd.id}-${plateSize}`;
    const unitPriceInr = plateSize === "full" ? dishToAdd.priceInr : deriveHalfPlatePrice(dishToAdd.priceInr);

    const existingIndex = cartItems.findIndex((item) => item.cartItemId === cartItemId);
    let updatedCart: CartItem[];

    if (existingIndex >= 0) {
      updatedCart = cartItems.map((item, idx) =>
        idx === existingIndex ? { ...item, quantity: item.quantity + 1 } : item
      );
    } else {
      const newItem: CartItem = {
        cartItemId,
        dishId: dishToAdd.id,
        dishName: dishToAdd.name,
        plateSize,
        quantity: 1,
        unitPriceInr
      };
      updatedCart = [...cartItems, newItem];
    }

    updateCartState(updatedCart);

    // Show confirmation toast
    setCartToast({
      message: `🛒 Added 1x ${dishToAdd.name} (${plateSize === "full" ? "Full" : "Half"}) to cart!`,
      timestamp: Date.now()
    });

    setTimeout(() => {
      setCartToast(null);
    }, 3500);
  }

  function handleUpdateCartQuantity(cartItemId: string, delta: number) {
    const updated = cartItems
      .map((item) => {
        if (item.cartItemId === cartItemId) {
          const newQty = item.quantity + delta;
          return newQty > 0 ? { ...item, quantity: newQty } : null;
        }
        return item;
      })
      .filter((item): item is CartItem => item !== null);

    updateCartState(updated);
  }

  function handleRemoveCartItem(cartItemId: string) {
    const updated = cartItems.filter((item) => item.cartItemId !== cartItemId);
    updateCartState(updated);
  }

  function handleClearCart() {
    updateCartState([]);
  }

  function handleOpenOrderPanel() {
    if (cartItems.length === 0 && currentDish) {
      handleAddToCart(currentDish, cartPortion);
    }
    setOrderPanelOpen(true);
  }

  const deferredSearchInput = useDeferredValue(searchInput);
  const normalizedSearchQuery = deferredSearchInput.trim().toLowerCase();
  const hasSearchQuery = normalizedSearchQuery.length > 0;

  const categoryMeta =
    menu.categories.find((category) => category.id === selectedCategory) ?? menu.categories[0];
  const selectedCategoryDishes =
    selectedCategory === "all"
      ? menu.dishes
      : menu.dishes.filter((dish) => dish.category === selectedCategory);
  const categoryDishes = selectedCategoryDishes.length > 0 ? selectedCategoryDishes : menu.dishes;
  const filteredDishes = hasSearchQuery
    ? categoryDishes.filter((dish) => matchesDishQuery(normalizedSearchQuery, dish))
    : categoryDishes;
  const hasSearchResults = filteredDishes.length > 0;
  const fallbackDish = (categoryDishes[0] ?? menu.dishes[0])!;
  const rawIndex = indexByCategory[selectedCategory] ?? 0;
  const currentIndex = hasSearchResults ? rawIndex % filteredDishes.length : 0;
  const currentDish = hasSearchResults ? filteredDishes[currentIndex] : fallbackDish;
  const fullPlatePrice = currentDish.priceInr;
  const halfPlatePrice = deriveHalfPlatePrice(currentDish.priceInr);
  const selectedCategoryIndex = menu.categories.findIndex((entry) => entry.id === selectedCategory);
  const activeCategoryIndex = selectedCategoryIndex < 0 ? 0 : selectedCategoryIndex;
  const categoryPositionLabel = `${String(activeCategoryIndex + 1).padStart(2, "0")} / ${String(
    menu.categories.length
  ).padStart(2, "0")}`;
  const preloadDishes = selectPreloadDishes(filteredDishes, currentIndex, capabilities);
  const assetSelection = resolveDishAssets(currentDish, filteredDishes, currentIndex, capabilities);
  const canProbeQuickLookAsset = isSameOriginAssetUrl(assetSelection.quickLookUsdz);
  const quickLookAvailability = useQuickLookAvailability(
    assetSelection.quickLookUsdz,
    capabilities.supportsQuickLook &&
      Boolean(assetSelection.quickLookUsdz) &&
      canProbeQuickLookAsset
  );
  const canTryQuickLook =
    capabilities.supportsQuickLook &&
    Boolean(assetSelection.quickLookUsdz) &&
    (!canProbeQuickLookAsset ||
      !quickLookAvailability.checked ||
      quickLookAvailability.available);
  const engine = resolveRenderEngine(capabilities, currentDish, {
    quickLookReady: canTryQuickLook
  });
  const searchResultLabel = hasSearchQuery
    ? `${filteredDishes.length} result${filteredDishes.length === 1 ? "" : "s"}`
    : `${categoryDishes.length} dishes`;
  const hasCameraFallback =
    capabilities.ready &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const hasNativeAr =
    engine.kind === "webxr"
      ? engine.canLaunch
      : Boolean(
          engine.kind === "quick-look" &&
            assetSelection.quickLookUsdz &&
            canTryQuickLook
        );
  const canOpenArView = hasSearchResults && (hasNativeAr || hasCameraFallback);

  function cycleDish(direction: 1 | -1) {
    if (!hasSearchResults || filteredDishes.length <= 1) {
      return;
    }

    setIndexByCategory((current) => ({
      ...current,
      [selectedCategory]:
        (current[selectedCategory] + direction + filteredDishes.length) % filteredDishes.length
    }));
  }

  function selectCategory(category: MenuCategory) {
    setSelectedCategory(category);
  }

  function cycleCategory(direction: 1 | -1) {
    const nextCategoryIndex =
      (activeCategoryIndex + direction + menu.categories.length) % menu.categories.length;
    setSelectedCategory(menu.categories[nextCategoryIndex].id);
  }

  async function launchPrimaryExperience() {
    if (launchState === "launching" || !hasSearchResults) {
      return;
    }

    if (engine.kind === "webxr") {
      setLaunchState("launching");
      await stageRef.current?.enterImmersiveAr();
      setLaunchState("idle");
      return;
    }

    if (
      engine.kind === "quick-look" &&
      assetSelection.quickLookUsdz &&
      canTryQuickLook
    ) {
      openQuickLook(assetSelection.quickLookUsdz, currentDish.name);
      return;
    }

    if (hasCameraFallback) {
      setCameraModalOpen(true);
    }
  }

  const capabilityCopy = capabilities.ready
    ? capabilities.supportsWebXR
      ? "Live WebXR AR ready"
      : capabilities.supportsQuickLook
        ? canTryQuickLook
          ? "Native iPhone AR ready"
          : "Camera AR preview ready"
        : hasCameraFallback
          ? "Camera AR preview ready"
          : "3D preview active"
    : "Checking device";
  const arButtonLabel =
    launchState === "launching"
      ? "Preparing AR..."
      : !hasSearchResults
        ? "No Dish Matched"
        : canOpenArView
        ? "AR On Mobile"
        : "3D Preview Active";

  useEffect(() => {
    if (!capabilities.ready) {
      return;
    }

    configureAssetLoading(capabilities);
  }, [capabilities]);

  useEffect(() => {
    if (!capabilities.ready) {
      return;
    }

    warmMenuAssetsInBackground(menu.dishes, capabilities, currentIndex);
  }, [capabilities, menu.dishes, currentIndex]);

  useEffect(() => {
    if (!hasSearchResults) {
      return;
    }

    warmDishForLaunch(currentDish, capabilities, { priority: "active" });
    preloadDishes
      .filter((dish) => dish.id !== currentDish.id)
      .forEach((dish) => {
        warmDishForLaunch(dish, capabilities, { priority: "adjacent" });
      });
  }, [capabilities, currentDish, hasSearchResults, preloadDishes]);

  return (
    <main className="experience-shell">
      <div className="experience-aura experience-aura--left" />
      <div className="experience-aura experience-aura--right" />

      <header className="experience-header">
        <div className="brand-block">
          <strong>{menu.brand.toUpperCase()}</strong>
          <span>Immersive dining preview</span>
        </div>

        <div className="experience-header__center">
          <CategoryTabs
            categories={menu.categories}
            selectedCategory={selectedCategory}
            onSelectCategory={selectCategory}
          />
        </div>

        <div className="experience-header__actions">
          {cartItems.length > 0 ? (
            <button
              className="cart-header-pill"
              onClick={handleOpenOrderPanel}
              type="button"
            >
              🛒 Cart ({cartItems.reduce((acc, i) => acc + i.quantity, 0)} • ₹{cartItems.reduce((acc, i) => acc + i.unitPriceInr * i.quantity, 0)})
            </button>
          ) : null}
          <button
            className="tracker-link-pill"
            onClick={() => setTrackerOpen(true)}
            type="button"
          >
            📍 Track Order
          </button>
          <button
            className="interactive-pill full-screen-trigger-btn"
            onClick={() => setFullScreen3D(true)}
            type="button"
          >
            ⛶ 3D Full Screen
          </button>
        </div>
      </header>

      <section className="experience-search glass-panel">
        <div className="experience-search__field">
          <span aria-hidden className="experience-search__icon">
            Search
          </span>
          <input
            aria-label="Search dishes"
            className="experience-search__input"
            onChange={(event) => {
              const value = event.currentTarget.value;
              startTransition(() => {
                setSearchInput(value);
              });
            }}
            placeholder="Search dish, ingredient, or style..."
            type="search"
            value={searchInput}
          />
          {searchInput ? (
            <button
              aria-label="Clear search"
              className="experience-search__clear"
              onClick={() => {
                setSearchInput("");
              }}
              type="button"
            >
              Clear
            </button>
          ) : null}
        </div>
        <span className="experience-search__meta">
          {hasSearchQuery
            ? `${searchResultLabel} in ${categoryMeta.label}`
            : `Browsing ${searchResultLabel} in ${categoryMeta.label}`}
        </span>
      </section>

      {/* Main Experience Layout (Responsive Split Grid on Desktop) */}
      <div className="experience-main-layout">
        <section className="experience-stage">
          {hasSearchResults ? (
            <RenderStage
              ref={stageRef}
              capabilities={capabilities}
              currentIndex={currentIndex}
              dish={currentDish}
              engine={engine}
              onNext={() => cycleDish(1)}
              onPrevious={() => cycleDish(-1)}
              preloadDishes={preloadDishes}
              totalCount={filteredDishes.length}
            />
          ) : (
            <div className="search-empty glass-panel">
              <strong>{`No dish matched "${searchInput.trim()}"`}</strong>
              <p>Try a broader keyword like burger, pizza, veg, or dessert.</p>
              <button
                className="search-empty__action"
                onClick={() => {
                  setSearchInput("");
                }}
                type="button"
              >
                Clear Search
              </button>
            </div>
          )}
        </section>

        <AnimatePresence mode="wait">
          <motion.article
            key={currentDish.id}
            animate={{ opacity: 1, y: 0 }}
            className="dish-summary glass-panel"
            exit={{ opacity: 0, y: 15 }}
            initial={{ opacity: 0, y: 15 }}
            transition={{ duration: 0.25 }}
          >
            <div className="dish-summary__header">
              <div>
                <span
                  className={`dish-summary__badge dish-summary__badge--${currentDish.category}`}
                >
                  {currentDish.category === "veg"
                    ? "Pure Vegetarian"
                    : currentDish.category === "non-veg"
                    ? "Non-Vegetarian"
                    : "Chef Special"}
                </span>
                <h3>{currentDish.name}</h3>
              </div>
              <strong className="dish-summary__price">{formatPrice(fullPlatePrice)}</strong>
            </div>

            <p className="dish-summary__tagline">{currentDish.tagline}</p>
            <p className="dish-summary__description">{currentDish.description}</p>

            <div className="dish-summary__meta">
              <div className="meta-item">
                <span className="meta-label">Calories</span>
                <strong className="meta-value">{currentDish.calories} kcal</strong>
              </div>
              <div className="meta-item">
                <span className="meta-label">Category</span>
                <strong className="meta-value">{categoryMeta.label}</strong>
              </div>
            </div>

            <div className="dish-summary__plate-pricing">
              <span className="dish-summary__plate-pricing-label">Select Portion & Add to Order</span>
              <div className="dish-summary__portion-selector">
                <button
                  type="button"
                  className={cartPortion === "full" ? "is-selected" : ""}
                  onClick={() => setCartPortion("full")}
                >
                  Full ({formatPrice(fullPlatePrice)})
                </button>
                <button
                  type="button"
                  className={cartPortion === "half" ? "is-selected" : ""}
                  onClick={() => setCartPortion("half")}
                >
                  Half ({formatPrice(halfPlatePrice)})
                </button>
              </div>
              <button
                type="button"
                className="dish-summary__add-cart-btn"
                onClick={() => handleAddToCart(currentDish, cartPortion)}
              >
                🛒 Add {currentDish.name} to Cart
              </button>
            </div>

            <p className="dish-summary__ingredients">
              <strong>Ingredients: </strong>
              {currentDish.ingredients.join(" · ")}
            </p>
            <p className="dish-summary__status">
              {capabilityCopy} | {engine.headline}
            </p>
          </motion.article>
        </AnimatePresence>
      </div>

      {/* Cart Addition Toast Popup (Fixed at top) */}
      <AnimatePresence>
        {cartToast ? (
          <motion.div
            className="cart-add-toast"
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            onClick={handleOpenOrderPanel}
          >
            <span className="toast-icon">🛒</span>
            <div className="toast-content">
              <span>{cartToast.message}</span>
              <strong className="toast-checkout-link">View Cart & Checkout →</strong>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <footer className="experience-footer">
        <div className="experience-footer__actions">
          <button
            className="experience-footer__launch"
            disabled={!canOpenArView || launchState === "launching"}
            onClick={() => {
              void launchPrimaryExperience();
            }}
            type="button"
          >
            {arButtonLabel}
          </button>
          <button
            className="experience-footer__order"
            disabled={!hasSearchResults}
            onClick={handleOpenOrderPanel}
            type="button"
          >
            🛒 View Cart ({cartItems.reduce((acc, i) => acc + i.quantity, 0)})
          </button>
        </div>

        <div className="experience-footer__quick-controls">
          <button
            aria-label="Previous category"
            className="experience-footer__round-button"
            onClick={() => cycleCategory(-1)}
            type="button"
          >
            {"<"}
          </button>
          <button
            aria-label="Next category"
            className="experience-footer__round-button"
            onClick={() => cycleCategory(1)}
            type="button"
          >
            {">"}
          </button>
        </div>

        <span className="experience-footer__collection">{categoryPositionLabel} Collections</span>
      </footer>

      <CameraArModal
        capabilities={capabilities}
        dish={currentDish}
        onClose={() => setCameraModalOpen(false)}
        open={cameraModalOpen}
      />
      {orderPanelOpen ? (
        <OrderPanel
          cartItems={cartItems}
          onClose={() => setOrderPanelOpen(false)}
          onUpdateQuantity={handleUpdateCartQuantity}
          onRemoveItem={handleRemoveCartItem}
          onAddMoreItems={() => setOrderPanelOpen(false)}
          onClearCart={handleClearCart}
          onTrackOrder={(orderId, customerToken) => {
            setTrackerOrderId(orderId);
            setTrackerCustomerToken(customerToken);
            setTrackerOpen(true);
          }}
        />
      ) : null}
      {trackerOpen ? (
        <OrderTracker
          initialOrderId={trackerOrderId}
          initialToken={trackerCustomerToken}
          onClose={() => setTrackerOpen(false)}
        />
      ) : null}
      <ActiveOrderBanner
        isModalOpen={orderPanelOpen || trackerOpen || fullScreen3D || cameraModalOpen}
        onOpenTracker={(orderId, customerToken) => {
          setTrackerOrderId(orderId);
          setTrackerCustomerToken(customerToken);
          setTrackerOpen(true);
        }}
      />

      {/* 3D Full Screen Viewport Modal */}
      {fullScreen3D ? (
        <div className="fullscreen-3d-backdrop" role="dialog" aria-modal="true">
          <div className="fullscreen-3d-topbar">
            <div className="fullscreen-3d-title">
              <span className={`dish-summary__badge dish-summary__badge--${currentDish.category}`}>
                {currentDish.category === "veg"
                  ? "Pure Vegetarian"
                  : currentDish.category === "non-veg"
                  ? "Non-Vegetarian"
                  : "Chef Special"}
              </span>
              <h3>{currentDish.name}</h3>
              <strong className="fullscreen-3d-price">{formatPrice(fullPlatePrice)}</strong>
            </div>

            <button
              type="button"
              className="fullscreen-3d-close-btn"
              onClick={() => setFullScreen3D(false)}
            >
              ✕ Exit Fullscreen
            </button>
          </div>

          <div className="fullscreen-3d-stage-wrap">
            <RenderStage
              ref={stageRef}
              capabilities={capabilities}
              currentIndex={currentIndex}
              dish={currentDish}
              engine={engine}
              onNext={() => cycleDish(1)}
              onPrevious={() => cycleDish(-1)}
              preloadDishes={preloadDishes}
              totalCount={filteredDishes.length}
            />
          </div>

          <div className="fullscreen-3d-bottombar">
            <div className="fullscreen-3d-portions">
              <button
                type="button"
                className={cartPortion === "full" ? "is-selected" : ""}
                onClick={() => setCartPortion("full")}
              >
                Full ({formatPrice(fullPlatePrice)})
              </button>
              <button
                type="button"
                className={cartPortion === "half" ? "is-selected" : ""}
                onClick={() => setCartPortion("half")}
              >
                Half ({formatPrice(halfPlatePrice)})
              </button>
            </div>

            <button
              type="button"
              className="fullscreen-3d-add-btn"
              onClick={() => {
                handleAddToCart(currentDish, cartPortion);
                setFullScreen3D(false);
                handleOpenOrderPanel();
              }}
            >
              🛒 Add to Cart & Checkout ({cartPortion === "full" ? formatPrice(fullPlatePrice) : formatPrice(halfPlatePrice)})
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
