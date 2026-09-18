'use client';

import { useState, useMemo, useCallback } from 'react';
import { C, EVENT_PRESETS, CHAIN_COLOR } from '../../lib/ui/shared';
import { Button, Input, Select, Modal, Label } from './ui';

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
    await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
    refresh();
  };

  const bulkDel = async () => {
    if (!selected.length || !confirm(`Delete ${selected.length}?`)) return;
    await fetch('/api/transactions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected }) });
    setSelected([]); refresh();
  };

  const save = async (tx: Partial<Tx>) => {
    await fetch('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tx) });
    setShowAdd(false); refresh();
  };

  const patch = async (id: number, u: Partial<Tx>) => {
    await fetch(`/api/transactions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) });
    setEdit(null); refresh();
  };

  const bulkPatch = async () => {
    if (!selected.length) return;
    const chain = prompt('Chain (skip if empty):');
    const event = prompt('Event (skip if empty):');
    const updates: any = {};
    if (chain) updates.chain = chain;
    if (event) updates.event = event;
    if (!Object.keys(updates).length) return;
    await fetch('/api/transactions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected, updates }) });
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

  const Cell = ({ children, align = 'left', width, style }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; width?: number; style?: React.CSSProperties }) => (
    <td style={{ padding: 6, textAlign: align, width, ...style }}>{children}</td>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button onClick={() => setShowAdd(!showAdd)} size="sm">+ Add TX</Button>
          <Button onClick={csv} variant="ghost" size="sm">📥 CSV</Button>
          {selected.length > 0 && (
            <>
              <Button onClick={bulkDel} variant="danger" size="sm">🗑️ Delete ({selected.length})</Button>
              <Button onClick={bulkPatch} variant="ghost" size="sm">✏️ Edit ({selected.length})</Button>
            </>
          )}
        </div>
        <span style={{ color: C.dim, fontSize: 11 }}>{filtered.length} of {transactions.length} shown</span>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <Input value={search} onChange={setSearch} placeholder="🔍 Search memo/event/hash..." style={{ flex: 1, minWidth: 200 }} />
        <Select value={filterChain} onChange={setFilterChain} options={['All Chains', ...chains]} />
        <Select value={filterDirection} onChange={setFilterDirection} options={['All Directions', 'IN', 'OUT']} />
      </div>

      {showAdd && <TxForm title="Add Transaction" onSave={save} onClose={() => setShowAdd(false)} />}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim }}>
            <Cell width={30}><input type="checkbox" checked={filtered.length > 0 && filtered.every(t => selected.includes(t.id))} onChange={toggleAll} /></Cell>
            <Cell>Date</Cell><Cell>Chain</Cell><Cell>Venue</Cell><Cell>Event</Cell><Cell>Memo</Cell>
            <Cell align="right">Amount</Cell><Cell align="center">Actions</Cell>
          </tr>
        </thead>
        <tbody>
          {filtered.map(t => (
            <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}`, background: selected.includes(t.id) ? 'rgba(61,220,151,0.08)' : undefined }}>
              <Cell><input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} /></Cell>
              <Cell>{t.date}</Cell>
              <Cell style={{ color: CHAIN_COLOR[t.chain] || C.dim }}>{t.chain || '—'}</Cell>
              <Cell style={{ color: C.dim }}>{t.venue_id || '—'}</Cell>
              <Cell>{t.event}</Cell>
              <Cell style={{ color: C.dim, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.memo || '—'}</Cell>
              <Cell align="right" style={{ color: t.amount_usd > 0 ? C.accent : C.red }}>
                {t.amount_usd > 0 ? '+' : ''}{Number(t.amount_usd || 0).toFixed(2)}
              </Cell>
              <Cell align="center">
                <Button onClick={() => setEdit(t)} variant="ghost" size="sm">✏️</Button>
                <Button onClick={() => del(t.id)} variant="danger" size="sm">🗑️</Button>
              </Cell>
            </tr>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ color: C.dim, textAlign: 'center', padding: 20 }}>No transactions found</p>}
      {edit && <TxForm title={`Edit #${edit.id}`} initial={edit} onSave={(u) => patch(edit.id, u)} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TxForm({ title, initial, onSave, onClose }: {
  title: string; initial?: Record<string, any>; onSave: (tx: any) => void; onClose: () => void;
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div><Label>Date</Label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: '100%', background: C.bg, color: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, boxSizing: 'border-box' }} /></div>
        <div><Label>Chain</Label><Select value={chain} onChange={setChain} options={CHAIN_OPTIONS} /></div>
        <div><Label>Venue</Label><Input value={venue} onChange={setVenue} placeholder="e.g. Binance" /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div><Label>Event</Label><Select value={event} onChange={setEvent} options={EVENT_PRESETS} /></div>
        <div><Label>Amount (USD)</Label><Input value={amount} onChange={setAmount} placeholder="e.g. -100" type="number" /></div>
        <div><Label>Wallet To</Label><Input value={to} onChange={setTo} placeholder="address" /></div>
      </div>
      <div style={{ marginBottom: 12 }}><Label>Memo</Label><textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="..." style={{ width: '100%', background: C.bg, color: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, minHeight: 40, resize: 'vertical', boxSizing: 'border-box' }} /></div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onClose} variant="ghost" size="md">Cancel</Button>
        <Button onClick={() => onSave({ date, chain, venue_id: venue, event, amount_usd: amount, memo, wallet_to: to, source: 'manual' })}>💾 Save</Button>
      </div>
    </Modal>
  );
}
