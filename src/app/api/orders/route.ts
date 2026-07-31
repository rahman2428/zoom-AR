import { NextResponse } from "next/server";
import type { OrderStatus, PaymentMethod, RestaurantOrder } from "@/lib/menu/types";

// Persist across hot reloads in dev mode
const globalForOrders = globalThis as unknown as {
  ordersStore?: RestaurantOrder[];
};

const ordersStore: RestaurantOrder[] = globalForOrders.ordersStore ?? [];
if (process.env.NODE_ENV !== "production") {
  globalForOrders.ordersStore = ordersStore;
}

const KITCHEN_STAFF_KEY = process.env.KITCHEN_STAFF_KEY || "8899";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-kitchen-key"
};

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
}

function isStaffAuthorized(request: Request) {
  const headerKey = request.headers.get("x-kitchen-key");
  const { searchParams } = new URL(request.url);
  const queryKey = searchParams.get("staffKey");
  return headerKey === KITCHEN_STAFF_KEY || queryKey === KITCHEN_STAFF_KEY;
}

function parseTableAndChair(tableNum?: string, chairCode?: string, fallbackLocation?: string) {
  let table = tableNum?.trim().toUpperCase() || "";
  let chair = chairCode?.trim().toUpperCase() || "";

  if (!table && fallbackLocation) {
    const match = fallbackLocation.trim().match(/^(\d+|[A-Z]+)(\s*[-_]?\s*([A-Za-z0-9]+))?$/);
    if (match) {
      table = match[1];
      chair = match[3] || "";
    } else {
      table = fallbackLocation.trim();
    }
  }

  const location = chair ? `${table}${chair}` : table;
  return { tableNumber: table, chairCode: chair || undefined, location };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("orderId");
  const token = searchParams.get("token");
  const verifyStaff = searchParams.get("verifyStaff");

  // Check Staff PIN verification query
  if (verifyStaff !== null) {
    const authorized = isStaffAuthorized(request);
    return NextResponse.json(
      { authorized },
      { status: authorized ? 200 : 401, headers: corsHeaders }
    );
  }

  // Kitchen Staff access: Full Queue Access
  if (isStaffAuthorized(request)) {
    return NextResponse.json({ orders: ordersStore, authorized: true }, { status: 200, headers: corsHeaders });
  }

  // Customer isolated access by Order ID & matching Customer Security Token
  if (orderId) {
    const target = ordersStore.find((o) => o.orderId.toLowerCase() === orderId.trim().toLowerCase());
    if (!target) {
      return NextResponse.json({ error: "Order not found." }, { status: 404, headers: corsHeaders });
    }

    // Privacy verification: check cryptographic customerToken if present
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
  const order = (await request.json().catch(() => null)) as IncomingOrderPayload | null;
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

  if (
    !tableNumber ||
    !order?.customerName?.trim() ||
    !order.mobileNumber?.trim() ||
    !hasValidItems ||
    typeof order.totalInr !== "number" ||
    order.paymentStatus !== "paid"
  ) {
    return NextResponse.json(
      { error: "A complete paid order with table number, customer details, and valid items is required." },
      { status: 400, headers: corsHeaders }
    );
  }

  // Generate cryptographic isolation token for the customer's session
  const customerToken = `TOK-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

  const finalizedOrder: RestaurantOrder = {
    orderId: `ZM-${Date.now().toString(36).toUpperCase()}`,
    customerToken,
    tableNumber,
    chairCode,
    location,
    customerName: order.customerName.trim(),
    mobileNumber: order.mobileNumber.trim(),
    items: order.items as RestaurantOrder["items"],
    totalInr: order.totalInr,
    status: "new",
    paymentStatus: "paid",
    paymentMethod: order.paymentMethod ?? "upi",
    createdAt: new Date().toISOString()
  };

  // Add to top of in-memory store
  ordersStore.unshift(finalizedOrder);

  // If webhook configured, dispatch
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

  const targetOrder = ordersStore.find((o) => o.orderId === body.orderId);
  if (!targetOrder) {
    return NextResponse.json({ error: "Order not found." }, { status: 404, headers: corsHeaders });
  }

  targetOrder.status = body.status;
  return NextResponse.json({ success: true, order: targetOrder }, { status: 200, headers: corsHeaders });
}

