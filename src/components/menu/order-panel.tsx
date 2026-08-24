"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/ar/assets";
import type { CartItem, OrderItem, PaymentMethod, RestaurantOrder } from "@/lib/menu/types";
import { playOrderPlacedSound } from "@/lib/sounds";

interface OrderPanelProps {
  cartItems: CartItem[];
  onClose: () => void;
  onUpdateQuantity: (cartItemId: string, delta: number) => void;
  onRemoveItem: (cartItemId: string) => void;
  onAddMoreItems: () => void;
  onClearCart: () => void;
  onTrackOrder?: (orderId: string, customerToken?: string) => void;
}

export function OrderPanel({
  cartItems,
  onClose,
  onUpdateQuantity,
  onRemoveItem,
  onAddMoreItems,
  onClearCart,
  onTrackOrder
}: OrderPanelProps) {
  const [tableNumber, setTableNumber] = useState("");
  const [chairCode, setChairCode] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [paymentMethod] = useState<PaymentMethod>("razorpay");
  const [paymentState, setPaymentState] = useState<"details" | "payment" | "sending" | "success" | "error">("details");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmedOrderId, setConfirmedOrderId] = useState("");
  const [confirmedToken, setConfirmedToken] = useState("");

  const cleanTable = tableNumber.trim().toUpperCase();
  const cleanChair = chairCode.trim().toUpperCase();
  const formattedLocation = cleanTable ? (cleanChair ? `${cleanTable}${cleanChair}` : cleanTable) : "";

  const totalInr = cartItems.reduce((sum, item) => sum + item.unitPriceInr * item.quantity, 0);

  const itemsSummaryText = cartItems
    .map((item) => `${item.quantity}x ${item.dishName} (${item.plateSize})`)
    .join(", ");

  function validateDetails() {
    if (cartItems.length === 0) {
      setErrorMessage("Your order cart is empty. Please add at least one food item.");
      return false;
    }
    if (!cleanTable) {
      setErrorMessage("Please enter a valid Table Number.");
      return false;
    }
    if (!customerName.trim()) {
      setErrorMessage("Please enter your Customer Name.");
      return false;
    }
    if (!/^\+?[0-9 ()-]{8,18}$/.test(mobileNumber.trim())) {
      setErrorMessage("Please enter a valid Mobile Number (at least 8 digits).");
      return false;
    }

    setErrorMessage("");
    return true;
  }

  async function generatePaymentSignatureClient(
    transactionId: string,
    amountInr: number,
    timestamp: number
  ): Promise<string> {
    const secretKey = "CINEMATIC_AR_REST_PAY_SECRET_9981273";
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);
    const messageData = encoder.encode(`${transactionId}:${amountInr}:${timestamp}`);

    const cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await window.crypto.subtle.sign("HMAC", cryptoKey, messageData);
    return Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function finalizePaidOrder() {
    setPaymentState("sending");
    setErrorMessage("");

    const orderItems: OrderItem[] = cartItems.map((item) => ({
      dishId: item.dishId,
      dishName: item.dishName,
      plateSize: item.plateSize,
      quantity: item.quantity,
      unitPriceInr: item.unitPriceInr
    }));

    try {
      const transactionId = `TXN-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      const paymentTimestamp = Date.now();
      const paymentSignature = await generatePaymentSignatureClient(transactionId, totalInr, paymentTimestamp);

      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableNumber: cleanTable,
          chairCode: cleanChair || undefined,
          location: formattedLocation,
          customerName: customerName.trim(),
          mobileNumber: mobileNumber.trim(),
          items: orderItems,
          totalInr,
          paymentStatus: "paid",
          paymentMethod,
          transactionId,
          paymentTimestamp,
          paymentSignature
        })
      });

      const payload = (await response.json().catch(() => null)) as {
        orderId?: string;
        customerToken?: string;
        order?: RestaurantOrder;
        error?: string;
      } | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "The kitchen could not receive this order.");
      }

      const generatedId = payload?.orderId ?? "";
      const generatedToken = payload?.customerToken ?? "";
      setConfirmedOrderId(generatedId);
      setConfirmedToken(generatedToken);

      if (generatedId && typeof window !== "undefined") {
        localStorage.setItem("last_order_id", generatedId);
        if (generatedToken) {
          localStorage.setItem("last_customer_token", generatedToken);
        }
        if (payload?.order) {
          try {
            const rawHistory = localStorage.getItem("zoom_ar_customer_orders_history");
            const history = rawHistory ? JSON.parse(rawHistory) : [];
            const updatedHistory = Array.isArray(history) ? [payload.order, ...history] : [payload.order];
            localStorage.setItem("zoom_ar_customer_orders_history", JSON.stringify(updatedHistory));
          } catch {
            // ignore
          }
        }
      }

      onClearCart();
      playOrderPlacedSound();
      setPaymentState("success");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The order could not be sent.");
      setPaymentState("error");
    }
  }

  async function handleRazorpayCheckout() {
    setPaymentState("sending");
    setErrorMessage("");

    const orderItems: OrderItem[] = cartItems.map((item) => ({
      dishId: item.dishId,
      dishName: item.dishName,
      plateSize: item.plateSize,
      quantity: item.quantity,
      unitPriceInr: item.unitPriceInr
    }));

    try {
      // 1. Request Razorpay Order ID from Server
      const res = await fetch("/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalInr })
      });

      const data = (await res.json()) as {
        isConfigured?: boolean;
        gatewayOrderId?: string;
        amount?: number;
        currency?: string;
        keyId?: string;
        error?: string;
        message?: string;
      };

      if (!res.ok || !data) {
        throw new Error(data?.error || "Failed to create payment order.");
      }

      // If Razorpay keys are not configured yet in Vercel env, inform user clearly
      if (!data.isConfigured || !data.keyId || !data.gatewayOrderId) {
        setErrorMessage("Razorpay Keys Ready: Add RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET to your environment. Falling back to standard check...");
        setPaymentState("payment");
        return;
      }

      // 2. Open Official Razorpay Checkout Modal
      const options = {
        key: data.keyId,
        amount: data.amount,
        currency: data.currency || "INR",
        name: "Zoom AR Restaurant",
        description: `Table ${formattedLocation} (${cartItems.length} Food Items)`,
        order_id: data.gatewayOrderId,
        method: {
          upi: true,
          card: true,
          netbanking: true,
          wallet: true
        },
        prefill: {
          name: customerName,
          contact: mobileNumber
        },
        theme: { color: "#d8b15b" },
        handler: async function (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) {
          try {
            const verifyRes = await fetch("/api/orders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tableNumber: cleanTable,
                chairCode: cleanChair || undefined,
                location: formattedLocation,
                customerName: customerName.trim(),
                mobileNumber: mobileNumber.trim(),
                items: orderItems,
                totalInr,
                paymentStatus: "paid",
                paymentMethod: "razorpay",
                transactionId: response.razorpay_payment_id,
                gatewayOrderId: response.razorpay_order_id,
                paymentSignature: response.razorpay_signature,
                paymentTimestamp: Date.now()
              })
            });

            const verifyPayload = (await verifyRes.json().catch(() => null)) as {
              orderId?: string;
              customerToken?: string;
              order?: RestaurantOrder;
              error?: string;
            } | null;

            if (!verifyRes.ok) {
              throw new Error(verifyPayload?.error ?? "Payment verification failed.");
            }

            const generatedId = verifyPayload?.orderId ?? "";
            const generatedToken = verifyPayload?.customerToken ?? "";
            setConfirmedOrderId(generatedId);
            setConfirmedToken(generatedToken);

            if (generatedId && typeof window !== "undefined") {
              localStorage.setItem("last_order_id", generatedId);
              if (generatedToken) {
                localStorage.setItem("last_customer_token", generatedToken);
              }
              if (verifyPayload?.order) {
                try {
                  const rawHistory = localStorage.getItem("zoom_ar_customer_orders_history");
                  const history = rawHistory ? JSON.parse(rawHistory) : [];
                  const updatedHistory = Array.isArray(history) ? [verifyPayload.order, ...history] : [verifyPayload.order];
                  localStorage.setItem("zoom_ar_customer_orders_history", JSON.stringify(updatedHistory));
                } catch {
                  // ignore
                }
              }
            }
            onClearCart();
            playOrderPlacedSound();
            setPaymentState("success");
          } catch (err) {
            setErrorMessage(err instanceof Error ? err.message : "Payment verification failed.");
            setPaymentState("error");
          }
        },
        modal: {
          ondismiss: function () {
            setPaymentState("payment");
          }
        }
      };

      // Dynamically load Razorpay SDK script if not present
      if (typeof window !== "undefined") {
        const win = window as unknown as { Razorpay?: new (opts: unknown) => { open: () => void } };
        if (win.Razorpay) {
          const rzp = new win.Razorpay(options);
          rzp.open();
        } else {
          const script = document.createElement("script");
          script.src = "https://checkout.razorpay.com/v1/checkout.js";
          script.onload = () => {
            if (win.Razorpay) {
              const rzp = new win.Razorpay(options);
              rzp.open();
            }
          };
          script.onerror = () => {
            setErrorMessage("Failed to load Razorpay Payment Gateway script.");
            setPaymentState("error");
          };
          document.body.appendChild(script);
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Razorpay payment error.");
      setPaymentState("error");
    }
  }

  return (
    <div className="order-panel__backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="order-panel glass-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="order-panel__header">
          <div>
            <span className="eyebrow">Table service</span>
            <h2 id="order-title">Your Food Order Cart</h2>
          </div>
          <button className="order-panel__close" aria-label="Close order" onClick={onClose} type="button">
            Close
          </button>
        </div>

        {paymentState === "success" ? (
          <div className="order-panel__success">
            <span className="order-panel__success-mark">OK</span>
            <h3>Order sent to the kitchen!</h3>
            <p>
              Order <strong>#{confirmedOrderId}</strong> for Table <strong>{formattedLocation}</strong> has been paid and transmitted to the kitchen.
            </p>
            <p className="order-items-summary-tag">
              Items: <strong>{itemsSummaryText}</strong>
            </p>
            <p className="utr-confirmation">
              Payment completed securely through Razorpay Checkout.
            </p>
            {onTrackOrder ? (
              <button
                className="order-panel__primary"
                onClick={() => {
                  onClose();
                  onTrackOrder(confirmedOrderId, confirmedToken);
                }}
                type="button"
              >
                📍 Track Live Preparation Status
              </button>
            ) : null}
            <button className="order-panel__secondary" onClick={onClose} type="button">
              Close
            </button>
          </div>
        ) : (
          <>
            {/* Multi-Item Food Order List */}
            <div className="cart-items-container">
              <div className="cart-items-top">
                <span className="cart-items-title">
                  🛒 Items in Order ({cartItems.length})
                </span>
                <button
                  type="button"
                  className="cart-add-more-btn"
                  onClick={onAddMoreItems}
                >
                  ➕ Add More Dishes
                </button>
              </div>

              {cartItems.length === 0 ? (
                <div className="cart-empty-box">
                  <p>Your order cart is currently empty.</p>
                  <button
                    type="button"
                    className="order-panel__primary"
                    onClick={onAddMoreItems}
                  >
                    Browse Menu & Add Dishes
                  </button>
                </div>
              ) : (
                <div className="cart-items-list">
                  {cartItems.map((item) => (
                    <div key={item.cartItemId} className="cart-item-card">
                      <div className="cart-item-main">
                        <div>
                          <strong className="cart-item-name">{item.dishName}</strong>
                          <span className="cart-item-portion">
                            {item.plateSize === "full" ? "Full Plate" : "Half Plate"} · ₹{item.unitPriceInr} each
                          </span>
                        </div>
                        <strong className="cart-item-total">₹{item.unitPriceInr * item.quantity}</strong>
                      </div>

                      <div className="cart-item-row-footer">
                        <div className="cart-qty-stepper">
                          <button
                            type="button"
                            aria-label="Decrease quantity"
                            onClick={() => onUpdateQuantity(item.cartItemId, -1)}
                          >
                            -
                          </button>
                          <strong>{item.quantity}</strong>
                          <button
                            type="button"
                            aria-label="Increase quantity"
                            onClick={() => onUpdateQuantity(item.cartItemId, 1)}
                          >
                            +
                          </button>
                        </div>

                        <button
                          type="button"
                          className="cart-remove-btn"
                          onClick={() => onRemoveItem(item.cartItemId)}
                        >
                          🗑 Remove
                        </button>
                      </div>
                    </div>
                  ))}

                  <div className="cart-subtotal-bar">
                    <span>Order Subtotal ({cartItems.reduce((acc, i) => acc + i.quantity, 0)} plates):</span>
                    <strong className="cart-subtotal-price">{formatPrice(totalInr)}</strong>
                  </div>
                </div>
              )}
            </div>

            {cartItems.length > 0 ? (
              paymentState === "details" ? (
                <form
                  className="order-panel__form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (validateDetails()) setPaymentState("payment");
                  }}
                >
                  <div className="order-panel__location-fields">
                    <div className="order-panel__grid-2">
                      <label>
                        Table No. <span className="required-star">*</span>
                        <input
                          placeholder="e.g. 5"
                          value={tableNumber}
                          onChange={(event) => setTableNumber(event.target.value)}
                          required
                        />
                      </label>
                      <label>
                        Chair Code <span className="optional-tag">(optional)</span>
                        <input
                          placeholder="e.g. A"
                          value={chairCode}
                          onChange={(event) => setChairCode(event.target.value)}
                          maxLength={4}
                        />
                      </label>
                    </div>
                    <div className="order-panel__location-preview">
                      <span>Formatted Location:</span>
                      <strong className="order-panel__location-tag">
                        {formattedLocation ? formattedLocation : "Enter table number..."}
                      </strong>
                    </div>
                  </div>

                  <label>
                    Customer Name <span className="required-star">*</span>
                    <input
                      autoComplete="name"
                      placeholder="e.g. Rahul Sharma"
                      value={customerName}
                      onChange={(event) => setCustomerName(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Mobile Number <span className="required-star">*</span>
                    <input
                      autoComplete="tel"
                      inputMode="tel"
                      placeholder="e.g. +91 9876543210"
                      value={mobileNumber}
                      onChange={(event) => setMobileNumber(event.target.value)}
                      required
                    />
                  </label>

                  {errorMessage ? <p className="order-panel__error">{errorMessage}</p> : null}
                  <button className="order-panel__primary" type="submit">
                    Continue to Payment · {formatPrice(totalInr)}
                  </button>
                </form>
              ) : (
                <div className="order-panel__payment">
                  <span className="eyebrow">Secure checkout</span>
                  <h3>Pay {formatPrice(totalInr)} with Razorpay</h3>
                  <p>
                    Location: <strong>Table {formattedLocation}</strong> · {customerName} ({cartItems.length} Food Items)
                  </p>

                  <div className="order-panel__payment-details">
                    <div className="payment-method-box">
                      <p className="desk-info">
                        Proceed with a streamlined, secure Razorpay payment flow for instant confirmation and kitchen notification.
                      </p>
                    </div>
                  </div>

                  {errorMessage ? <p className="order-panel__error">{errorMessage}</p> : null}

                  <button
                    className="order-panel__primary"
                    disabled={paymentState === "sending"}
                    onClick={() => void handleRazorpayCheckout()}
                    type="button"
                  >
                    {paymentState === "sending" ? "Processing payment..." : "Pay & Confirm Order"}
                  </button>
                </div>
              )
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}