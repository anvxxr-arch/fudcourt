'use client';

import { useState } from 'react';
import { color, fontSize, radius, space } from '@/styles/tokens';
import { Wallet, CHAIN_COLOR, EMOJI_PRESETS, COLOR_PRESETS } from '@/styles/shared';
import { Button, Modal, Label, Card } from '@/components/ui/primitives';

type Props = {
  wallets: Wallet[];
  balanceByWallet: Record<string, number>;
  onSave: (w: Partial<Wallet>) => void;
};

export default function WalletPage({ wallets, balanceByWallet, onSave }: Props) {
  const [edit, setEdit] = useState<Wallet | null>(null);

  return (
    <div>
      <h3 style={{ color: color.accent }}>Wallet Manager</h3>
      <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>Customize alias, emoji, color for each wallet. Changes reflect everywhere instantly.</p>
      {wallets.map(w => (
        <Card key={w.address}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: fontSize[16] }}>
                <span style={{ fontSize: fontSize[20] }}>{w.emoji}</span>{' '}
                <b style={{ color: w.color }}>{w.alias || w.label}</b>
                {w.alias && w.alias !== w.label && <span style={{ color: color.textMuted, fontSize: fontSize[11], marginLeft: space[8] }}>({w.label})</span>}
              </div>
              <div style={{ fontSize: fontSize[11], color: color.textMuted, marginTop: space[4], wordBreak: 'break-all' }}>{w.address}</div>
              <div style={{ fontSize: fontSize[11], color: CHAIN_COLOR[w.chain] || color.textMuted, marginTop: 2 }}>{w.chain} · ${balanceByWallet[w.label]?.toFixed(2) || '0.00'}</div>
              {w.notes && <div style={{ fontSize: fontSize[11], color: color.textMuted, marginTop: space[4], fontStyle: 'italic' }}>{w.notes}</div>}
            </div>
            <Button onClick={() => setEdit(w)} variant="ghost" size="sm">✏️ Edit</Button>
          </div>
        </Card>
      ))}

      {edit && (
        <EditWalletModal wallet={edit} onSave={(w) => { onSave(w); setEdit(null); }} onClose={() => setEdit(null)} />
      )}
    </div>
  );
}

function EditWalletModal({ wallet, onSave, onClose }: { wallet: Wallet; onSave: (w: Partial<Wallet>) => void; onClose: () => void }) {
  const [alias, setAlias] = useState(wallet.alias || '');
  const [emoji, setEmoji] = useState(wallet.emoji || '💰');
  const [swatch, setSwatch] = useState(wallet.color || color.accent);
  const [notes, setNotes] = useState(wallet.notes || '');

  return (
    <Modal title="Edit Wallet" onClose={onClose} width={420}>
      <div style={{ fontSize: fontSize[11], color: color.textMuted, wordBreak: 'break-all', marginBottom: space[12] }}>{wallet.address}</div>

      <Label>Alias</Label>
      <input value={alias} onChange={e => setAlias(e.target.value)} placeholder={wallet.label}
        style={{ width: '100%', background: color.bg, color: color.text, border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[8]}px ${space[10]}px`, fontSize: fontSize[13], marginBottom: space[12], boxSizing: 'border-box' }} />

      <Label>Emoji</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4], marginBottom: space[12] }}>
        {EMOJI_PRESETS.map(e => (
          <button key={e} onClick={() => setEmoji(e)} style={{
            background: emoji === e ? color.accent : color.bg, color: emoji === e ? color.textOnAccent : color.text,
            border: `1px solid ${emoji === e ? color.accent : color.border}`, borderRadius: radius[6], padding: `${space[4]}px ${space[8]}px`, cursor: 'pointer', fontSize: fontSize[16],
          }}>{e}</button>
        ))}
      </div>

      <Label>Color</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4], marginBottom: space[12] }}>
        {COLOR_PRESETS.map(c => (
          <button key={c} onClick={() => setSwatch(c)} style={{
            background: c, border: swatch === c ? `2px solid ${color.textInverse}` : '2px solid transparent',
            borderRadius: radius[6], width: space[28], height: space[28], cursor: 'pointer',
          }} />
        ))}
        <input type="color" value={swatch} onChange={e => setSwatch(e.target.value)}
          style={{ width: space[28], height: space[28], background: 'transparent', border: 'none', cursor: 'pointer' }} />
      </div>

      <Label>Notes</Label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional notes..."
        style={{ width: '100%', background: color.bg, color: color.text, border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[8]}px ${space[10]}px`, fontSize: fontSize[12], marginBottom: space[16], minHeight: 50, resize: 'vertical', boxSizing: 'border-box' }} />

      <div style={{ display: 'flex', gap: space[8], justifyContent: 'flex-end' }}>
        <Button onClick={onClose} variant="ghost" size="md">Cancel</Button>
        <Button onClick={() => onSave({ address: wallet.address, alias: alias || wallet.label, emoji, color: swatch, notes })}>💾 Save</Button>
      </div>
    </Modal>
  );
}
