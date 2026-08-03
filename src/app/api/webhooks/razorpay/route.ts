import { NextResponse } from "next/server";
import crypto from "node:crypto";

export async function POST(request: Request) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return NextResponse.json(
      { message: "Webhook received but RAZORPAY_WEBHOOK_SECRET is not configured." },
      { status: 200 }
    );
  }

  try {
    const bodyText = await request.text();
    const signature = request.headers.get("x-razorpay-signature") || "";

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(bodyText)
      .digest("hex");

    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "utf8"),
      Buffer.from(signature, "utf8")
    );

    if (!isValid) {
      return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
    }

    const payload = JSON.parse(bodyText);

    if (payload.event === "payment.captured" || payload.event === "order.paid") {
      // Payment verified directly from Razorpay servers
      const entity = payload.payload?.payment?.entity || payload.payload?.order?.entity;
      if (entity) {
        // Log payment capture
      }
    }

    return NextResponse.json({ status: "success", received: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error processing webhook." },
      { status: 500 }
    );
  }
}
