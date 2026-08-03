"use client";

import { useCallback, useEffect, useState } from "react";
import { formatPrice } from "@/lib/ar/assets";
import type { OrderStatus, RestaurantOrder } from "@/lib/menu/types";

interface OrderTrackerProps {
  initialOrderId?: string;
  initialToken?: string;
  onClose: () => void;
}

const STEPS: { status: OrderStatus; label: string; description: string }[] = [
  {
    status: "new",
    label: "Order Received",
    description: "Paid & queued for the kitchen staff."
  },
  {
    status: "preparing",
    label: "Preparing in Kitchen",
    description: "Chef is actively crafting your dish."
  },
  {
    status: "ready",
    label: "Ready for Table",
    description: "Plated & being brought to your table now."
  },
  {
    status: "completed",
    label: "Served & Enjoy",
    description: "Order completed. Have a wonderful meal!"
  }
];

function getStepIndex(status: OrderStatus) {
  switch (status) {
    case "new":
      return 0;
    case "preparing":
      return 1;
    case "ready":
      return 2;
    case "completed":
      return 3;
    default:
      return 0;
  }
}

export function OrderTracker({ initialOrderId, initialToken, onClose }: OrderTrackerProps) {
  const [searchQuery, setSearchQuery] = useState(initialOrderId ?? "");
  const [sessionToken, setSessionToken] = useState(initialToken ?? "");
  const [activeOrder, setActiveOrder] = useState<RestaurantOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const fetchStatus = useCallback(async (query: string, tokenOverride?: string) => {
    if (!query.trim()) return;
    setLoading(true);
    setErrorMsg("");

    const currentToken =
      tokenOverride || sessionToken || (typeof window !== "undefined" ? localStorage.getItem("last_customer_token") || "" : "");

    try {
      const url = `/api/orders?orderId=${encodeURIComponent(query.trim())}${
        currentToken ? `&token=${encodeURIComponent(currentToken)}` : ""
      }`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { order?: RestaurantOrder };
        if (data.order) {
          setActiveOrder(data.order);
          setLoading(false);
          return;
        }
      }

      // If server cold-started or lost the order, check customer local history backup
      if (res.status === 404 && typeof window !== "undefined") {
        try {
          const rawHistory = localStorage.getItem("zoom_ar_customer_orders_history");
          if (rawHistory) {
            const history = JSON.parse(rawHistory) as RestaurantOrder[];
            const matched = history.find(
              (o) => o.orderId.toLowerCase() === query.trim().toLowerCase()
            );
            if (matched) {
              // Trigger auto-rehydration to restore order on server
              void fetch("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "rehydrate",
                  rehydrateOrders: [matched]
                })
              });

              setActiveOrder(matched);
              setLoading(false);
              return;
            }
          }
        } catch {
          // ignore
        }
      }

      if (res.status === 403 || res.status === 401) {
        setErrorMsg("Privacy Protection: Access restricted to authorized session holder.");
      } else {
        setErrorMsg(`No active order found for Order ID "${query}".`);
      }
      setActiveOrder(null);
    } catch {
      setErrorMsg("Network error checking order status.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    if (initialOrderId) {
      void fetchStatus(initialOrderId, initialToken);
    } else if (typeof window !== "undefined") {
      const savedId = localStorage.getItem("last_order_id");
      const savedToken = localStorage.getItem("last_customer_token");
      if (savedId) {
        setSearchQuery(savedId);
        if (savedToken) setSessionToken(savedToken);
        void fetchStatus(savedId, savedToken || undefined);
      }
    }
  }, [initialOrderId, initialToken, fetchStatus]);

  // Polling active order status every 3 seconds
  useEffect(() => {
    if (!activeOrder || activeOrder.status === "completed") return;
    const interval = setInterval(() => {
      void fetchStatus(activeOrder.orderId);
    }, 3000);
    return () => clearInterval(interval);
  }, [activeOrder, fetchStatus]);

  const currentStep = activeOrder ? getStepIndex(activeOrder.status) : 0;

  return (
    <div className="tracker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="tracker-panel glass-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tracker-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="tracker-header">
          <div>
            <span className="eyebrow">Real-Time Dining Tracker</span>
            <h2 id="tracker-title">Order Status</h2>
          </div>
          <button className="tracker-close" aria-label="Close tracker" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <form
          className="tracker-search"
          onSubmit={(e) => {
            e.preventDefault();
            void fetchStatus(searchQuery);
          }}
        >
          <input
            placeholder="Enter Order ID (e.g. ZM-K8...) or Table (e.g. 5A)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching..." : "Track"}
          </button>
        </form>

        {errorMsg ? <p className="tracker-error">{errorMsg}</p> : null}

        {activeOrder ? (
          <div className="tracker-content">
            <div className="tracker-card-head">
              <div>
                <span className="tracker-table-label">Table Location</span>
                <strong className="tracker-table-tag">{activeOrder.location}</strong>
              </div>
              <div className="tracker-meta">
                <span className="tracker-order-id">#{activeOrder.orderId}</span>
                <span className="tracker-customer">{activeOrder.customerName}</span>
              </div>
            </div>

            <div className="tracker-stepper">
              {STEPS.map((step, idx) => {
                const isPassed = idx <= currentStep;
                const isCurrent = idx === currentStep;

                return (
                  <div
                    className={`stepper-item ${isPassed ? "is-passed" : ""} ${
                      isCurrent ? "is-current" : ""
                    }`}
                    key={step.status}
                  >
                    <div className="stepper-node">
                      {isPassed ? (isCurrent ? <span className="pulse-ring" /> : "✓") : idx + 1}
                    </div>
                    <div className="stepper-info">
                      <strong>{step.label}</strong>
                      <p>{step.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="tracker-summary">
              <h4>Order Breakdown</h4>
              <ul className="tracker-items">
                {activeOrder.items.map((item, i) => (
                  <li key={`${item.dishId}-${i}`}>
                    <div>
                      <strong>
                        {item.quantity}× {item.dishName}
                      </strong>
                      <span className="tracker-portion">{item.plateSize} plate</span>
                    </div>
                    <span className="tracker-price">{formatPrice(item.unitPriceInr * item.quantity)}</span>
                  </li>
                ))}
              </ul>
              <div className="tracker-footer">
                <span>Total Paid ({activeOrder.paymentMethod?.toUpperCase() ?? "PAID"})</span>
                <strong>{formatPrice(activeOrder.totalInr)}</strong>
              </div>
            </div>
          </div>
        ) : !loading && !errorMsg ? (
          <div className="tracker-empty">
            <p>Enter your Order ID or Table Number above to track preparation status live.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
