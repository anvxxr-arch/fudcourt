'use client';
/**
 * ui-progress-tables.tsx — ChildOrderTable + FillTable + EventTable (PRD §85, §86).
 * Split from ui-progress.tsx; re-exported through ./ui-progress and ./ui.
 */
import { themeColor, fontWeight } from '@/styles/tokens';
import { Card } from '@/ui/primitives';
import { StatusPill } from '@/ui/status-pill';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import {
  type ChildOrderRecord,
  type ExecutionEventRecord,
  type FillRecord,
} from '@/lib/executor';
import {
  formatMoney,
  formatPrice,
  formatQty,
  formatTimestamp,
} from './shapers';
import { h3Style, noteStyle, tdStyle, thStyle } from './ui-shared';

export function ChildOrderTable({ orders }: { orders: ChildOrderRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>CHILD ORDERS · {orders.length}</h3>
      {orders.length === 0 && <p style={noteStyle}>no child orders yet — the worker plans them when the execution starts</p>}
      {orders.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Client Order Id</TH>
              <TH style={thStyle}>Status</TH>
              <TH style={thStyle}>Side</TH>
              <TH style={thStyle}>Type</TH>
              <TH align="right" style={thStyle}>Price</TH>
              <TH align="right" style={thStyle}>Qty</TH>
              <TH align="right" style={thStyle}>Filled</TH>
              <TH style={thStyle}>Leg</TH>
            </TR>
          </THead>
          <TBody>
            {orders.map((order) => (
              <TR key={order.id}>
                <TD style={{ ...tdStyle, color: themeColor.labelTertiary }}>{order.clientOrderId}</TD>
                <TD style={tdStyle}><StatusPill status={order.status} /></TD>
                <TD style={{ ...tdStyle, color: order.side === 'buy' ? themeColor.blue : themeColor.red }}>{order.side.toUpperCase()}</TD>
                <TD style={tdStyle}>{order.type}</TD>
                <TD align="right" mono style={tdStyle}>{formatPrice(order.price)}</TD>
                <TD align="right" mono style={tdStyle}>{formatQty(order.quantity)}</TD>
                <TD align="right" mono style={tdStyle}>{formatQty(order.filledQuantity)}</TD>
                <TD style={{ ...tdStyle, color: order.isExit ? themeColor.blue : themeColor.labelTertiary }}>{order.isExit ? 'exit' : 'entry'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

export function FillTable({ fills }: { fills: FillRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>FILLS · {fills.length}</h3>
      {fills.length === 0 && <p style={noteStyle}>no fills recorded</p>}
      {fills.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Time</TH>
              <TH align="right" style={thStyle}>Price</TH>
              <TH align="right" style={thStyle}>Qty</TH>
              <TH align="right" style={thStyle}>Quote</TH>
              <TH align="right" style={thStyle}>Fee</TH>
              <TH style={thStyle}>Trade Id</TH>
            </TR>
          </THead>
          <TBody>
            {fills.map((fill) => (
              <TR key={fill.id}>
                <TD style={{ ...tdStyle, color: themeColor.labelTertiary }}>{formatTimestamp(fill.timestamp)}</TD>
                <TD align="right" mono style={tdStyle}>{formatPrice(fill.price)}</TD>
                <TD align="right" mono style={tdStyle}>{formatQty(fill.quantity)}</TD>
                <TD align="right" mono style={tdStyle}>{formatMoney(fill.quoteQuantity)}</TD>
                <TD align="right" mono style={tdStyle}>{formatMoney(fill.fee)} {fill.feeAsset}</TD>
                <TD style={{ ...tdStyle, color: themeColor.labelTertiary }}>{fill.exchangeTradeId}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

export function EventTable({ events }: { events: ExecutionEventRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>EVENT LOG · {events.length}</h3>
      {events.length === 0 && <p style={noteStyle}>no events recorded</p>}
      {events.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Time</TH>
              <TH style={thStyle}>Event</TH>
              <TH style={thStyle}>Payload</TH>
            </TR>
          </THead>
          <TBody>
            {events.map((event) => (
              <TR key={event.id}>
                <TD style={{ ...tdStyle, color: themeColor.labelTertiary }}>{formatTimestamp(event.createdAt)}</TD>
                <TD style={{ ...tdStyle, color: themeColor.blue, fontWeight: fontWeight.bold }}>{event.name}</TD>
                <TD mono style={{ ...tdStyle, color: themeColor.labelTertiary }}>{JSON.stringify(event.payload)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
