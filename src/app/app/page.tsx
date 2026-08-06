import { redirect } from "next/navigation";

// The manifest's start_url is /app/today, so an installed app never lands here
// -- but the README advertises /app/* and a person typing the bare path (or
// following a link that drops the tab segment) got a 404 on the app's most
// guessable URL. Today is the first tab and the app's home in every other
// sense, so this is a redirect rather than a duplicate screen.
//
// Discloses nothing either way: Next's "/app/:path*" matcher treats :path* as
// zero-or-more and so covers the bare /app, but even if it did not, this file
// renders no data of its own -- it forwards to /app/today, which middleware
// guards unconditionally. The redirect target is what carries the auth, not
// this page.
export default function AppIndexPage() {
  redirect("/app/today");
}
