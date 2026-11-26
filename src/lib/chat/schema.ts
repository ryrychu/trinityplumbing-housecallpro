// The shape of a site's /chat-knowledge.json, version 1. The site builds the
// file (trinity-plumbing-service: src/lib/chat-knowledge.ts); this checks it.
// Field names and limits must match on both sides; the site's test carries a
// strict copy of this schema. Spec: docs/superpowers/specs/2026-11-26-site-chatbot-design.md
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const url = z.string().url().max(300);

export const chatKnowledgeSchema = z.object({
  version: z.literal(1),
  business: z.object({
    name: text(100),
    phone: text(30),
    hours: text(200),
    serviceArea: z.array(text(80)).min(1).max(500),
  }),
  prices: z
    .array(
      z.object({
        category: text(100),
        item: text(150),
        // The site's own wording: "from $75", "$3,300–$5,400", "Custom quote".
        price: text(60),
        note: text(300).optional(),
      })
    )
    .min(1)
    .max(500),
  pricesUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  services: z.array(z.object({ name: text(100), summary: text(400), url })).max(100),
  links: z.object({ pricing: url, contact: url, financing: url.optional() }),
});

export type ChatKnowledge = z.infer<typeof chatKnowledgeSchema>;

/** The validated file, or null if it doesn't match version 1. Unknown fields are dropped. */
export function parseKnowledge(value: unknown): ChatKnowledge | null {
  const result = chatKnowledgeSchema.safeParse(value);
  return result.success ? result.data : null;
}
