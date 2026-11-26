// A small, valid version 1 knowledge file, shaped like trinity.plumbing's
// /chat-knowledge.json. Shared by the chat tests.
import type { ChatKnowledge } from "../schema";

export const KNOWLEDGE: ChatKnowledge = {
  version: 1,
  business: {
    name: "Trinity Plumbing & Drains",
    phone: "(518) 348-3032",
    hours: "24/7 emergency service, including nights, weekends and holidays",
    serviceArea: ["Averill Park, NY", "Troy, NY", "Albany, NY"],
  },
  prices: [
    {
      category: "Service Calls & Diagnostics",
      item: "Drain cleaning service call",
      price: "from $75",
      note: "Travel and visual inspection for a drain or clog issue.",
    },
    {
      category: "Service Calls & Diagnostics",
      item: "Leak detection",
      price: "from $225/hr",
      note: "Hourly investigation to locate a hidden leak.",
    },
    { category: "Water Heaters & Tankless", item: "Tank water heater replacement (40–50 gal)", price: "$3,300–$5,400" },
    {
      category: "Faucets & Fixtures",
      item: "Faucet cartridge repair",
      price: "Custom quote",
      note: "Repair a dripping faucet; price varies by part.",
    },
  ],
  pricesUpdated: "2026-11-04",
  services: [
    {
      name: "Drain Cleaning",
      summary: "Clear slow and clogged drains fast with professional equipment and hydro jetting.",
      url: "https://trinity.plumbing/services/drain-cleaning",
    },
  ],
  links: {
    pricing: "https://trinity.plumbing/pricing",
    contact: "https://trinity.plumbing/contact",
    financing: "https://trinity.plumbing/financing",
  },
};
