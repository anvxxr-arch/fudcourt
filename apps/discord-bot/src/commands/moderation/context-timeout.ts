import { userContext } from "./_context.ts";

/** Right-click a user → Apps → Timeout (10 minutes). */
export default userContext("Timeout", "timeout", { durationSeconds: 600 });
