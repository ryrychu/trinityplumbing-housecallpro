// What the chat says when it can't answer. Plain words; the bubble always
// shows its own Call and "Send a request" buttons next to these.
export function fallbackReply(phone: string | null): string {
  return phone
    ? `Sorry, I can't answer right now. Call us at ${phone} or send a request and we'll get back to you.`
    : "Sorry, I can't answer right now. Call us or send a request and we'll get back to you.";
}

export const RATE_LIMITED_IP_REPLY =
  "You've sent a lot of messages in a short time. Please call us or send a request and we'll help you directly.";

export const RATE_LIMITED_SITE_REPLY =
  "The chat is busy right now. Please call us or send a request and we'll help you directly.";
