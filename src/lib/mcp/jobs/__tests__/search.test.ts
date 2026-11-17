import { describe, it, expect } from "vitest";
import {
  MAX_TERMS,
  customerName,
  formatAddress,
  matchCustomer,
  matchJob,
  rankCustomers,
  rankJobs,
  searchNote,
  searchTerms,
  termsMatched,
  type CustomerCandidate,
  type JobCandidate,
} from "../search";

// Synthetic data only.
function job(over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    id: "job_1",
    customerId: "cus_gym",
    scheduledStart: "2026-03-09T17:00:00Z",
    workStatus: "complete rated",
    onMyWayAt: null,
    amountCents: 25000,
    street: "99 Aviation Road",
    city: "Queensbury",
    description: "Replace toilet flange",
    jobType: null,
    customer: { id: "cus_gym", name: "Kay Example", company: "Gymco", tags: [] },
    ...over,
  };
}

function customer(over: Partial<CustomerCandidate> = {}): CustomerCandidate {
  return {
    id: "cus_gym",
    firstName: "Kay ",
    lastName: "Example",
    company: "Gymco ",
    phone: "(518) 555-0142",
    city: "Albany",
    notes: null,
    tags: [],
    addresses: [
      { street: "10 Main St", city: "Albany" },
      { street: "99 Aviation Road", city: "Queensbury" },
    ],
    ...over,
  };
}

describe("searchTerms", () => {
  it("turns Dave's sentence into the words that matter", () => {
    expect(searchTerms("find the jobs we did at planet fitness on aviation rd")).toEqual({
      terms: ["planet", "fitness", "aviation"],
      phoneDigits: null,
      dropped: [],
    });
  });

  it("drops street suffixes and splits on punctuation", () => {
    expect(searchTerms("Troy-Schenectady Rd.").terms).toEqual(["troy", "schenectady"]);
    expect(searchTerms("Clifton Country Road").terms).toEqual(["clifton", "country"]);
  });

  it("keeps house numbers and drops one-letter tokens", () => {
    expect(searchTerms("578 Aviation Rd N").terms).toEqual(["578", "aviation"]);
  });

  it("de-duplicates and caps at five words", () => {
    const r = searchTerms("alpha beta gamma delta epsilon zeta alpha");
    expect(MAX_TERMS).toBe(5);
    expect(r.terms).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    expect(r.dropped).toEqual(["zeta"]);
  });

  it("treats seven or more digits as a phone number, not as words", () => {
    expect(searchTerms("who has phone number (518) 555-0142")).toEqual({
      terms: [],
      phoneDigits: "5185550142",
      dropped: [],
    });
  });

  it("finds a phone number among other words", () => {
    expect(searchTerms("Kay at 518.555.0142")).toEqual({ terms: ["kay"], phoneDigits: "5185550142", dropped: [] });
    expect(searchTerms("1-518-555-0142").phoneDigits).toBe("15185550142");
  });

  it("keeps a house number and ZIP code as words, not a phone number", () => {
    expect(searchTerms("578 Aviation Rd Queensbury 12804")).toEqual({
      terms: ["578", "aviation", "queensbury", "12804"],
      phoneDigits: null,
      dropped: [],
    });
  });

  it("does not mistake a date or ZIP+4 for a phone number", () => {
    expect(searchTerms("2026-11-18").phoneDigits).toBeNull();
    expect(searchTerms("12804-1234").phoneDigits).toBeNull();
    expect(searchTerms("555-0142").phoneDigits).toBe("5550142");
  });

  it("returns no words for a question made only of filler", () => {
    expect(searchTerms("find the jobs")).toEqual({ terms: [], phoneDigits: null, dropped: [] });
  });
});

describe("matchJob", () => {
  it("labels where each word matched, in word order", () => {
    expect(matchJob(job(), ["aviation", "gymco", "flange", "queensbury"])).toEqual([
      { term: "aviation", on: "job address" },
      { term: "gymco", on: "customer company" },
      { term: "flange", on: "job description" },
      { term: "queensbury", on: "job town" },
    ]);
  });

  it("matches job type, customer name and customer tags, ignoring case", () => {
    const j = job({
      jobType: "Commercial Service",
      customer: { id: "cus_gym", name: "Kay Example", company: null, tags: ["planet fitness"] },
    });
    expect(matchJob(j, ["commercial", "example", "planet"])).toEqual([
      { term: "commercial", on: "job type" },
      { term: "example", on: "customer name" },
      { term: "planet", on: "customer tag" },
    ]);
  });

  it("returns nothing for a row that only matched a JSON key in the database", () => {
    expect(matchJob(job(), ["name"])).toEqual([]);
  });
});

describe("matchCustomer", () => {
  it("lists exactly the saved addresses that matched", () => {
    const addresses = Array.from({ length: 13 }, (_, i) =>
      i === 9 ? { street: "99 Aviation Road", city: "Queensbury" } : { street: `${i + 1}0 Main St`, city: "Albany" }
    );
    const r = matchCustomer(customer({ addresses }), ["aviation"], null);
    expect(r.matched).toEqual([{ term: "aviation", on: "address" }]);
    expect(r.matchedAddresses).toEqual(["99 Aviation Road, Queensbury"]);
  });

  it("labels name, company, city, address, tag, note and phone", () => {
    const c = customer({ tags: ["planet fitness"], notes: "Locker room sink leaks" });
    expect(matchCustomer(c, ["kay", "gymco", "albany", "planet", "locker"], "5185550142").matched).toEqual([
      { term: "kay", on: "name" },
      { term: "gymco", on: "company" },
      { term: "albany", on: "city" },
      { term: "albany", on: "address" },
      { term: "planet", on: "tag" },
      { term: "locker", on: "note" },
      { term: "5185550142", on: "phone" },
    ]);
  });

  it("matches a phone typed with or without the leading 1", () => {
    expect(matchCustomer(customer({ phone: "15185550142" }), [], "5185550142").matched).toEqual([
      { term: "5185550142", on: "phone" },
    ]);
    expect(matchCustomer(customer({ phone: "518-555-0142" }), [], "15185550142").matched).toEqual([
      { term: "15185550142", on: "phone" },
    ]);
    expect(matchCustomer(customer({ phone: null }), [], "5185550142").matched).toEqual([]);
  });
});

describe("ranking", () => {
  it("puts jobs matching more words first, then newest first, undated last", () => {
    const one = (id: string, when: string | null) => ({
      job: job({ id, scheduledStart: when }),
      matched: [{ term: "aviation", on: "job address" as const }],
    });
    const two = {
      job: job({ id: "job_two", scheduledStart: "2024-01-01T15:00:00Z" }),
      matched: [
        { term: "aviation", on: "job address" as const },
        { term: "gymco", on: "customer company" as const },
      ],
    };
    const ranked = rankJobs([one("job_old", "2025-01-01T15:00:00Z"), one("job_none", null), two, one("job_new", "2026-01-01T15:00:00Z")]);
    expect(ranked.map((r) => r.job.id)).toEqual(["job_two", "job_new", "job_old", "job_none"]);
  });

  it("puts customers matching more words first, then by name", () => {
    const row = (id: string, firstName: string, terms: string[]) => ({
      customer: customer({ id, firstName, lastName: null }),
      matched: terms.map((term) => ({ term, on: "name" as const })),
      matchedAddresses: [],
    });
    const ranked = rankCustomers([row("c1", "Zed", ["a"]), row("c2", "Amy", ["a"]), row("c3", "Max", ["a", "b"])]);
    expect(ranked.map((r) => r.customer.id)).toEqual(["c3", "c2", "c1"]);
  });
});

describe("termsMatched", () => {
  it("splits the words into matched and unmatched, keeping their order", () => {
    expect(termsMatched(["planet", "fitness", "aviation"], [[{ term: "aviation" }], [{ term: "aviation" }]])).toEqual({
      matchedTerms: ["aviation"],
      unmatchedTerms: ["planet", "fitness"],
    });
  });
});

describe("searchNote", () => {
  it("asks for something to search when there are no words", () => {
    expect(searchNote("jobs", [], [], [], 0, null, false)).toBe(
      "Give a street, town, business or customer name, or kind of work to search for. To find jobs by phone number, use find_customer, then get_customer_history."
    );
    expect(searchNote("customers", [], [], [], 0, null, false)).toBe(
      "Give a name, business, street, town or phone number to search for."
    );
  });

  it("asks for another detail when nothing matched", () => {
    expect(searchNote("jobs", ["zebra", "quartz"], [], ["zebra", "quartz"], 0, null, false)).toBe(
      'Nothing in Trinity\'s records matched "zebra", "quartz". Ask the user for another detail: the street or town, the customer\'s name, or roughly when the work was done.'
    );
  });

  it("does not claim nothing matched when a query hit its cap", () => {
    expect(searchNote("jobs", ["zebra"], [], ["zebra"], 0, null, true)).toBe(
      'Nothing among the records checked matched "zebra", but some words matched more records than one search covers. Ask the user for a date, house number or customer name.'
    );
    expect(searchNote("customers", ["zebra"], [], ["zebra"], 0, null, true)).toBe(
      'Nothing among the records checked matched "zebra", but some words matched more records than one search covers. Ask the user for the customer\'s name or street.'
    );
  });

  it("tells ChatGPT to confirm a partial match", () => {
    expect(searchNote("jobs", ["planet", "fitness", "aviation"], ["aviation"], ["planet", "fitness"], 10, null, false)).toBe(
      'Nothing in Trinity\'s records mentions "planet", "fitness". These jobs matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.'
    );
  });

  it("softens the partial-match opening when capped", () => {
    expect(searchNote("jobs", ["planet", "aviation"], ["aviation"], ["planet"], 10, null, true)).toBe(
      'None of the records checked mention "planet". These jobs matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer. Some words matched more records than one search covers, so this list may be incomplete; ask the user for a date, house number or customer name to narrow it down.'
    );
  });

  it("says nothing when every word matched", () => {
    expect(searchNote("customers", ["smith"], ["smith"], [], 3, null, false)).toBeUndefined();
  });

  it("warns the list may be incomplete when capped, even with every word matched", () => {
    expect(searchNote("customers", ["smith"], ["smith"], [], 3, null, true)).toBe(
      "Some words matched more records than one search covers, so this list may be incomplete; ask the user for the customer's name or street to narrow it down."
    );
  });

  it("adds the truncation advice, alone or after the partial-match note", () => {
    expect(searchNote("jobs", ["aviation"], ["aviation"], [], 50, 50, false)).toBe(
      "Showing the first 50; ask the user for a date, house number or customer name to narrow it down."
    );
    expect(searchNote("customers", ["smith", "zz"], ["smith"], ["zz"], 25, 25, false)).toBe(
      'Nothing in Trinity\'s records mentions "zz". These customers matched "smith". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer. Showing the first 25; ask the user for the customer\'s name or street to narrow it down.'
    );
  });

  it("prefers the truncation advice over the incomplete warning", () => {
    expect(searchNote("jobs", ["aviation"], ["aviation"], [], 50, 50, true)).toBe(
      "Showing the first 50; ask the user for a date, house number or customer name to narrow it down."
    );
  });
});

describe("display helpers", () => {
  it("builds a trimmed name, falling back to the company", () => {
    expect(customerName({ firstName: "Kay ", lastName: " Example", company: "Gymco" })).toBe("Kay Example");
    expect(customerName({ firstName: null, lastName: "  ", company: " Gymco " })).toBe("Gymco");
    expect(customerName({ firstName: null, lastName: null, company: null })).toBe("Unnamed customer");
  });

  it("formats an address and skips empty parts", () => {
    expect(formatAddress({ street: " 99 Aviation Road ", city: "Queensbury" })).toBe("99 Aviation Road, Queensbury");
    expect(formatAddress({ street: null, city: "Queensbury" })).toBe("Queensbury");
    expect(formatAddress({ street: null, city: " " })).toBeNull();
  });
});
