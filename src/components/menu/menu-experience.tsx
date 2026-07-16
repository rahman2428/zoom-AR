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
import type { MenuCategory, RestaurantMenu } from "@/lib/menu/types";
import { useArCapabilities } from "@/hooks/use-ar-capabilities";
import { useQuickLookAvailability } from "@/hooks/use-quick-look-availability";
import { CameraArModal } from "@/components/rendering/camera-ar-modal";
import { RenderStage, type RenderStageHandle } from "@/components/rendering/render-stage";
import { CategoryTabs } from "./category-tabs";

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
  const [launchState, setLaunchState] = useState<"idle" | "launching">("idle");
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
  const dishCountLabel = hasSearchResults
    ? `${String(currentIndex + 1).padStart(2, "0")} / ${String(filteredDishes.length).padStart(2, "0")}`
    : "00 / 00";
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
  const dishNameParts = currentDish.name.split(" ");
  const dishLeadWord = dishNameParts[0] ?? currentDish.name;
  const dishTrailingWords = dishNameParts.slice(1).join(" ");

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

        <span className="interactive-pill">3D Interactive</span>
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

      <section className="dish-summary">
        <AnimatePresence mode="wait">
          <motion.article
            key={currentDish.id}
            className="dish-summary__card"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <span className="dish-summary__index">{dishCountLabel}</span>

            <h1 className="dish-summary__title">
              <span>{dishLeadWord}</span>
              {dishTrailingWords ? <em>{` ${dishTrailingWords}`}</em> : null}
            </h1>

            <p className="dish-summary__subtitle">{currentDish.tagline}</p>
            <p className="dish-summary__description">{currentDish.description}</p>

            <div className="dish-summary__metrics">
              <div>
                <span>Price</span>
                <strong>{formatPrice(currentDish.priceInr)}</strong>
              </div>
              <div>
                <span>Calories</span>
                <strong>{currentDish.calories} kcal</strong>
              </div>
              <div>
                <span>Type</span>
                <strong>{categoryMeta.label}</strong>
              </div>
            </div>

            <div className="dish-summary__plate-pricing">
              <span className="dish-summary__plate-pricing-label">Plate Pricing</span>
              <div className="dish-summary__plate-pricing-values">
                <p>
                  Full Plate <strong>{formatPrice(fullPlatePrice)}</strong>
                </p>
                <p>
                  Half Plate <strong>{formatPrice(halfPlatePrice)}</strong>
                </p>
              </div>
            </div>

            <p className="dish-summary__ingredients">{currentDish.ingredients.join(" | ")}</p>
            <p className="dish-summary__status">
              {capabilityCopy} | {engine.headline}
            </p>
          </motion.article>
        </AnimatePresence>
      </section>

      <footer className="experience-footer">
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
    </main>
  );
}
