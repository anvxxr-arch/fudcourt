import { themeColor, fontSize, space } from '@/styles/tokens';

/**
 * A labelled checkbox row. The executor's composer used five of these with the
 * exact same inline shape; it is the one checkbox atom now.
 */
export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: space[8], fontSize: fontSize[11], color: themeColor.labelPrimary, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
