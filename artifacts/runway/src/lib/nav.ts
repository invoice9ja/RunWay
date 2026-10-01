import {
  Activity,
  ArrowDownRight,
  Blocks,
  CreditCard,
  FileCode2,
  FlaskConical,
  Landmark,
  Layers3,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Reads the live count for this route from the status payload. */
  count?: (data: import('@/lib/chain-status').ChainStatus | null) => number | null;
};

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Overview', icon: Activity },
  {
    path: '/contracts',
    label: 'Contracts',
    icon: FileCode2,
  },
  {
    path: '/splitters',
    label: 'Splitters',
    icon: Layers3,
    count: (data) => data?.summary.splitters ?? null,
  },
  {
    path: '/advances',
    label: 'Advances',
    icon: Landmark,
    count: (data) => data?.summary.openLoans ?? null,
  },
  {
    path: '/repayments',
    label: 'Repayments',
    icon: ArrowDownRight,
    count: (data) => data?.repayments.length ?? null,
  },
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
  { path: '/x402', label: 'x402 loop', icon: Blocks },
  { path: '/tests', label: 'Test suite', icon: FlaskConical },
  { path: '/threats', label: 'Threats', icon: ShieldAlert },
];
