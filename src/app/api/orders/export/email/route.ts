import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import type { RestaurantOrder } from "@/lib/menu/types";

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const KITCHEN_STAFF_KEY = process.env.KITCHEN_STAFF_KEY || "9852";

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-kitchen-key",
    "Access-Control-Allow-Credentials": "true"
  };
}

function loadOrdersFromStore(): RestaurantOrder[] {
  const globalForOrders = globalThis as unknown as { ordersStore?: RestaurantOrder[] };
  let orders = globalForOrders.ordersStore ?? [];

  if (!orders.length) {
    try {
      const filePath = path.join(process.cwd(), "data", "orders.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        orders = JSON.parse(raw);
      }
    } catch {
      // Fallback
    }
  }

  const cutoff = Date.now() - ONE_MONTH_MS;
  return orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });
}

function filterByRange(orders: RestaurantOrder[], range = "30d"): RestaurantOrder[] {
  if (range === "24h") {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
  }
  if (range === "7d") {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
  }
  return orders;
}

function buildCSV(orders: RestaurantOrder[]): string {
  const headers = [
    "Order ID",
    "Date & Time",
    "Table",
    "Customer Name",
    "Mobile Number",
    "Items Summary",
    "Total Paid (INR)",
    "Payment Method",
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
      `"${(o.paymentMethod || "razorpay").toUpperCase()}"`,
      `"${(o.paymentStatus || "paid").toUpperCase()}"`,
      `"${o.status.toUpperCase()}"`
    ];
  });

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(request) });
}

export async function POST(request: Request) {
  const corsHeaders = getCorsHeaders(request);
  const headerKey = request.headers.get("x-kitchen-key");

  const body = (await request.json().catch(() => null)) as {
    email?: string;
    dateRange?: string;
    staffKey?: string;
  } | null;

  const keyToTest = headerKey || body?.staffKey;
  if (keyToTest !== KITCHEN_STAFF_KEY) {
    return NextResponse.json(
      { error: "Forbidden: Kitchen staff key required to dispatch email export." },
      { status: 403, headers: corsHeaders }
    );
  }

  const email = body?.email?.trim();
  if (!email || !email.includes("@")) {
    return NextResponse.json(
      { error: "A valid email address is required." },
      { status: 400, headers: corsHeaders }
    );
  }

  const range = body?.dateRange || "30d";
  const allOrders = loadOrdersFromStore();
  const targetOrders = filterByRange(allOrders, range);
  const csvContent = buildCSV(targetOrders);

  const totalRevenue = targetOrders.reduce((sum, o) => sum + o.totalInr, 0);
  const completedCount = targetOrders.filter((o) => o.status === "completed").length;

  let emailSent = false;
  let providerNote = "Mailto client prepared.";

  // Dispatch via optional Resend / Email Webhook service if env var is configured
  const resendApiKey = process.env.RESEND_API_KEY;
  const emailWebhookUrl = process.env.EMAIL_EXPORT_WEBHOOK_URL;

  if (resendApiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Zoom AR Kitchen <orders@zoom-ar.vercel.app>",
          to: [email],
          subject: `Zoom AR Kitchen - ${range.toUpperCase()} Order Export Report (${targetOrders.length} Orders)`,
          html: `
            <h2>Zoom AR Kitchen - ${range.toUpperCase()} Order Export Report</h2>
            <p><strong>Total Orders:</strong> ${targetOrders.length}</p>
            <p><strong>Total Revenue:</strong> ₹${totalRevenue.toLocaleString("en-IN")}</p>
            <p><strong>Completed Orders:</strong> ${completedCount}</p>
            <p>Attached is your order data summary CSV retained under the 30-day storage policy.</p>
          `,
          attachments: [
            {
              filename: `zoom_ar_orders_${range}.csv`,
              content: Buffer.from(csvContent).toString("base64")
            }
          ]
        })
      });
      if (res.ok) {
        emailSent = true;
        providerNote = "Direct email sent via Resend API.";
      }
    } catch {
      // Fallback to mailto
    }
  } else if (emailWebhookUrl) {
    try {
      const res = await fetch(emailWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          range,
          orderCount: targetOrders.length,
          totalRevenue,
          csvContent
        })
      });
      if (res.ok) {
        emailSent = true;
        providerNote = "Report dispatched via Email Webhook.";
      }
    } catch {
      // Fallback to mailto
    }
  }

  // Construct mailto link as direct fallback
  const mailSubject = encodeURIComponent(`Zoom AR Kitchen - Order Export Report (${range})`);
  const mailBody = encodeURIComponent(
    `Zoom AR Kitchen Order Report (${range})\n` +
      `Total Orders: ${targetOrders.length}\n` +
      `Total Revenue: ₹${totalRevenue}\n\n` +
      `CSV Data:\n\n${csvContent.substring(0, 1500)}${csvContent.length > 1500 ? "\n... (truncated for mailto link - download full CSV file via dashboard)" : ""}`
  );
  const mailtoUrl = `mailto:${email}?subject=${mailSubject}&body=${mailBody}`;

  return NextResponse.json(
    {
      success: true,
      email,
      dateRange: range,
      orderCount: targetOrders.length,
      totalRevenue,
      emailSent,
      providerNote,
      csvContent,
      mailtoUrl,
      message: emailSent
        ? `Order report successfully emailed to ${email}.`
        : `Order report ready for ${email}. Click 'Open Email Client' or download CSV directly.`
    },
    { status: 200, headers: corsHeaders }
  );
}
