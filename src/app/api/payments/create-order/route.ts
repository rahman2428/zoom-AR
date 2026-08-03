import { NextResponse } from "next/server";
import Razorpay from "razorpay";

export async function POST(request: Request) {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    const { totalInr } = (await request.json().catch(() => ({}))) as { totalInr?: number };

    if (!totalInr || typeof totalInr !== "number" || totalInr <= 0) {
      return NextResponse.json(
        { error: "Valid totalInr amount is required." },
        { status: 400 }
      );
    }

    // If Razorpay environment keys are present, generate official gateway order
    if (keyId && keySecret) {
      const instance = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
      });

      const options = {
        amount: Math.round(totalInr * 100), // Razorpay operates in paise
        currency: "INR",
        receipt: `zm_rcpt_${Date.now().toString(36)}`,
        notes: {
          system: "Zoom AR Dining"
        }
      };

      const gatewayOrder = await instance.orders.create(options);

      return NextResponse.json({
        isConfigured: true,
        gatewayOrderId: gatewayOrder.id,
        amount: gatewayOrder.amount,
        currency: gatewayOrder.currency,
        keyId
      });
    }

    // Fallback if Razorpay keys are not yet configured in environment
    return NextResponse.json({
      isConfigured: false,
      message: "Razorpay keys not yet configured. Provide RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initiate Razorpay gateway order." },
      { status: 500 }
    );
  }
}
