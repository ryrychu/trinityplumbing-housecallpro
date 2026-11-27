// Sends the tricky questions in src/lib/chat/evalQuestions.ts to the real model
// with a site's real knowledge file, and prints each answer under what a good
// answer looks like, for a person to read before go-live.
//
// Opt-in. It needs a real key for the configured provider: CHAT_AI_KEY (Groq's
// free tier costs nothing) or OPENAI_API_KEY (a few cents a run). It is not a
// test file, so `npm test` never picks it up, and no CI workflow runs it.
//
// Usage (from the repo root):
//   npm run chat:eval                                    # https://trinity.plumbing/chat-knowledge.json
//   npm run chat:eval -- --url https://<preview>/chat-knowledge.json
//   npm run chat:eval -- --file ./chat-knowledge.json    # a copy saved from the browser
//
// Reads CHAT_AI_URL, CHAT_AI_KEY, CHAT_AI_MODEL (or OPENAI_API_KEY and
// OPENAI_CHAT_MODEL) and CHAT_MAX_OUTPUT_TOKENS
// from .env.local or the environment.
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    // Same unquoting as scripts/preview-digest.mts: `vercel env pull` writes values double-quoted.
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}

const configuredKey = process.env.CHAT_AI_KEY?.trim() || process.env.OPENAI_API_KEY;
if (!configuredKey || configuredKey === "[SENSITIVE]") {
  console.error(
    "No usable chat key. Put the real CHAT_AI_KEY (Groq) or OPENAI_API_KEY in .env.local\n" +
      "(a value pulled from Vercel reads [SENSITIVE] and can't be used)."
  );
  process.exit(1);
}

const { parseKnowledge } = await import("@/lib/chat/schema");
const { buildInstructions } = await import("@/lib/chat/prompt");
const { askChatAI, buildChatRequest, chatAiUrl, chatModel } = await import("@/lib/chat/openai");
const { EVAL_QUESTIONS } = await import("@/lib/chat/evalQuestions");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = flag("--file");
const source = file ?? flag("--url") ?? "https://trinity.plumbing/chat-knowledge.json";

let raw: unknown;
try {
  raw = file ? JSON.parse(readFileSync(file, "utf8")) : await (await fetch(source)).json();
} catch (err) {
  console.error(`Couldn't read the knowledge file from ${source}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const knowledge = parseKnowledge(raw);
if (!knowledge) {
  console.error(`The knowledge file from ${source} doesn't match version 1 (src/lib/chat/schema.ts).`);
  process.exit(1);
}

console.log(`Model ${chatModel()} at ${new URL(chatAiUrl()).host}, knowledge from ${source}, ${knowledge.prices.length} prices.`);
const instructions = buildInstructions(knowledge);
let problems = 0;
for (const q of EVAL_QUESTIONS) {
  const answer = await askChatAI(buildChatRequest(instructions, [{ role: "user", text: q.text }]));
  console.log(`\n[${q.id}] ${q.text}`);
  console.log(`  expect:    ${q.expect}${q.emergency ? " (emergency)" : ""}`);
  if (!answer) {
    problems++;
    console.log("  answer:    (none; see the [chat] warning above)");
    continue;
  }
  console.log(`  answer:    ${answer.reply}`);
  const flagRight = answer.emergency === q.emergency;
  if (!flagRight) problems++;
  console.log(`  emergency: ${answer.emergency}${flagRight ? "" : `   <-- expected ${q.emergency}`}`);
}
console.log(
  `\n${EVAL_QUESTIONS.length} questions, ${problems} with no answer or the wrong emergency flag.` +
    " Read every answer above against its expect line before go-live."
);
