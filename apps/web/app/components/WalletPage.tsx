'use client';

import { useState } from 'react';
import { C, Wallet, CHAIN_COLOR, EMOJI_PRESETS, COLOR_PRESETS } from '../../lib/ui/shared';
import { Button, Modal, Label, Card } from './ui';

type Props = {
  wallets: Wallet[];
  balanceByWallet: Record<string, number>;
  onSave: (w: Partial<Wallet>) => void;
};

export default function WalletPage({ wallets, balanceByWallet, onSave }: Props) {
  const [edit, setEdit] = useState<Wallet | null>(null);

  return (
    <div>
      <h3 style={{ color: C.accent }}>Wallet Manager</h3>
      <p style={{ color: C.dim, fontSize: 12 }}>Customize alias, emoji, color for each wallet. Changes reflect everywhere instantly.</p>
      {wallets.map(w => (
        <Card key={w.address}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 16 }}>
                <span style={{ fontSize: 20 }}>{w.emoji}</span>{' '}
                <b style={{ color: w.color }}>{w.alias || w.label}</b>
                {w.alias && w.alias !== w.label && <span style={{ color: C.dim, fontSize: 11, marginLeft: 8 }}>({w.label})</span>}
              </div>
              <div style={{ fontSize: 11, color: C.dim, marginTop: 4, wordBreak: 'break-all' }}>{w.address}</div>
              <div style={{ fontSize: 11, color: CHAIN_COLOR[w.chain] || C.dim, marginTop: 2 }}>{w.chain} · ${balanceByWallet[w.label]?.toFixed(2) || '0.00'}</div>
              {w.notes && <div style={{ fontSize: 11, color: C.dim, marginTop: 4, fontStyle: 'italic' }}>{w.notes}</div>}
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
  const [color, setColor] = useState(wallet.color || '#3ddc97');
  const [notes, setNotes] = useState(wallet.notes || '');

  return (
    <Modal title="Edit Wallet" onClose={onClose} width={420}>
      <div style={{ fontSize: 11, color: C.dim, wordBreak: 'break-all', marginBottom: 12 }}>{wallet.address}</div>

      <Label>Alias</Label>
      <input value={alias} onChange={e => setAlias(e.target.value)} placeholder={wallet.label}
        style={{ width: '100%', background: C.bg, color: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }} />

      <Label>Emoji</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {EMOJI_PRESETS.map(e => (
          <button key={e} onClick={() => setEmoji(e)} style={{
            background: emoji === e ? C.accent : C.bg, color: emoji === e ? '#04140f' : C.white,
            border: `1px solid ${emoji === e ? C.accent : C.border}`, borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 16,
          }}>{e}</button>
        ))}
      </div>

      <Label>Color</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {COLOR_PRESETS.map(c => (
          <button key={c} onClick={() => setColor(c)} style={{
            background: c, border: color === c ? '2px solid #fff' : '2px solid transparent',
            borderRadius: 6, width: 28, height: 28, cursor: 'pointer',
          }} />
        ))}
        <input type="color" value={color} onChange={e => setColor(e.target.value)}
          style={{ width: 28, height: 28, background: 'transparent', border: 'none', cursor: 'pointer' }} />
      </div>

      <Label>Notes</Label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional notes..."
        style={{ width: '100%', background: C.bg, color: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', fontSize: 12, marginBottom: 16, minHeight: 50, resize: 'vertical', boxSizing: 'border-box' }} />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onClose} variant="ghost" size="md">Cancel</Button>
        <Button onClick={() => onSave({ address: wallet.address, alias: alias || wallet.label, emoji, color, notes })}>💾 Save</Button>
      </div>
    </Modal>
  );
}
