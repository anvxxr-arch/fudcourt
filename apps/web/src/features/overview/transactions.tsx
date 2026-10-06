'use client';

import { useState, useMemo, useCallback } from 'react';
import { alpha, themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { EVENT_PRESETS, CHAIN_COLOR } from '@/lib/format';
import { Button, Input, Select, Modal, Label } from '@/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { bulkDeleteTransactions, bulkPatchTransactions, createTransaction, deleteTransaction, patchTransaction } from './client';

type Tx = {
  id: number;
  date: string;
  chain: string;
  asset: string;
  event: string;
  amount_usd: number;
  direction: string;
  memo: string | null;
  wallet_to: string | null;
  hash: string | null;
  url: string | null;
  source: string;
  venue_id: string | null;
  trade_id: string | null;
};

type Props = {
  transactions: Tx[];
  refreshTx: () => void;
  load: () => void;
};

const CHAIN_OPTIONS = ['Offchain','BSC','Ethereum','Polygon','Solana','Arbitrum','Optimism','Base','Hyperliquid','Binance','Other'];

export default function TransactionPage({ transactions, refreshTx, load }: Props) {
  const [search, setSearch] = useState('');
  const [filterChain, setFilterChain] = useState('');
  const [filterDirection, setFilterDirection] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [edit, setEdit] = useState<Tx | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const chains = useMemo(() =>
    Array.from(new Set(transactions.map(t => t.chain).filter(Boolean))),
    [transactions]
  );

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return transactions.filter(t => {
      if (search && !`${t.memo} ${t.event} ${t.hash} ${t.wallet_to}`.toLowerCase().includes(s)) return false;
      if (filterChain && filterChain !== 'All Chains' && t.chain !== filterChain) return false;
      if (filterDirection && filterDirection !== 'All Directions' && t.direction !== filterDirection) return false;
      return true;
    });
  }, [transactions, search, filterChain, filterDirection]);

  const toggle = (id: number) =>
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const toggleAll = () => {
    const ids = filtered.map(t => t.id);
    setSelected(prev => ids.every(id => prev.includes(id))
      ? prev.filter(id => !ids.includes(id))
      : Array.from(new Set([...prev, ...ids]))
    );
  };

  const refresh = useCallback(() => { refreshTx(); load(); }, [refreshTx, load]);

  const del = async (id: number) => {
    if (!confirm(`Delete #${id}?`)) return;
    await deleteTransaction(id);
    refresh();
  };

  const bulkDel = async () => {
    if (!selected.length || !confirm(`Delete ${selected.length}?`)) return;
    await bulkDeleteTransactions(selected);
    setSelected([]); refresh();
  };

  const save = async (tx: TxDraft) => {
    await createTransaction(tx);
    setShowAdd(false); refresh();
  };

  const patch = async (id: number, u: TxDraft) => {
    await patchTransaction(id, u);
    setEdit(null); refresh();
  };

  const bulkPatch = async () => {
    if (!selected.length) return;
    const chain = prompt('Chain (skip if empty):');
    const event = prompt('Event (skip if empty):');
    const updates: TxDraft = {};
    if (chain) updates.chain = chain;
    if (event) updates.event = event;
    if (!Object.keys(updates).length) return;
    await bulkPatchTransactions(selected, updates);
    setSelected([]); refresh();
  };

  const csv = () => {
    const cols = ['ID','Date','Chain','Venue','Event','Amount','Direction','Memo','Wallet To','Source'];
    const rows = [cols, ...filtered.map(t => [t.id, t.date, t.chain, t.venue_id, t.event, t.amount_usd, t.direction, t.memo, t.wallet_to, t.source])];
    const data = rows.map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([data], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `fudcourt_tx_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[12], flexWrap: 'wrap', gap: space[8] }}>
        <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
          <Button onClick={() => setShowAdd(!showAdd)} size="sm">+ Add TX</Button>
          <Button onClick={csv} variant="ghost" size="sm">📥 CSV</Button>
          {selected.length > 0 && (
            <>
              <Button onClick={bulkDel} variant="danger" size="sm">🗑️ Delete ({selected.length})</Button>
              <Button onClick={bulkPatch} variant="ghost" size="sm">✏️ Edit ({selected.length})</Button>
            </>
          )}
        </div>
        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{filtered.length} of {transactions.length} shown</span>
      </div>

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        <Input value={search} onChange={setSearch} placeholder="🔍 Search memo/event/hash..." style={{ flex: 1, minWidth: 200 }} />
        <Select value={filterChain} onChange={setFilterChain} options={['All Chains', ...chains]} />
        <Select value={filterDirection} onChange={setFilterDirection} options={['All Directions', 'IN', 'OUT']} />
      </div>

      {showAdd && <TxForm title="Add Transaction" onSave={save} onClose={() => setShowAdd(false)} />}

      <Table>
        <THead>
          <TR>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular, width: 30 }}><input type="checkbox" checked={filtered.length > 0 && filtered.every(t => selected.includes(t.id))} onChange={toggleAll} /></TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Date</TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Chain</TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Venue</TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Event</TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Memo</TH>
            <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>Amount</TH>
            <TH align="center" style={{ padding: space[8], fontWeight: fontWeight.regular }}>Actions</TH>
          </TR>
        </THead>
        <TBody>
          {filtered.map(t => (
            <TR key={t.id} style={{ background: selected.includes(t.id) ? alpha(themeColor.blue, 0.08) : undefined }}>
              <TD style={{ padding: space[8], width: 30 }}><input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} /></TD>
              <TD style={{ padding: space[8] }}>{t.date}</TD>
              <TD style={{ padding: space[8], color: CHAIN_COLOR[t.chain] || themeColor.labelTertiary }}>{t.chain || '—'}</TD>
              <TD style={{ padding: space[8], color: themeColor.labelTertiary }}>{t.venue_id || '—'}</TD>
              <TD style={{ padding: space[8] }}>{t.event}</TD>
              <TD style={{ padding: space[8], color: themeColor.labelTertiary, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.memo || '—'}</TD>
              <TD align="right" mono style={{ padding: space[8], color: t.amount_usd > 0 ? themeColor.blue : themeColor.red }}>
                {t.amount_usd > 0 ? '+' : ''}{Number(t.amount_usd || 0).toFixed(2)}
              </TD>
              <TD align="center" style={{ padding: space[8] }}>
                <Button onClick={() => setEdit(t)} variant="ghost" size="sm">✏️</Button>
                <Button onClick={() => del(t.id)} variant="danger" size="sm">🗑️</Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      {filtered.length === 0 && <p style={{ color: themeColor.labelTertiary, textAlign: 'center', padding: space[20] }}>No transactions found</p>}
      {edit && <TxForm title={`Edit #${edit.id}`} initial={edit} onSave={(u) => patch(edit.id, u)} onClose={() => setEdit(null)} />}
    </div>
  );
}

type TxDraft = {
  date?: string;
  chain?: string;
  venue_id?: string | null;
  event?: string;
  amount_usd?: string | number;
  memo?: string | null;
  wallet_to?: string | null;
  source?: string;
};

function TxForm({ title, initial, onSave, onClose }: {
  title: string; initial?: Tx | TxDraft; onSave: (tx: TxDraft) => void; onClose: () => void;
}) {
  const [date, setDate] = useState(initial?.date || new Date().toISOString().slice(0, 10));
  const [chain, setChain] = useState(initial?.chain || 'Offchain');
  const [venue, setVenue] = useState(initial?.venue_id || '');
  const [event, setEvent] = useState(initial?.event || 'Other');
  const [amount, setAmount] = useState(String(initial?.amount_usd ?? ''));
  const [memo, setMemo] = useState(initial?.memo || '');
  const [to, setTo] = useState(initial?.wallet_to || '');

  return (
    <Modal title={title} onClose={onClose} width={480}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: space[8], marginBottom: space[8] }}>
        <div><Label>Date</Label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: '100%', background: themeColor.bgBase, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], boxSizing: 'border-box' }} /></div>
        <div><Label>Chain</Label><Select value={chain} onChange={setChain} options={CHAIN_OPTIONS} /></div>
        <div><Label>Venue</Label><Input value={venue} onChange={setVenue} placeholder="e.g. Binance" /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: space[8], marginBottom: space[8] }}>
        <div><Label>Event</Label><Select value={event} onChange={setEvent} options={EVENT_PRESETS} /></div>
        <div><Label>Amount (USD)</Label><Input value={amount} onChange={setAmount} placeholder="e.g. -100" type="number" /></div>
        <div><Label>Wallet To</Label><Input value={to} onChange={setTo} placeholder="address" /></div>
      </div>
      <div style={{ marginBottom: space[12] }}><Label>Memo</Label><textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="..." style={{ width: '100%', background: themeColor.bgBase, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], minHeight: space[40], resize: 'vertical', boxSizing: 'border-box' }} /></div>
      <div style={{ display: 'flex', gap: space[8], justifyContent: 'flex-end' }}>
        <Button onClick={onClose} variant="ghost" size="md">Cancel</Button>
        <Button onClick={() => onSave({ date, chain, venue_id: venue, event, amount_usd: amount, memo, wallet_to: to, source: 'manual' })}>💾 Save</Button>
      </div>
    </Modal>
  );
}
