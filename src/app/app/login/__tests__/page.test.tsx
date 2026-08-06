import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { replaceMock, refreshMock, searchParamsMock, signInWithPasswordMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  searchParamsMock: { get: vi.fn() },
  signInWithPasswordMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock }),
  useSearchParams: () => searchParamsMock,
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: () => ({ auth: { signInWithPassword: signInWithPasswordMock } }),
}));

import LoginPage from "../page";

async function signIn() {
  fireEvent.change(screen.getByPlaceholderText("Email"), {
    target: { value: "info@trinity.plumbing" },
  });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "correct-horse" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await waitFor(() => expect(replaceMock).toHaveBeenCalled());
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInWithPasswordMock.mockResolvedValue({ error: null });
  });

  it("sends the user to the internal ?next path after signing in", async () => {
    searchParamsMock.get.mockReturnValue("/app/jobs/job_123");
    render(<LoginPage />);
    await signIn();
    expect(replaceMock).toHaveBeenCalledWith("/app/jobs/job_123");
  });

  it("falls back to /app/today when there is no next param", async () => {
    searchParamsMock.get.mockReturnValue(null);
    render(<LoginPage />);
    await signIn();
    expect(replaceMock).toHaveBeenCalledWith("/app/today");
  });

  // An attacker who hands someone this login URL with an off-origin `next`
  // (an absolute URL, or the protocol-relative "//host" form Next's router
  // also treats as external) must not be able to bounce a *successful*
  // sign-in off Trinity's own domain — that's a phishing vector aimed at the
  // two people who hold the only credentials to 1,497 customers' names,
  // addresses and phone numbers.
  it.each([["https://evil.example/steal"], ["//evil.example"], ["http://evil.example"]])(
    "rejects an off-origin next=%s and falls back to /app/today",
    async (maliciousNext) => {
      searchParamsMock.get.mockReturnValue(maliciousNext);
      render(<LoginPage />);
      await signIn();
      expect(replaceMock).toHaveBeenCalledWith("/app/today");
    }
  );
});
