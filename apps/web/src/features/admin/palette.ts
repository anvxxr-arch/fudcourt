/**
 * The admin family's own role palette — DOMAIN data, not design chrome.
 *
 * Member tiers are labels the guild owner assigns (`admin` / `team` / `member`),
 * so these colours identify a role rather than express a design intent. Two of
 * the four resolve to tokens because their literals were near-duplicates of
 * tokens that already exist: `#f87171` was the second red of `themeColor.red`
 * (it now renders `#ff6b6b`) and `#4ade80` was the second green of
 * `themeColor.green` (it now renders `#3ddc97`) — both authorized by the
 * migration's normalization table, the only two pixel changes here. `#60a5fa`
 * has no token and must not be collapsed onto one — it is a fourth tier
 * colour, not a near-duplicate of `themeColor.blue`.
 */
import { themeColor } from '@/styles/tokens';

export const TIER_COLOR: Record<string, string> = {
  admin: themeColor.red,
  team: themeColor.green,
  member: '#60a5fa',
  public: themeColor.labelTertiary,
};
