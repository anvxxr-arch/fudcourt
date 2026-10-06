'use client';

import { color, radius, target } from '@/styles/tokens';

/**
 * Flips the `dark` class on `<html>` and persists the choice. The inline
 * script in the root layout already applied the same preference before
 * hydration, so this simply mirrors it back to storage when the user chooses.
 */
export function ThemeToggle() {
  const toggle = () => {
    const next = document.documentElement.classList.toggle('dark') ? 'dark' : 'light';
    localStorage.theme = next;
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="fc-focusable"
      style={{
        minWidth: target.min,
        minHeight: target.min,
        background: color.bgSecondary,
        color: color.labelPrimary,
        border: `1px solid ${color.separator}`,
        borderRadius: radius[8],
        cursor: 'pointer',
      }}
    >
      ◐
    </button>
  );
}
