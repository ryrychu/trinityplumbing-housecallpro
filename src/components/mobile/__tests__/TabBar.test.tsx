import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

import { TabBar } from "../TabBar";

describe("TabBar", () => {
  it("renders all five tabs", () => {
    pathnameMock.mockReturnValue("/app/today");
    render(<TabBar />);
    for (const label of ["Today", "Schedule", "Customers", "Money", "Dispatch"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("marks the current tab as current for screen readers", () => {
    pathnameMock.mockReturnValue("/app/money");
    render(<TabBar />);
    expect(screen.getByRole("link", { name: /Money/ })).toHaveAttribute("aria-current", "page");
  });

  // A job detail screen is reached from Today; the tab must stay lit while the
  // user is down inside that branch.
  it("keeps Today lit on a job detail route", () => {
    pathnameMock.mockReturnValue("/app/jobs/job_3417");
    render(<TabBar />);
    expect(screen.getByRole("link", { name: /Today/ })).toHaveAttribute("aria-current", "page");
  });

  // "/app/customers-archive".startsWith("/app/customers") is true, so a naive
  // prefix check would light Customers for a route that isn't actually under
  // it. Matching requires an exact hit or a "/" boundary right after the prefix.
  it("does not light Customers for a sibling route sharing its prefix", () => {
    pathnameMock.mockReturnValue("/app/customers-archive");
    render(<TabBar />);
    expect(screen.getByRole("link", { name: /Customers/ })).not.toHaveAttribute("aria-current");
  });
});

describe("TabBar on the sign-in screen", () => {
  // /app/login sits under the same layout as the tabs, so it inherited this
  // bar: a signed-out visitor was shown five tabs that all bounce straight
  // back to the login they were already looking at.
  it("renders nothing on the login screen", () => {
    pathnameMock.mockReturnValue("/app/login");
    const { container } = render(<TabBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders on every other screen", () => {
    pathnameMock.mockReturnValue("/app/today");
    const { container } = render(<TabBar />);
    expect(container).not.toBeEmptyDOMElement();
  });

  // A prefix match would hide the bar for anything merely starting with the
  // login path, so the check is exact.
  it("does not hide on a route that merely starts with the login path", () => {
    pathnameMock.mockReturnValue("/app/login-help");
    render(<TabBar />);
    expect(screen.getByText("Today")).toBeInTheDocument();
  });
});
