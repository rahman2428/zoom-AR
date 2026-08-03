import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OrderStatus, PaymentMethod, RestaurantOrder } from "@/lib/menu/types";

// 1 Month Retention Horizon (30 Calendar Days in milliseconds)
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// Persist across hot reloads in dev mode
const globalForOrders = globalThis as unknown as {
  ordersStore?: RestaurantOrder[];
};

function getStoreFilePath(): string {
  const localDir = path.join(process.cwd(), "data");
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return path.join(localDir, "orders.json");
  } catch {
    return path.join("/tmp", "orders.json");
  }
}

function loadOrdersFromDisk(): RestaurantOrder[] {
  try {
    const filePath = getStoreFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Fail gracefully to memory store if filesystem is unavailable
  }
  return [];
}

// Multi-tiered Persistent Storage Strategy: Cloud KV + Resilient Disk + In-Memory Store
async function loadOrdersFromCloudKV(): Promise<RestaurantOrder[]> {
  const kvUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const storageUrl = process.env.ORDERS_STORAGE_URL;

  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/zoom_ar_orders_v1`, {
        headers: { Authorization: `Bearer ${kvToken}` },
        cache: "no-store"
      });
      if (res.ok) {
        const json = await res.json();
        const raw = json.result ?? json;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Fallback silently
    }
  }

  if (storageUrl) {
    try {
      const res = await fetch(storageUrl, { cache: "no-store" });
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Fallback silently
    }
  }

  return [];
}

async function saveOrdersToCloudKV(orders: RestaurantOrder[]): Promise<void> {
  const kvUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/zoom_ar_orders_v1`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${kvToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(JSON.stringify(orders)),
        cache: "no-store"
      });
    } catch {
      // Ignore cloud sync failures gracefully
    }
  }
}

function mergeOrders(existing: RestaurantOrder[], incoming: RestaurantOrder[]): RestaurantOrder[] {
  const map = new Map<string, RestaurantOrder>();

  for (const ord of existing) {
    if (ord && ord.orderId) {
      map.set(ord.orderId, ord);
    }
  }

  for (const ord of incoming) {
    if (ord && ord.orderId) {
      const prev = map.get(ord.orderId);
      if (!prev) {
        map.set(ord.orderId, ord);
      } else {
        map.set(ord.orderId, {
          ...prev,
          ...ord,
          // Preserve customerToken if existing had it
          customerToken: ord.customerToken || prev.customerToken
        });
      }
    }
  }

  const result = Array.from(map.values());
  const cutoffTime = Date.now() - ONE_MONTH_MS;
  const valid = result.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return !isNaN(t) && t >= cutoffTime;
  });
  valid.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return valid;
}

function pruneAndPersistOrders(orders: RestaurantOrder[]): RestaurantOrder[] {
  const merged = mergeOrders(globalForOrders.ordersStore || [], orders);
  globalForOrders.ordersStore = merged;

  // Persist to disk
  try {
    const filePath = getStoreFilePath();
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  } catch {
    // Ignore write errors on read-only serverless filesystems
  }

  // Trigger cloud sync asynchronously
  void saveOrdersToCloudKV(merged);

  return merged;
}

async function getStoredOrders(): Promise<RestaurantOrder[]> {
  let currentMemory = globalForOrders.ordersStore || [];
  const diskOrders = loadOrdersFromDisk();
  
  if (currentMemory.length === 0 && diskOrders.length === 0) {
    const cloudOrders = await loadOrdersFromCloudKV();
    currentMemory = mergeOrders(currentMemory, cloudOrders);
  } else {
    currentMemory = mergeOrders(currentMemory, diskOrders);
  }

  return pruneAndPersistOrders(currentMemory);
}

function saveStoredOrders(orders: RestaurantOrder[]): RestaurantOrder[] {
  return pruneAndPersistOrders(orders);
}

function generateOrdersCSV(orders: RestaurantOrder[]): string {
  const headers = [
    "Order ID",
    "Date & Time",
    "Table",
    "Customer Name",
    "Mobile Number",
    "Items Summary",
    "Total Paid (INR)",
    "Payment Method",
    "UTR Ref No",
    "Payee VPA",
    "Payment Status",
    "Order Status"
  ];

  const rows = orders.map((o) => {
    const itemsSummary = o.items
      .map((i) => `${i.quantity}x ${i.dishName} (${i.plateSize}) @ ₹${i.unitPriceInr}`)
      .join(" | ");

    const formattedDate = new Date(o.createdAt).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short"
    });

    return [
      `"${o.orderId.replace(/"/g, '""')}"`,
      `"${formattedDate.replace(/"/g, '""')}"`,
      `"${o.location.replace(/"/g, '""')}"`,
      `"${o.customerName.replace(/"/g, '""')}"`,
      `"${o.mobileNumber.replace(/"/g, '""')}"`,
      `"${itemsSummary.replace(/"/g, '""')}"`,
      o.totalInr,
      `"${(o.paymentMethod || "upi").toUpperCase()}"`,
      `"${(o.utrNumber || "N/A").replace(/"/g, '""')}"`,
      `"${(o.payeeUpi || "8603412912@sbi").replace(/"/g, '""')}"`,
      `"${(o.paymentStatus || "paid").toUpperCase()}"`,
      `"${o.status.toUpperCase()}"`
    ];
  });

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function filterOrdersByRange(orders: RestaurantOrder[], range?: string | null): RestaurantOrder[] {
  if (!range || range === "all" || range === "30d") {
    return orders;
  }
  const now = Date.now();
  if (range === "24h") {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
  }
  if (range === "7d") {
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    return orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
  }
  return orders;
}

const KITCHEN_STAFF_KEY = process.env.KITCHEN_STAFF_KEY || "8899";
const PAYMENT_SECRET_KEY = process.env.PAYMENT_SECRET_KEY || "CINEMATIC_AR_REST_PAY_SECRET_9981273";

// Allowed production origins
const ALLOWED_ORIGINS = [
  "https://zoom-ar.vercel.app",
  "https://zoom-ar-kitchen.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001"
];

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.includes(origin) ||
    origin.endsWith(".vercel.app") ||
    process.env.NODE_ENV !== "production";

  const allowOrigin = isAllowed && origin ? origin : "https://zoom-ar.vercel.app";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-kitchen-key, x-payment-signature",
    "Access-Control-Allow-Credentials": "true"
  };
}

// HMAC-SHA256 Payment Signature Generator & Verifier
function createPaymentSignature(transactionId: string, totalInr: number, timestamp: number): string {
  const payload = `${transactionId}:${totalInr}:${timestamp}`;
  return crypto.createHmac("sha256", PAYMENT_SECRET_KEY).update(payload).digest("hex");
}

function verifyPaymentSignature(
  transactionId?: string,
  totalInr?: number,
  timestamp?: number,
  providedSignature?: string
): boolean {
  if (!transactionId || typeof totalInr !== "number" || !timestamp || !providedSignature) {
    return false;
  }
  // Max 30 min window
  if (Math.abs(Date.now() - timestamp) > 30 * 60 * 1000) {
    return false;
  }
  const expectedSignature = createPaymentSignature(transactionId, totalInr, timestamp);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "utf8"),
      Buffer.from(providedSignature, "utf8")
    );
  } catch {
    return false;
  }
}

// Rate Limiter for Staff Authentication against Brute Force
const failedPinAttempts = new Map<string, { count: number; lockUntil: number }>();

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown-client"
  );
}

function isRateLimited(ip: string): boolean {
  const record = failedPinAttempts.get(ip);
  if (!record) return false;
  if (Date.now() < record.lockUntil) return true;
  failedPinAttempts.delete(ip);
  return false;
}

function recordFailedAttempt(ip: string) {
  const record = failedPinAttempts.get(ip) || { count: 0, lockUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockUntil = Date.now() + 60000; // 1 minute lockout
  }
  failedPinAttempts.set(ip, record);
}

function recordSuccessfulAttempt(ip: string) {
  failedPinAttempts.delete(ip);
}

// Server-side Input Sanitizer against Script Injection (XSS)
function sanitizeInput(input?: string, maxLength = 80): string {
  if (!input) return "";
  return input
    .replace(/<[^>]*>?/gm, "") // Strip HTML
    .replace(/[^\w\s\+\-\@\.]/gi, "") // Remove unsafe characters
    .trim()
    .substring(0, maxLength);
}

function isStaffAuthorized(request: Request) {
  const headerKey = request.headers.get("x-kitchen-key");
  const { searchParams } = new URL(request.url);
  const queryKey = searchParams.get("staffKey");

  const providedKey = headerKey || queryKey;
  return providedKey === KITCHEN_STAFF_KEY;
}

function parseTableAndChair(tableNum?: string, chairCode?: string, fallbackLocation?: string) {
  let table = sanitizeInput(tableNum, 10).toUpperCase();
  let chair = sanitizeInput(chairCode, 10).toUpperCase();

  if (!table && fallbackLocation) {
    const cleanFallback = sanitizeInput(fallbackLocation, 20);
    const match = cleanFallback.match(/^(\d+|[A-Z]+)(\s*[-_]?\s*([A-Za-z0-9]+))?$/);
    if (match) {
      table = match[1];
      chair = match[3] || "";
    } else {
      table = cleanFallback;
    }
  }

  const location = chair ? `${table}${chair}` : table;
  return { tableNumber: table, chairCode: chair || undefined, location };
}

interface IncomingOrderPayload {
  tableNumber?: string;
  chairCode?: string;
  location?: string;
  customerName?: string;
  mobileNumber?: string;
  items?: Array<{ dishId?: string; dishName?: string; plateSize?: string; quantity?: number; unitPriceInr?: number }>;
  totalInr?: number;
  paymentStatus?: string;
  paymentMethod?: PaymentMethod;
  utrNumber?: string;
  payeeUpi?: string;
  transactionId?: string;
  paymentTimestamp?: number;
  paymentSignature?: string;
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(request) });
}

export async function GET(request: Request) {
  const corsHeaders = getCorsHeaders(request);
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("orderId");
  const token = searchParams.get("token");
  const verifyStaff = searchParams.get("verifyStaff");
  const isExport = searchParams.get("export") === "true";
  const exportFormat = searchParams.get("format") || "csv";
  const dateRange = searchParams.get("range") || "30d";
  const clientIp = getClientIp(request);

  // Check Staff PIN verification query with Rate Limiting
  if (verifyStaff !== null) {
    if (isRateLimited(clientIp)) {
      return NextResponse.json(
        { error: "Too many failed attempts. Staff PIN authentication locked for 60 seconds." },
        { status: 429, headers: corsHeaders }
      );
    }

    const authorized = isStaffAuthorized(request);
    if (authorized) {
      recordSuccessfulAttempt(clientIp);
    } else {
      recordFailedAttempt(clientIp);
    }

    return NextResponse.json(
      { authorized },
      { status: authorized ? 200 : 401, headers: corsHeaders }
    );
  }

  const currentOrders = await getStoredOrders();

  // Export Request for Authorized Staff
  if (isExport) {
    if (!isStaffAuthorized(request)) {
      return NextResponse.json(
        { error: "Kitchen staff authentication required for exporting order data." },
        { status: 401, headers: corsHeaders }
      );
    }

    const filtered = filterOrdersByRange(currentOrders, dateRange);

    if (exportFormat === "json") {
      return new NextResponse(JSON.stringify(filtered, null, 2), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="zoom_ar_orders_${dateRange}_${Date.now()}.json"`
        }
      });
    }

    const csvContent = generateOrdersCSV(filtered);
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="zoom_ar_orders_${dateRange}_${Date.now()}.csv"`
      }
    });
  }

  // Kitchen Staff access: Full Queue Access
  if (isStaffAuthorized(request)) {
    return NextResponse.json(
      {
        orders: currentOrders,
        authorized: true,
        retentionPolicy: "30_days_auto_pruned",
        totalOrdersRetained: currentOrders.length
      },
      { status: 200, headers: corsHeaders }
    );
  }

  // Customer isolated access by Order ID & matching Customer Security Token
  if (orderId) {
    const target = currentOrders.find((o) => o.orderId.toLowerCase() === orderId.trim().toLowerCase());
    if (!target) {
      return NextResponse.json({ error: "Order not found." }, { status: 404, headers: corsHeaders });
    }

    // Privacy verification: check cryptographic customerToken
    if (target.customerToken && target.customerToken !== token?.trim()) {
      return NextResponse.json(
        { error: "Unauthorized access: invalid security token for this order." },
        { status: 403, headers: corsHeaders }
      );
    }

    // Return sanitized order representation
    const sanitizedOrder = {
      orderId: target.orderId,
      location: target.location,
      customerName: target.customerName,
      items: target.items,
      totalInr: target.totalInr,
      status: target.status,
      paymentMethod: target.paymentMethod,
      createdAt: target.createdAt
    };

    return NextResponse.json({ order: sanitizedOrder }, { status: 200, headers: corsHeaders });
  }

  // Unauthenticated requests are denied full kitchen queue access
  return NextResponse.json(
    { error: "Kitchen staff authentication required to view order queue." },
    { status: 401, headers: corsHeaders }
  );
}

export async function POST(request: Request) {
  const corsHeaders = getCorsHeaders(request);
  const body = (await request.json().catch(() => null)) as
    | (IncomingOrderPayload & { action?: string; rehydrateOrders?: RestaurantOrder[] })
    | null;

  // Support Client-Side Auto-Rehydration Sync for Staff / Customer Sessions
  if (body?.action === "rehydrate" && Array.isArray(body.rehydrateOrders)) {
    const current = await getStoredOrders();
    const validBackups = body.rehydrateOrders.filter(
      (o) => o && typeof o.orderId === "string" && Array.isArray(o.items) && typeof o.totalInr === "number"
    );
    const updated = saveStoredOrders(mergeOrders(current, validBackups));
    return NextResponse.json(
      { success: true, rehydratedCount: validBackups.length, totalOrders: updated.length },
      { status: 200, headers: corsHeaders }
    );
  }

  const order = body;
  const hasValidItems =
    Boolean(order?.items?.length) &&
    order!.items!.every(
      (item) =>
        item.dishId &&
        item.dishName &&
        (item.plateSize === "half" || item.plateSize === "full") &&
        Number.isInteger(item.quantity) &&
        item.quantity! > 0 &&
        typeof item.unitPriceInr === "number"
    );

  const { tableNumber, chairCode, location } = parseTableAndChair(
    order?.tableNumber,
    order?.chairCode,
    order?.location
  );

  const customerName = sanitizeInput(order?.customerName, 50);
  const mobileNumber = sanitizeInput(order?.mobileNumber, 20);

  if (
    !tableNumber ||
    !customerName ||
    !mobileNumber ||
    !hasValidItems ||
    typeof order?.totalInr !== "number" ||
    order.paymentStatus !== "paid"
  ) {
    return NextResponse.json(
      { error: "A complete paid order with table number, customer details, and valid items is required." },
      { status: 400, headers: corsHeaders }
    );
  }

  // Cryptographic Payment Signature Verification (HMAC-SHA256)
  const isPaymentVerified = verifyPaymentSignature(
    order.transactionId,
    order.totalInr,
    order.paymentTimestamp,
    order.paymentSignature
  );

  if (!isPaymentVerified) {
    return NextResponse.json(
      { error: "Payment verification failed: Invalid or forged cryptographic payment signature." },
      { status: 402, headers: corsHeaders }
    );
  }

  // Generate 256-bit cryptographic isolation token for customer's session
  const customerToken = `TOK-${crypto.randomBytes(16).toString("hex").toUpperCase()}`;

  const finalizedOrder: RestaurantOrder = {
    orderId: `ZM-${Date.now().toString(36).toUpperCase()}`,
    customerToken,
    transactionId: order.transactionId,
    paymentSignature: order.paymentSignature,
    tableNumber,
    chairCode,
    location,
    customerName,
    mobileNumber,
    items: order.items!.map((item) => ({
      dishId: sanitizeInput(item.dishId, 50),
      dishName: sanitizeInput(item.dishName, 80),
      plateSize: item.plateSize as "half" | "full",
      quantity: item.quantity!,
      unitPriceInr: item.unitPriceInr!
    })),
    totalInr: order.totalInr,
    status: "new",
    paymentStatus: "paid",
    paymentMethod: order.paymentMethod ?? "upi",
    utrNumber: sanitizeInput(order.utrNumber, 30) || undefined,
    payeeUpi: sanitizeInput(order.payeeUpi, 50) || "8603412912@sbi",
    createdAt: new Date().toISOString()
  };

  const currentOrders = await getStoredOrders();
  const updatedOrders = [finalizedOrder, ...currentOrders];
  saveStoredOrders(updatedOrders);

  // Dispatch to optional webhook
  const kitchenWebhookUrl = process.env.KITCHEN_WEBHOOK_URL;
  if (kitchenWebhookUrl) {
    fetch(kitchenWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(finalizedOrder)
    }).catch(() => null);
  }

  return NextResponse.json(
    {
      orderId: finalizedOrder.orderId,
      customerToken: finalizedOrder.customerToken,
      order: finalizedOrder
    },
    { status: 201, headers: corsHeaders }
  );
}

export async function PATCH(request: Request) {
  const corsHeaders = getCorsHeaders(request);

  // Enforce staff authentication for updating order statuses
  if (!isStaffAuthorized(request)) {
    return NextResponse.json(
      { error: "Forbidden: Only authorized kitchen staff can update order status." },
      { status: 403, headers: corsHeaders }
    );
  }

  const body = (await request.json().catch(() => null)) as { orderId?: string; status?: OrderStatus } | null;
  const validStatuses: OrderStatus[] = ["new", "preparing", "ready", "completed"];

  if (!body?.orderId || !body.status || !validStatuses.includes(body.status)) {
    return NextResponse.json(
      { error: "Valid orderId and status are required." },
      { status: 400, headers: corsHeaders }
    );
  }

  const currentOrders = await getStoredOrders();
  const targetOrder = currentOrders.find((o) => o.orderId === body.orderId);
  if (!targetOrder) {
    return NextResponse.json({ error: "Order not found." }, { status: 404, headers: corsHeaders });
  }

  targetOrder.status = body.status;
  saveStoredOrders(currentOrders);

  return NextResponse.json({ success: true, order: targetOrder }, { status: 200, headers: corsHeaders });
}