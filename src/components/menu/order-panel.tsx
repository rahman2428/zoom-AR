"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/ar/assets";
import type { MenuDish, OrderItem, PaymentMethod, PlateSize, RestaurantOrder } from "@/lib/menu/types";
import { playOrderPlacedSound } from "@/lib/sounds";

interface OrderPanelProps {
  dish: MenuDish;
  onClose: () => void;
  onTrackOrder?: (orderId: string, customerToken?: string) => void;
}

function halfPlatePrice(priceInr: number) {
  return Math.max(120, Math.round((priceInr * 0.62) / 10) * 10);
}

export function OrderPanel({ dish, onClose, onTrackOrder }: OrderPanelProps) {
  const [tableNumber, setTableNumber] = useState("");
  const [chairCode, setChairCode] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [plateSize, setPlateSize] = useState<PlateSize>("full");
  const [quantity, setQuantity] = useState(1);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("upi");
  const [utrNumber, setUtrNumber] = useState("");
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [cardNumber, setCardNumber] = useState("");
  const [cardExpiry, setCardExpiry] = useState("");
  const [cardCvv, setCardCvv] = useState("");
  const [selectedBank, setSelectedBank] = useState("HDFC Bank");
  const [paymentState, setPaymentState] = useState<"details" | "payment" | "sending" | "success" | "error">("details");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmedOrderId, setConfirmedOrderId] = useState("");
  const [confirmedToken, setConfirmedToken] = useState("");

  const MERCHANT_UPI_ID = "8603412912@sbi";
  const MERCHANT_NAME = "Zoom AR Kitchen";

  const cleanTable = tableNumber.trim().toUpperCase();
  const cleanChair = chairCode.trim().toUpperCase();
  const formattedLocation = cleanTable ? (cleanChair ? `${cleanTable}${cleanChair}` : cleanTable) : "";

  const unitPriceInr = plateSize === "full" ? dish.priceInr : halfPlatePrice(dish.priceInr);
  const totalInr = unitPriceInr * quantity;

  const upiIntentUrl = `upi://pay?pa=${MERCHANT_UPI_ID}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${totalInr}&cu=INR&tn=${encodeURIComponent(`ZoomAR_${dish.name.replace(/\s+/g, "_")}`)}`;
  const upiQrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiIntentUrl)}`;

  function handleCopyUpi() {
    try {
      void navigator.clipboard.writeText(MERCHANT_UPI_ID);
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2500);
    } catch {
      // Fallback ignore
    }
  }

  function validateDetails() {
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

async function generatePaymentSignatureClient(transactionId: string, totalInr: number, timestamp: number): Promise<string> {
  const secretKey = "CINEMATIC_AR_REST_PAY_SECRET_9981273";
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const messageData = encoder.encode(`${transactionId}:${totalInr}:${timestamp}`);

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
    if (paymentMethod === "upi") {
      const cleanUtr = utrNumber.trim();
      if (!cleanUtr || cleanUtr.length < 8) {
        setErrorMessage("Please enter your Bank UTR / Ref Number (e.g., 423819283741) after making payment.");
        return;
      }
    }

    setPaymentState("sending");
    setErrorMessage("");

    const item: OrderItem = {
      dishId: dish.id,
      dishName: dish.name,
      plateSize,
      quantity,
      unitPriceInr
    };

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
          items: [item],
          totalInr,
          paymentStatus: "paid",
          paymentMethod,
          utrNumber: utrNumber.trim() || undefined,
          payeeUpi: MERCHANT_UPI_ID,
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

    const item: OrderItem = {
      dishId: dish.id,
      dishName: dish.name,
      plateSize,
      quantity,
      unitPriceInr
    };

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
        description: `Order at Table ${formattedLocation}`,
        order_id: data.gatewayOrderId,
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
                items: [item],
                totalInr,
                paymentStatus: "paid",
                paymentMethod: "upi",
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
      <section className="order-panel glass-panel" role="dialog" aria-modal="true" aria-labelledby="order-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="order-panel__header">
          <div>
            <span className="eyebrow">Table service</span>
            <h2 id="order-title">Build your order</h2>
          </div>
          <button className="order-panel__close" aria-label="Close order" onClick={onClose} type="button">Close</button>
        </div>

        {paymentState === "success" ? (
          <div className="order-panel__success">
            <span className="order-panel__success-mark">OK</span>
            <h3>Order sent to the kitchen</h3>
            <p>
              Order <strong>#{confirmedOrderId}</strong> for Table <strong>{formattedLocation}</strong> has been paid and transmitted to the kitchen.
            </p>
            {utrNumber ? (
              <p className="utr-confirmation">
                Payment UTR Ref: <code>{utrNumber}</code> · Sent to Merchant <code>{MERCHANT_UPI_ID}</code>
              </p>
            ) : null}
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
            <button className="order-panel__secondary" onClick={onClose} type="button">Close</button>
          </div>
        ) : (
          <>
            <div className="order-panel__dish">
              <div>
                <strong>{dish.name}</strong>
                <span>{formatPrice(unitPriceInr)} each</span>
              </div>
              <div className="order-panel__quantity" aria-label="Quantity">
                <button aria-label="Decrease quantity" disabled={quantity === 1} onClick={() => setQuantity((value) => value - 1)} type="button">-</button>
                <strong>{quantity}</strong>
                <button aria-label="Increase quantity" onClick={() => setQuantity((value) => value + 1)} type="button">+</button>
              </div>
            </div>

            {paymentState === "details" ? (
              <form className="order-panel__form" onSubmit={(event) => { event.preventDefault(); if (validateDetails()) setPaymentState("payment"); }}>
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
                <fieldset>
                  <legend>Plate Portion Size</legend>
                  <div className="order-panel__segmented">
                    {(["half", "full"] as PlateSize[]).map((size) => (
                      <button
                        className={plateSize === size ? "is-selected" : ""}
                        key={size}
                        onClick={() => setPlateSize(size)}
                        type="button"
                      >
                        {size} plate ({size === "full" ? formatPrice(dish.priceInr) : formatPrice(halfPlatePrice(dish.priceInr))})
                      </button>
                    ))}
                  </div>
                </fieldset>

                {errorMessage ? <p className="order-panel__error">{errorMessage}</p> : null}
                <button className="order-panel__primary" type="submit">
                  Continue to payment · {formatPrice(totalInr)}
                </button>
              </form>
            ) : (
              <div className="order-panel__payment">
                <span className="eyebrow">Checkout & UPI Payment Gate</span>
                <h3>Confirm payment of {formatPrice(totalInr)}</h3>
                <p>Location: <strong>Table {formattedLocation}</strong> · {customerName}</p>

                <fieldset className="order-panel__methods-fieldset">
                  <legend>Select Payment Method</legend>
                  <div className="order-panel__payment-methods">
                    {(
                      [
                        { id: "upi", label: "Instant UPI / QR" },
                        { id: "card", label: "Debit/Credit Card" },
                        { id: "netbanking", label: "NetBanking" },
                        { id: "desk", label: "Pay at Desk" }
                      ] as const
                    ).map((method) => (
                      <button
                        className={paymentMethod === method.id ? "is-selected" : ""}
                        key={method.id}
                        onClick={() => setPaymentMethod(method.id)}
                        type="button"
                      >
                        {method.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div className="order-panel__payment-details">
                  {paymentMethod === "upi" ? (
                    <div className="payment-upi-box">
                      <div className="upi-qr-card">
                        <div className="upi-qr-wrapper">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={upiQrCodeUrl} alt="Scan to Pay via UPI" className="upi-qr-img" width={180} height={180} />
                          <span className="upi-qr-amount">Scan & Pay {formatPrice(totalInr)}</span>
                        </div>

                        <div className="upi-vpa-details">
                          <span className="upi-vpa-label">Payee Merchant VPA:</span>
                          <div className="upi-vpa-row">
                            <strong className="upi-vpa-code">{MERCHANT_UPI_ID}</strong>
                            <button type="button" className="upi-copy-btn" onClick={handleCopyUpi}>
                              {copiedUpi ? "✓ Copied" : "📋 Copy ID"}
                            </button>
                          </div>
                          <span className="upi-merchant-name">Name: {MERCHANT_NAME}</span>
                        </div>
                      </div>

                      <a href={upiIntentUrl} className="upi-app-launcher-btn">
                        📱 Open UPI App (GPay / PhonePe / Paytm / BHIM)
                      </a>

                      <div className="upi-utr-field">
                        <label>
                          Step 2: Enter 12-Digit Bank UTR / Ref No. <span className="required-star">*</span>
                          <input
                            placeholder="e.g. 423819283741 (from app receipt)"
                            value={utrNumber}
                            onChange={(e) => setUtrNumber(e.target.value.replace(/[^0-9A-Za-z]/g, ""))}
                            maxLength={18}
                            required
                          />
                        </label>
                        <span className="payment-hint">Enter your 12-digit transaction ID after paying so the kitchen can confirm credit.</span>
                      </div>
                    </div>
                  ) : paymentMethod === "card" ? (
                    <div className="payment-method-box">
                      <label>
                        Card Number
                        <input
                          placeholder="4532 •••• •••• 8921"
                          maxLength={19}
                          value={cardNumber}
                          onChange={(e) => setCardNumber(e.target.value)}
                        />
                      </label>
                      <div className="order-panel__grid-2">
                        <label>
                          Expiry
                          <input
                            placeholder="MM/YY"
                            maxLength={5}
                            value={cardExpiry}
                            onChange={(e) => setCardExpiry(e.target.value)}
                          />
                        </label>
                        <label>
                          CVV
                          <input
                            type="password"
                            placeholder="•••"
                            maxLength={4}
                            value={cardCvv}
                            onChange={(e) => setCardCvv(e.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                  ) : paymentMethod === "netbanking" ? (
                    <div className="payment-method-box">
                      <label>
                        Select Bank
                        <select
                          value={selectedBank}
                          onChange={(e) => setSelectedBank(e.target.value)}
                          className="payment-select"
                        >
                          <option value="HDFC Bank">HDFC Bank</option>
                          <option value="ICICI Bank">ICICI Bank</option>
                          <option value="State Bank of India">State Bank of India (SBI)</option>
                          <option value="Axis Bank">Axis Bank</option>
                          <option value="Kotak Mahindra">Kotak Mahindra Bank</option>
                        </select>
                      </label>
                    </div>
                  ) : (
                    <div className="payment-method-box">
                      <p className="desk-info">Pay in cash or card directly to your server at Table <strong>{formattedLocation}</strong> upon order arrival.</p>
                    </div>
                  )}
                </div>

                {errorMessage ? <p className="order-panel__error">{errorMessage}</p> : null}

                <button
                  className="order-panel__razorpay-auto-btn"
                  disabled={paymentState === "sending"}
                  onClick={() => void handleRazorpayCheckout()}
                  type="button"
                >
                  ⚡ Auto-Verify via Razorpay Gateway (Instant)
                </button>

                <button
                  className="order-panel__primary"
                  disabled={paymentState === "sending"}
                  onClick={() => void finalizePaidOrder()}
                  type="button"
                >
                  {paymentState === "sending" ? "Verifying & Transmitting..." : `Submit Paid Order (${formatPrice(totalInr)})`}
                </button>
                <button
                  className="order-panel__secondary"
                  disabled={paymentState === "sending"}
                  onClick={() => setPaymentState("details")}
                  type="button"
                >
                  Back to Details
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
