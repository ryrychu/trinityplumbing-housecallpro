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
});
