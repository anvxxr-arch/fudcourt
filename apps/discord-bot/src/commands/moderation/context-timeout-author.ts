import { messageContext } from "./_context.ts";

/** Right-click a message → Apps → Timeout Author (10 minutes). */
export default messageContext("Timeout Author", "timeout", { durationSeconds: 600 });
