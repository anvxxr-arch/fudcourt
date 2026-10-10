'use client';

import { useMemo, useState } from 'react';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { Wallet, CHAIN_COLOR, EMOJI_PRESETS, COLOR_PRESETS } from '@/lib/format';
import { Button, Modal, Label, Card } from '@/ui/primitives';
import type { Venue } from './client';
import { buildVenueIndex, resolveVenue } from './venue-index';
import WalletNfts from './wallet-nfts';

type Props = {
  wallets: Wallet[];
  venues: Venue[];
  balanceByWallet: Record<string, number>;
  onSave: (w: Partial<Wallet>) => void;
};

export default function WalletPage({ wallets, venues, balanceByWallet, onSave }: Props) {
  const [edit, setEdit] = useState<Wallet | null>(null);

  /**
   * `wallets.chain` stores a presentation string ('BSC', 'Solana') where the
   * dimension's keys are 'bsc'/'solana' — measured on the live DB: 0 of 3 resolve
   * exactly, 3 of 3 resolve folded. So each card names the venue the way the
   * VOCABULARY names it (and keeps the stored chain visible when it differs), shows
   * the TYPE it is filed under, and flags a chain the vocabulary does not know
   * rather than blanking it.
   */
  const venueIndex = useMemo(() => buildVenueIndex(venues), [venues]);

  return (
    <div>
      <h3 style={{ color: themeColor.blue }}>Wallet Manager</h3>
      <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>Customize alias, emoji, color for each wallet. Changes reflect everywhere instantly.</p>
      {wallets.map(w => {
        const venue = resolveVenue(venueIndex, w.chain);
        return (
        <Card key={w.address}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: fontSize[17] }}>
                <span style={{ fontSize: fontSize[20] }}>{w.emoji}</span>{' '}
                <b style={{ color: w.color }}>{w.alias || w.label}</b>
                {w.alias && w.alias !== w.label && <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginLeft: space[8] }}>({w.label})</span>}
              </div>
              <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, marginTop: space[4], wordBreak: 'break-all' }}>{w.address}</div>
              {/* The canonical venue name (or the raw chain, when the vocabulary does not
                  know it), then the TYPE it is filed under. A flex-wrap row so a long name
                  wraps instead of overflowing at 390px. The stored chain stays visible in
                  parentheses only when it differs from the name — the same alias/label idiom
                  the line above uses — so 'BSC' -> 'BSC Main' shows the drift and 'Solana'
                  does not repeat itself. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: space[4], rowGap: space[8], marginTop: 2 }}>
                <span style={{ fontSize: fontSize[11], color: CHAIN_COLOR[w.chain] || themeColor.labelTertiary }}>{venue ? venue.name : w.chain}</span>
                {venue && w.chain !== venue.name && <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>({w.chain})</span>}
                {venue ? (
                  <span style={{
                      display: 'inline-flex', alignItems: 'center', border: `1px solid ${themeColor.separator}`,
                      borderRadius: radius[8], padding: `1px ${space[4]}px`, whiteSpace: 'nowrap',
                      fontSize: fontSize[11], color: themeColor.labelTertiary,
                    }}>{venue.type}</span>
                ) : (
                  <span title="no `venues` row matches this chain — the reference is unresolved" style={{
                    display: 'inline-flex', alignItems: 'center', border: `1px solid ${themeColor.red}`,
                    borderRadius: radius[8], padding: `1px ${space[4]}px`, whiteSpace: 'nowrap',
                    fontSize: fontSize[11], color: themeColor.red,
                  }}>⚠ unresolved</span>
                )}
                <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>· ${balanceByWallet[w.label]?.toFixed(2) || '0.00'}</span>
              </div>
              {w.notes && <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, marginTop: space[4], fontStyle: 'italic' }}>{w.notes}</div>}
              {/* The NFT venue for THIS wallet. The read goes server-side through
                  /api/nft/opensea, so the API key never reaches the browser; the
                  block is one flex-wrap row (no media query) and an unresolved
                  chain or a failed read says so rather than rendering as an empty
                  wallet. */}
              <WalletNfts chain={w.chain} address={w.address} />
            </div>
            <Button onClick={() => setEdit(w)} variant="ghost" size="sm">✏️ Edit</Button>
          </div>
        </Card>
        );
      })}

      {edit && (
        <EditWalletModal wallet={edit} onSave={(w) => { onSave(w); setEdit(null); }} onClose={() => setEdit(null)} />
      )}
    </div>
  );
}

function EditWalletModal({ wallet, onSave, onClose }: { wallet: Wallet; onSave: (w: Partial<Wallet>) => void; onClose: () => void }) {
  const [alias, setAlias] = useState(wallet.alias || '');
  const [emoji, setEmoji] = useState(wallet.emoji || '💰');
  const [swatch, setSwatch] = useState(wallet.color || themeColor.blue);
  const [notes, setNotes] = useState(wallet.notes || '');

  return (
    <Modal title="Edit Wallet" onClose={onClose} width={420}>
      <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, wordBreak: 'break-all', marginBottom: space[12] }}>{wallet.address}</div>

      <Label>Alias</Label>
      <input value={alias} onChange={e => setAlias(e.target.value)} placeholder={wallet.label}
        style={{ width: '100%', background: themeColor.bgBase, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[13], marginBottom: space[12], boxSizing: 'border-box' }} />

      <Label>Emoji</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4], marginBottom: space[12] }}>
        {EMOJI_PRESETS.map(e => (
          <button key={e} onClick={() => setEmoji(e)} style={{
            background: emoji === e ? themeColor.blue : themeColor.bgBase, color: emoji === e ? themeColor.labelOnAccent : themeColor.labelPrimary,
            border: `1px solid ${emoji === e ? themeColor.blue : themeColor.separator}`, borderRadius: radius[8], padding: `${space[4]}px ${space[8]}px`, cursor: 'pointer', fontSize: fontSize[17],
          }}>{e}</button>
        ))}
      </div>

      <Label>Color</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4], marginBottom: space[12] }}>
        {COLOR_PRESETS.map(c => (
          <button key={c} onClick={() => setSwatch(c)} style={{
            background: c, border: swatch === c ? `2px solid ${themeColor.labelOnAccent}` : '2px solid transparent',
            borderRadius: radius[8], width: space[32], height: space[32], cursor: 'pointer',
          }} />
        ))}
        <input type="color" value={swatch} onChange={e => setSwatch(e.target.value)}
          style={{ width: space[32], height: space[32], background: 'transparent', border: 'none', cursor: 'pointer' }} />
      </div>

      <Label>Notes</Label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional notes..."
        style={{ width: '100%', background: themeColor.bgBase, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], marginBottom: space[16], minHeight: 50, resize: 'vertical', boxSizing: 'border-box' }} />

      <div style={{ display: 'flex', gap: space[8], justifyContent: 'flex-end' }}>
        <Button onClick={onClose} variant="ghost" size="md">Cancel</Button>
        <Button onClick={() => onSave({ address: wallet.address, alias: alias || wallet.label, emoji, color: swatch, notes })}>💾 Save</Button>
      </div>
    </Modal>
  );
}
