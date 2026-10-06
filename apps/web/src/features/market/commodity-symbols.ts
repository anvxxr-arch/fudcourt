/**
 * Commodity contract (server-safe) — the pure data behind the
 * /market/commodity section and /api/market/commodity.
 *
 * NOTE: this module MUST stay free of 'use client' and of client-only imports
 * (QuoteBoard, react, …). The API route imports from here; importing from
 * '@/features/market/commodity' (a 'use client' module) made Next resolve the
 * client boundary at runtime, so every named import arrived as a stub and the
 * route threw before responding (500 with an empty body).
 *
 * Same Yahoo Finance chart endpoint as the stock family; the symbols are
 * front-month futures (`=F`). Grouped metals / energy / agriculture so the
 * board reads as a market map rather than a symbol dump. Every symbol below was
 * verified live to return a quote.
 */
import { QUOTE_TTL_MS } from '@/features/market/clients';
export type CommodityGroup = 'Metals' | 'Energy' | 'Agriculture';
export type CommoditySpec = { symbol: string; label: string; group: CommodityGroup };
export const COMMODITIES: readonly CommoditySpec[] = [
  { symbol: 'GC=F', label: 'Gold', group: 'Metals' },
  { symbol: 'SI=F', label: 'Silver', group: 'Metals' },
  { symbol: 'HG=F', label: 'Copper', group: 'Metals' },
  { symbol: 'PL=F', label: 'Platinum', group: 'Metals' },
  { symbol: 'CL=F', label: 'Crude Oil (WTI)', group: 'Energy' },
  { symbol: 'BZ=F', label: 'Brent Crude', group: 'Energy' },
  { symbol: 'NG=F', label: 'Natural Gas', group: 'Energy' },
  { symbol: 'ZC=F', label: 'Corn', group: 'Agriculture' },
  { symbol: 'ZW=F', label: 'Wheat', group: 'Agriculture' },
  { symbol: 'ZS=F', label: 'Soybeans', group: 'Agriculture' },
  { symbol: 'KC=F', label: 'Coffee', group: 'Agriculture' },
  { symbol: 'SB=F', label: 'Sugar #11', group: 'Agriculture' },
];
export const COMMODITY_SYMBOLS = COMMODITIES.map((c) => c.symbol);
export const COMMODITY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  COMMODITIES.map((c) => [c.symbol, c.label]),
);
export const COMMODITY_TTL_MS = QUOTE_TTL_MS;
