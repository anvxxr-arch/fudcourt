'use client';

import { useState, useMemo, useCallback } from 'react';
import { alpha, themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { EVENT_PRESETS, CHAIN_COLOR } from '@/lib/format';
import { Button, Input, Select, Modal, Label } from '@/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { bulkDeleteTransactions, bulkPatchTransactions, createTransaction, deleteTransaction, patchTransaction } from './client';
import type { Venue } from './client';
import { buildVenueIndex } from './venue-index';

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
  venues: Venue[];
  refreshTx: () => void;
  load: () => void;
};

const CHAIN_OPTIONS = ['Offchain','BSC','Ethereum','Polygon','Solana','Arbitrum','Optimism','Base','Hyperliquid','Binance','Other'];

/**
 * The venue dimension (`venues` — 12 reference rows, keyed by `id`).
 *
 * `transactions.venue_id` was written by the API and rendered raw: the Venue column
 * printed 'binance' instead of 'Binance', and the venue TYPE — the whole point of the
 * dimension — was invisible on every surface. These are the three filter keys that are
 * not a venue id, so a row can always be classified without inventing a venue.
 */
const ALL_VENUES = 'All Venues';
const NO_VENUE = '__none__';
const UNRESOLVED_VENUE = '__unresolved__';

/** Type -> colour for the chip. An unrecognised type falls back to tertiary. */
const VENUE_TYPE_COLOR: Record<string, string> = {
  exchange: themeColor.blue,
  wallet: themeColor.green,
  bank: themeColor.orange,
  other: themeColor.labelTertiary,
};

/** The colour a venue id claims, or undefined when the vocabulary does not hold it. */
function typeColor(type: string | undefined): string {
  return type ? VENUE_TYPE_COLOR[type] ?? themeColor.labelTertiary : themeColor.labelTertiary;
}

export default function TransactionPage({ transactions, venues, refreshTx, load }: Props) {
  const [search, setSearch] = useState('');
  const [filterChain, setFilterChain] = useState('');
  const [filterVenue, setFilterVenue] = useState(ALL_VENUES);
  const [filterDirection, setFilterDirection] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [edit, setEdit] = useState<Tx | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const chains = useMemo(() =>
    Array.from(new Set(transactions.map(t => t.chain).filter(Boolean))),
    [transactions]
  );

  /**
   * id -> venue. The resolution is EXACT: the name and the type come from the `venues`
   * table itself (fetched in the same payload), never from a hardcoded list, so the
   * dictionary cannot drift from the database.
   */
  const venueById = useMemo(() => buildVenueIndex(venues), [venues]);

  /** Every row lands in exactly one bucket — a venue id, NO_VENUE, or UNRESOLVED_VENUE. */
  const venueKeyOf = useCallback(
    (t: Tx) => (!t.venue_id ? NO_VENUE : venueById.has(t.venue_id) ? t.venue_id : UNRESOLVED_VENUE),
    [venueById],
  );

  // Computed over ALL rows, not the filtered set, so the option does not vanish
  // mid-filter (the list must stay stable while the user narrows it).
  const hasUnresolved = useMemo(
    () => transactions.some(t => !!t.venue_id && !venueById.has(t.venue_id)),
    [transactions, venueById],
  );

  const venueOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: ALL_VENUES, label: ALL_VENUES }];
    for (const v of venues) opts.push({ value: v.id, label: `${v.name} · ${v.type}` });
    opts.push({ value: NO_VENUE, label: '— No venue' });
    if (hasUnresolved) opts.push({ value: UNRESOLVED_VENUE, label: '⚠ Unresolved id' });
    return opts;
  }, [venues, hasUnresolved]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return transactions.filter(t => {
      if (search && !`${t.memo} ${t.event} ${t.hash} ${t.wallet_to}`.toLowerCase().includes(s)) return false;
      if (filterChain && filterChain !== 'All Chains' && t.chain !== filterChain) return false;
      if (filterVenue !== ALL_VENUES && venueKeyOf(t) !== filterVenue) return false;
      if (filterDirection && filterDirection !== 'All Directions' && t.direction !== filterDirection) return false;
      return true;
    });
  }, [transactions, search, filterChain, filterVenue, filterDirection, venueKeyOf]);

  /**
   * The cut the dimension unlocks: what actually moved, per venue and per venue type.
   * Counted over the FILTERED rows so it always describes what is on screen, and the
   * three buckets close exactly on `filtered.length` — the trailing `= N rows` is that
   * arithmetic, not a decoration.
   */
  const venueCut = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of filtered) {
      const k = venueKeyOf(t);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const rows = venues
      .filter(v => counts.has(v.id))
      .map(v => ({ id: v.id, name: v.name, type: v.type, count: counts.get(v.id) as number }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
      rows,
      noVenue: counts.get(NO_VENUE) ?? 0,
      unresolved: counts.get(UNRESOLVED_VENUE) ?? 0,
      total: filtered.length,
    };
  }, [filtered, venues, venueKeyOf]);

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

  /** The resolved name, or the raw id — never a blank cell where an id exists. */
  const venueNameOf = (t: Tx) => {
    if (!t.venue_id) return '';
    return venueById.get(t.venue_id)?.name ?? t.venue_id;
  };
  const venueTypeOf = (t: Tx) => (t.venue_id ? venueById.get(t.venue_id)?.type ?? 'unresolved' : '');

  const csv = () => {
    const cols = ['ID','Date','Chain','Venue','Venue Type','Venue Id','Event','Amount','Direction','Memo','Wallet To','Source'];
    const rows = [cols, ...filtered.map(t => [t.id, t.date, t.chain, venueNameOf(t), venueTypeOf(t), t.venue_id, t.event, t.amount_usd, t.direction, t.memo, t.wallet_to, t.source])];
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
        <Select value={filterVenue} onChange={setFilterVenue} options={venueOptions} />
        <Select value={filterDirection} onChange={setFilterDirection} options={['All Directions', 'IN', 'OUT']} />
      </div>

      {/* The venue cut. Every chip is a venue the filtered rows actually touched, with the
          type it is filed under; the trailing total is the three buckets added back up. */}
      {venueCut.total > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[4], marginBottom: space[12] }}>
          <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginRight: space[4] }}>Venue</span>
          {venueCut.rows.map(v => (
            <span key={v.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: space[4],
              border: `1px solid ${themeColor.separator}`, borderRadius: radius[8],
              padding: `1px ${space[4]}px`, whiteSpace: 'nowrap',
            }}>
              <span style={{ fontSize: fontSize[11] }}>{v.name}</span>
              <span style={{ fontSize: fontSize[10], color: typeColor(v.type) }}>{v.type}</span>
              <span style={{ fontSize: fontSize[11], fontWeight: fontWeight.semibold }}>{v.count}</span>
            </span>
          ))}
          {venueCut.noVenue > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: space[4],
              border: `1px dashed ${themeColor.separator}`, borderRadius: radius[8],
              padding: `1px ${space[4]}px`, whiteSpace: 'nowrap', color: themeColor.labelTertiary,
            }}>
              <span style={{ fontSize: fontSize[11] }}>No venue</span>
              <span style={{ fontSize: fontSize[11], fontWeight: fontWeight.semibold }}>{venueCut.noVenue}</span>
            </span>
          )}
          {venueCut.unresolved > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: space[4],
              border: `1px solid ${themeColor.red}`, borderRadius: radius[8],
              padding: `1px ${space[4]}px`, whiteSpace: 'nowrap', color: themeColor.red,
            }}>
              <span style={{ fontSize: fontSize[11] }}>Unresolved id</span>
              <span style={{ fontSize: fontSize[11], fontWeight: fontWeight.semibold }}>{venueCut.unresolved}</span>
            </span>
          )}
          <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>= {venueCut.total} rows</span>
        </div>
      )}

      {showAdd && <TxForm title="Add Transaction" venues={venues} onSave={save} onClose={() => setShowAdd(false)} />}

      <div style={{ overflowX: 'auto' }}>
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
          {filtered.map(t => {
            const v = t.venue_id ? venueById.get(t.venue_id) : undefined;
            return (
            <TR key={t.id} style={{ background: selected.includes(t.id) ? alpha(themeColor.blue, 0.08) : undefined }}>
              <TD style={{ padding: space[8], width: 30 }}><input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} /></TD>
              <TD style={{ padding: space[8] }}>{t.date}</TD>
              <TD style={{ padding: space[8], color: CHAIN_COLOR[t.chain] || themeColor.labelTertiary }}>{t.chain || '—'}</TD>
              <TD style={{ padding: space[8], whiteSpace: 'nowrap' }}>
                {!t.venue_id ? (
                  <span style={{ color: themeColor.labelTertiary }}>—</span>
                ) : v ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[4] }}>
                    <span>{v.name}</span>
                    <span style={{
                      fontSize: fontSize[10], color: typeColor(v.type),
                      background: alpha(typeColor(v.type), 0.12),
                      borderRadius: radius[8], padding: `1px ${space[4]}px`,
                    }}>{v.type}</span>
                  </span>
                ) : (
                  // An id with no venues row. Never hidden and never blanked: the raw id
                  // stays visible so the orphan is fixable, and it is marked as such.
                  <span title={`venue_id '${t.venue_id}' has no row in the venues table`} style={{ color: themeColor.red }}>
                    {t.venue_id}
                    <span style={{ fontSize: fontSize[10] }}> unresolved</span>
                  </span>
                )}
              </TD>
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
            );
          })}
        </TBody>
      </Table>
      </div>

      {filtered.length === 0 && <p style={{ color: themeColor.labelTertiary, textAlign: 'center', padding: space[20] }}>No transactions found</p>}
      {edit && <TxForm title={`Edit #${edit.id}`} initial={edit} venues={venues} onSave={(u) => patch(edit.id, u)} onClose={() => setEdit(null)} />}
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

function TxForm({ title, initial, venues, onSave, onClose }: {
  title: string; initial?: Tx | TxDraft; venues: Venue[]; onSave: (tx: TxDraft) => void; onClose: () => void;
}) {
  const [date, setDate] = useState(initial?.date || new Date().toISOString().slice(0, 10));
  const [chain, setChain] = useState(initial?.chain || 'Offchain');
  const [venue, setVenue] = useState(initial?.venue_id || '');
  const [event, setEvent] = useState(initial?.event || 'Other');
  const [amount, setAmount] = useState(String(initial?.amount_usd ?? ''));
  const [memo, setMemo] = useState(initial?.memo || '');
  const [to, setTo] = useState(initial?.wallet_to || '');

  /**
   * The venue is CHOSEN from the dimension, not typed: a free-text field is how a
   * transaction acquires a venue_id that matches no row (the unresolved case above).
   * A value already on the record that is NOT in the dimension is kept as an option
   * rather than silently dropped, so editing an old row cannot rewrite its venue.
   */
  const venueOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: '— none —' }];
    for (const v of venues) opts.push({ value: v.id, label: `${v.name} · ${v.type}` });
    if (venue && !venues.some(v => v.id === venue)) opts.push({ value: venue, label: `${venue} (not in venues)` });
    return opts;
  }, [venues, venue]);

  return (
    <Modal title={title} onClose={onClose} width={480}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: space[8], marginBottom: space[8] }}>
        <div><Label>Date</Label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: '100%', background: themeColor.bgBase, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], boxSizing: 'border-box' }} /></div>
        <div><Label>Chain</Label><Select value={chain} onChange={setChain} options={CHAIN_OPTIONS} /></div>
        <div><Label>Venue</Label><Select value={venue} onChange={setVenue} options={venueOptions} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: space[8], marginBottom: space[8] }}>
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
