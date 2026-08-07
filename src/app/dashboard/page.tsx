import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { DashboardView } from "./DashboardView";

export const dynamic = "force-dynamic";

// The server renders in UTC on Vercel; show the operator their own clock.
const BUSINESS_TIME_ZONE = "America/New_York";

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot();
  const now = new Date();

  return (
    <DashboardView
      snapshot={snapshot}
      asOfDate={now.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: BUSINESS_TIME_ZONE,
      })}
      asOfTime={now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: BUSINESS_TIME_ZONE,
      })}
    />
  );
}
