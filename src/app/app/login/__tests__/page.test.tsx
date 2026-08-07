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

describe("LoginPage while the request is in flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsMock.get.mockReturnValue(null);
  });

  // Holds the sign-in unresolved so the busy state can actually be observed --
  // resolving it immediately means the assertions race the state update.
  function pendingSignIn() {
    let release: (v: { error: null }) => void = () => {};
    signInWithPasswordMock.mockReturnValue(
      new Promise<{ error: null }>((resolve) => {
        release = resolve;
      })
    );
    return () => release({ error: null });
  }

  function submit() {
    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "info@trinity.plumbing" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  }

  it("says it is signing in and disables the button", async () => {
    pendingSignIn();
    render(<LoginPage />);
    submit();

    const button = await screen.findByRole("button", { name: /signing in/i });
    expect(button).toBeDisabled();
  });

  // A second submit while the first is out fires a second sign-in.
  it("locks the fields so the form cannot be edited or resubmitted mid-request", async () => {
    pendingSignIn();
    render(<LoginPage />);
    submit();

    await screen.findByRole("button", { name: /signing in/i });
    expect(screen.getByPlaceholderText("Email")).toBeDisabled();
    expect(screen.getByPlaceholderText("Password")).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute("disabled");
  });

  // The button must NOT return to an enabled "Sign in" between a successful
  // response and the next screen painting: that gap reads as "nothing
  // happened", and pressing it again signs in a second time.
  it("keeps spinning after a successful response, while routing away", async () => {
    const release = pendingSignIn();
    render(<LoginPage />);
    submit();
    await screen.findByRole("button", { name: /signing in/i });

    release();
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  // A rejected password must hand the form back, or the reader is stuck
  // looking at a spinner with no way to try again.
  it("hands the form back after a failed sign-in", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    render(<LoginPage />);
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect/i);
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
    expect(screen.getByPlaceholderText("Email")).toBeEnabled();
  });
});

// A throw is not the same as a returned error: nothing sets busy back, so
// without a catch the button spins forever with nothing on screen saying why.
// A malformed NEXT_PUBLIC_SUPABASE_URL does exactly this -- createBrowserClient
// throws on construction and signInWithPassword is never reached.
describe("LoginPage when the sign-in call throws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsMock.get.mockReturnValue(null);
  });

  function submit() {
    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "info@trinity.plumbing" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  }

  it("hands the form back instead of spinning forever", async () => {
    signInWithPasswordMock.mockRejectedValue(new Error("Failed to fetch"));
    render(<LoginPage />);
    submit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
    expect(screen.getByPlaceholderText("Email")).toBeEnabled();
  });

  // Saying "your password is wrong" when the app never got to ask sends
  // someone off resetting a password that was fine.
  it("does not blame the credentials when the request never completed", async () => {
    signInWithPasswordMock.mockRejectedValue(new Error("Failed to fetch"));
    render(<LoginPage />);
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't reach the sign-in service/i);
    expect(alert).not.toHaveTextContent(/incorrect/i);
  });
});
