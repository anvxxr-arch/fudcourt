'use client';
import { useT } from '@/lib/i18n/t';

import { themeColor, radius, target } from '@/styles/tokens';

/**
 * Flips the `dark` class on `<html>` and persists the choice. The inline
 * script in the root layout already applied the same preference before
 * hydration, so this simply mirrors it back to storage when the user chooses.
 */
export function ThemeToggle() {
  const t = useT();
  const toggle = () => {
    const next = document.documentElement.classList.toggle('dark') ? 'dark' : 'light';
    localStorage.theme = next;
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('nav.theme.toggle')}
      className="fc-focusable"
      style={{
        minWidth: target.min,
        minHeight: target.min,
        background: themeColor.bgSecondary,
        color: themeColor.labelPrimary,
        border: `1px solid ${themeColor.separator}`,
        borderRadius: radius[8],
        cursor: 'pointer',
      }}
    >
      ◐
    </button>
  );
}
