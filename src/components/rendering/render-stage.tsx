"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type TouchEvent
} from "react";
import type { DeviceCapabilities } from "@/lib/ar/capabilities";
import type { RenderEngineDescriptor } from "@/lib/ar/engines/types";
import { ThreeStageController } from "@/lib/ar/three-stage";
import type { MenuDish } from "@/lib/menu/types";

const DISH_LOADING_COPY = "Please wait, AR food is loading.";

export interface RenderStageHandle {
  enterImmersiveAr: () => Promise<boolean>;
}

interface RenderStageProps {
  dish: MenuDish;
  preloadDishes: MenuDish[];
  engine: RenderEngineDescriptor;
  capabilities: DeviceCapabilities;
  currentIndex: number;
  totalCount: number;
  onPrevious: () => void;
  onNext: () => void;
}

export const RenderStage = forwardRef<RenderStageHandle, RenderStageProps>(function RenderStage(
  { dish, preloadDishes, engine, capabilities, currentIndex, totalCount, onPrevious, onNext },
  ref
) {
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ThreeStageController | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [loadingDish, setLoadingDish] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [controllerGeneration, setControllerGeneration] = useState(0);

  useEffect(() => {
    if (!stageContainerRef.current) {
      return;
    }

    stageContainerRef.current.querySelectorAll("canvas.stage-canvas").forEach((canvas) => {
      canvas.remove();
    });

    const controller = new ThreeStageController(
      stageContainerRef.current,
      {
        performanceTier: capabilities.performanceTier,
        platform: capabilities.platform,
        prefersReducedMotion: capabilities.prefersReducedMotion
      },
      {
        onError: setStageError,
        onSessionStateChange: setSessionActive
      }
    );
    controllerRef.current = controller;
    setControllerGeneration((current) => current + 1);

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [capabilities.performanceTier, capabilities.platform, capabilities.prefersReducedMotion]);

  useEffect(() => {
    if (controllerGeneration === 0 || !controllerRef.current) {
      return;
    }

    let cancelled = false;
    setLoadingDish(true);

    void controllerRef.current
      .setDish(dish)
      .catch(() => {
        if (!cancelled) {
          setStageError("Unable to load this dish in AR. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDish(false);
        }
      });

    return () => {
      cancelled = true;
    };
   }, [controllerGeneration, dish]);

  useEffect(() => {
     if (controllerGeneration === 0) {
      return;
    }

    preloadDishes.forEach((entry) => controllerRef.current?.preloadDish(entry));
   }, [controllerGeneration, preloadDishes]);

  useImperativeHandle(
    ref,
    () => ({
      enterImmersiveAr: async () => {
        return (await controllerRef.current?.enterImmersiveAr()) ?? false;
      }
    }),
    []
  );

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.changedTouches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = swipeStartRef.current;

    if (!start) {
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;

    if (Math.abs(deltaX) > 56 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
      if (deltaX > 0) {
        onNext();
      } else {
        onPrevious();
      }
    }

    swipeStartRef.current = null;
  }

  const helperCopy = sessionActive
    ? "Move your device to detect a surface, then tap to place the dish."
    : capabilities.hasTouch
      ? "Swipe to browse, drag to rotate, and use Open AR View for the live camera experience."
      : "Drag to orbit, scroll to zoom, and use Open AR View to launch the live AR experience.";
  const dotCount = Math.min(totalCount, 8);
  const normalizedDotIndex =
    totalCount <= 1
      ? 0
      : Math.round((currentIndex / (totalCount - 1)) * (dotCount - 1));

  return (
    <div
      aria-label={`${dish.name} interactive preview`}
      className="glass-panel stage-shell"
      onTouchEnd={handleTouchEnd}
      onTouchStart={handleTouchStart}
      role="region"
    >
      <div ref={stageContainerRef} className="stage-shell__canvas-wrap" />

      <div className="stage-overlay">
        {loadingDish ? <div className="stage-loading glass-panel">{DISH_LOADING_COPY}</div> : null}

        <div className="stage-status">
          <span className="stage-engine-pill">{engine.badge}</span>
          <p>{helperCopy}</p>
        </div>

        <div className="stage-controls">
          <div aria-hidden="true" className="stage-controls__arc" />

          <button
            aria-label="Previous dish"
            className="stage-nav stage-nav--left"
            onClick={onPrevious}
            type="button"
          >
            <span aria-hidden="true">{"<"}</span>
          </button>

          <div className="stage-dots" role="presentation">
            {Array.from({ length: dotCount }, (_, dotIndex) => (
              <span
                className={`stage-dot${normalizedDotIndex === dotIndex ? " is-active" : ""}`}
                key={dotIndex}
              />
            ))}
          </div>

          <button
            aria-label="Next dish"
            className="stage-nav stage-nav--right"
            onClick={onNext}
            type="button"
          >
            <span aria-hidden="true">{">"}</span>
          </button>
        </div>

        {stageError ? <div className="stage-toast">{stageError}</div> : null}
      </div>
    </div>
  );
});
