"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { OrderStatus, RestaurantOrder } from "@/lib/menu/types";
import { playStageSound } from "@/lib/sounds";

interface ActiveOrderBannerProps {
  onOpenTracker: (orderId: string, customerToken?: string) => void;
}

const STATUS_CONFIG: Record<
  OrderStatus,
  { title: string; subtitle: string; icon: string; badgeClass: string }
> = {
  new: {
    title: "Order Received",
    subtitle: "Paid & queued for the kitchen staff.",
    icon: "📋",
    badgeClass: "banner-badge--new"
  },
  preparing: {
    title: "Preparing in Kitchen",
    subtitle: "Chef is actively crafting your dish now!",
    icon: "👨‍🍳",
    badgeClass: "banner-badge--prep"
  },
  ready: {
    title: "Ready for Table!",
    subtitle: "Plated & being brought to your table now!",
    icon: "🔔",
    badgeClass: "banner-badge--ready"
  },
  completed: {
    title: "Served & Enjoy!",
    subtitle: "Order completed. Have a wonderful meal!",
    icon: "✔",
    badgeClass: "banner-badge--completed"
  }
};

export function ActiveOrderBanner({ onOpenTracker }: ActiveOrderBannerProps) {
  const [activeOrder, setActiveOrder] = useState<RestaurantOrder | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const prevStatusRef = useRef<OrderStatus | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function pollActiveOrder() {
      if (typeof window === "undefined") return;
      const orderId = localStorage.getItem("last_order_id");
      const token = localStorage.getItem("last_customer_token");
      if (!orderId) {
        if (isMounted) setActiveOrder(null);
        return;
      }

      try {
        const url = `/api/orders?orderId=${encodeURIComponent(orderId)}${
          token ? `&token=${encodeURIComponent(token)}` : ""
        }`;
        const res = await fetch(url);
        if (res.ok) {
          const data = (await res.json()) as { order?: RestaurantOrder };
          if (data.order && isMounted) {
            const newOrd = data.order;
            setActiveOrder(newOrd);

            // Detect stage change and trigger audible alert sound + banner un-dismiss
            if (prevStatusRef.current !== null && prevStatusRef.current !== newOrd.status) {
              playStageSound(newOrd.status);
              setDismissed(false);
            } else if (prevStatusRef.current === null) {
              // Initial load sound trigger if preparing or ready
              if (newOrd.status === "preparing" || newOrd.status === "ready") {
                playStageSound(newOrd.status);
              }
            }

            prevStatusRef.current = newOrd.status;
            return;
          }
        }

        // Fallback to local history if server cold-started
        const rawHistory = localStorage.getItem("zoom_ar_customer_orders_history");
        if (rawHistory && isMounted) {
          const history = JSON.parse(rawHistory) as RestaurantOrder[];
          const matched = history.find((o) => o.orderId.toLowerCase() === orderId.toLowerCase());
          if (matched) {
            setActiveOrder(matched);
          }
        }
      } catch {
        // Ignore polling network glitches
      }
    }

    void pollActiveOrder();
    const interval = setInterval(() => {
      void pollActiveOrder();
    }, 4000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  if (!activeOrder || dismissed) {
    return null;
  }

  const cfg = STATUS_CONFIG[activeOrder.status];

  return (
    <AnimatePresence>
      <motion.aside
        className="active-order-banner glass-panel"
        initial={{ opacity: 0, y: -30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.95 }}
        transition={{ type: "spring", stiffness: 350, damping: 25 }}
      >
        <div
          className="active-order-banner__content"
          onClick={() => {
            const token = typeof window !== "undefined" ? localStorage.getItem("last_customer_token") || undefined : undefined;
            onOpenTracker(activeOrder.orderId, token);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              const token = typeof window !== "undefined" ? localStorage.getItem("last_customer_token") || undefined : undefined;
              onOpenTracker(activeOrder.orderId, token);
            }
          }}
        >
          <div className={`active-order-banner__icon ${cfg.badgeClass}`}>
            <span>{cfg.icon}</span>
            {activeOrder.status === "preparing" ? <span className="pulse-ring-sm" /> : null}
          </div>

          <div className="active-order-banner__info">
            <div className="active-order-banner__top">
              <span className="banner-tag">LIVE KITCHEN STATUS</span>
              <strong className="banner-order-id">#{activeOrder.orderId}</strong>
            </div>
            <h4 className="banner-title">{cfg.title}</h4>
            <p className="banner-subtitle">{cfg.subtitle}</p>
          </div>

          <button
            className="active-order-banner__track-btn"
            onClick={(e) => {
              e.stopPropagation();
              const token = typeof window !== "undefined" ? localStorage.getItem("last_customer_token") || undefined : undefined;
              onOpenTracker(activeOrder.orderId, token);
            }}
            type="button"
          >
            Track →
          </button>
        </div>

        <button
          className="active-order-banner__close"
          aria-label="Dismiss notification"
          onClick={() => setDismissed(true)}
          type="button"
        >
          ✕
        </button>
      </motion.aside>
    </AnimatePresence>
  );
}
