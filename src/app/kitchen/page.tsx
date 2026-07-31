import type { Metadata } from "next";
import { KitchenDashboard } from "@/components/kitchen/kitchen-dashboard";

export const metadata: Metadata = {
  title: "Mobile Kitchen Unit | Cinematic AR Restaurant",
  description: "Real-time kitchen order board and prep management display for staff."
};

export default function KitchenPage() {
  return <KitchenDashboard />;
}
