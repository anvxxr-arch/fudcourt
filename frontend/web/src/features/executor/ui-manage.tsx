'use client';
/**
 * ui-manage.tsx — entry re-exporting the manage panels (split modules):
 *
 *   ui-history.tsx   ExecutorHistory (§22), ExecutorOverview
 *   ui-accounts.tsx  ExecutorAccounts (§87)
 *   ui-settings.tsx  ExecutorSettings (§88)
 *
 * Import from '@/features/executor/ui' — never the section modules directly.
 */
export { ExecutorHistory, ExecutorOverview } from './ui-history';
export { ExecutorAccounts } from './ui-accounts';
export { ExecutorSettings } from './ui-settings';
