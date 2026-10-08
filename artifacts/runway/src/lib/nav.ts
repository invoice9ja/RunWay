import { Activity, Blocks, CreditCard, FileCode2, type LucideIcon } from 'lucide-react';

export type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Reads the live count for this route from the status payload. */
  count?: (data: import('@/lib/chain-status').ChainStatus | null) => number | null;
};

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Overview', icon: Activity },
  { path: '/contracts', label: 'Contracts', icon: FileCode2 },
  {
    path: '/transactions',
    label: 'Transactions',
    icon: Blocks,
    count: (data) => {
      if (!data) return null;
      return data.settlements.length + data.receipts.length;
    },
  },
  { path: '/pay', label: 'Buy', icon: CreditCard },
];
