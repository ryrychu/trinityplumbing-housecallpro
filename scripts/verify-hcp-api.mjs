// Throwaway Task 0 verification — confirms the live Housecall Pro API shape.
// Run once, then delete. Reads HOUSECALL_API_KEY from the environment.
//   Git Bash:  set -a; source .env.local; set +a; node scripts/verify-hcp-api.mjs
const key = process.env.HOUSECALL_API_KEY;
if (!key || !key.trim()) {
  console.error("HOUSECALL_API_KEY is not set. Put it in .env.local and source it first.");
  process.exit(1);
}

const BASE = "https://api.housecallpro.com";
const resources = ["customers", "employees", "jobs", "estimates", "invoices"];

for (const resource of resources) {
  try {
    const res = await fetch(`${BASE}/${resource}?page=1&page_size=1`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    console.log(`\n=== ${resource} : HTTP ${res.status} ===`);
    if (body && typeof body === "object") {
      const item = Array.isArray(body[resource]) ? body[resource][0] : undefined;
      if (item) {
        // Strip verbose nested noise so the mapper-relevant fields are visible.
        const clean = JSON.parse(JSON.stringify(item));
        if (Array.isArray(clean.assigned_employees)) {
          clean.assigned_employees = clean.assigned_employees.map((e) => ({
            id: e.id,
            first_name: e.first_name,
          }));
        }
        delete clean.items;
        delete clean.payments;
        delete clean.taxes;
        delete clean.discounts;
        console.log("item keys:", Object.keys(item));
        console.log(JSON.stringify(clean, null, 2));
      } else {
        console.log("no items; body keys:", Object.keys(body));
      }
    } else {
      console.log("non-JSON body:", text.slice(0, 500));
    }
  } catch (err) {
    console.error(`\n=== ${resource} : REQUEST FAILED ===`);
    console.error(err);
  }
}
