import { redirect } from "next/navigation";

// The dashboard is the only surface this app serves, so the root sends you
// straight to it. (This replaced the leftover create-next-app starter page.)
export default function Home() {
  redirect("/dashboard");
}
