import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type Amount = { raw: string; formatted: string };

export type ChainStatus = {
  network: string;
  chainId: number;
  block: number;
  readAt: string;
  contracts: Record<string, { address: string; explorer: string }>;
  protocol: {
    vaultBalance: Amount;
    totalOutstanding: Amount;
    globalMax: Amount;
    starterCap: Amount;
    feeBpsDefault: number;
    lenderShareBpsDefault: number;
    settleThreshold: Amount;
  };
  summary: {
    splitters: number;
    loans: number;
    openLoans: number;
    repaidLoans: number;
    lifetimeRevenue: Amount;
    unsettled: Amount;
    sellerReceipts: Amount;
  };
  splitters: Array<{
    address: string;
    explorer: string;
    agent: string;
    payout: string;
    lenderShareBps: number;
    agentClaimable: Amount;
    unsettled: Amount;
    tokenBalance: Amount;
    lastSettledBalance: Amount;
    lifetimeRevenue: Amount;
    loanActive: boolean;
  }>;
  loans: Array<{
    loanId: string;
    splitter: string;
    splitterExplorer: string;
    principal: Amount;
    repaid: Amount;
    outstanding: Amount;
    progressBps: number;
    feeBps: number;
    lenderShareBps: number;
    dueDate: number;
    delinquent: boolean;
    flagged: boolean;
    active: boolean;
  }>;
  repayments: Array<{
    transaction: string;
    explorer: string;
    block: number;
    loanId: string;
    amount: Amount;
  }>;
  settlements: Array<{
    transaction: string;
    explorer: string;
    block: number;
    revenue: Amount;
    lenderShare: Amount;
    agentShare: Amount;
  }>;
  receipts: Array<{
    transaction: string;
    explorer: string;
    block: number;
    from: string;
    amount: Amount;
  }>;
  loansOpened: Array<{
    transaction: string;
    explorer: string;
    block: number;
    loanId: string;
    principal: Amount;
    feeBps: number;
  }>;
};

export type DemoStep = { step: string; ok: boolean; detail: string };
export type DemoResult = {
  ok: boolean;
  error?: string;
  network?: string;
  payer?: string;
  amount?: string;
  steps: DemoStep[];
  treasury?: {
    vault: string;
    vaultBalance: string;
    vaultBalanceFormatted: string;
    agentClaimable: string;
    agentClaimableFormatted: string;
  };
};

export type ChainState = {
  data: ChainStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const ChainContext = createContext<ChainState | null>(null);

/**
 * Holds a single `/api/status` poll for the whole app so navigating between
 * routes does not restart the request or flash loading states.
 */
export function ChainDataProvider({
  children,
  pollMs = 15_000,
}: {
  children: ReactNode;
  pollMs?: number;
}) {
  const [data, setData] = useState<ChainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/status', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Status endpoint returned ${response.status}`);
      const payload = (await response.json()) as ChainStatus;
      if (!mounted.current) return;
      setData(payload);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load, pollMs]);

  /**
   * Vercel Hobby only allows daily crons, so an open dashboard nudges the
   * keeper every 45s. The endpoint only settles revenue already above the
   * threshold, and ignores the call when it has just run.
   */
  useEffect(() => {
    const keepAlive = () => {
      void fetch('/api/keeper?auto=1', { method: 'GET' }).catch(() => undefined);
    };
    const first = window.setTimeout(keepAlive, 4_000);
    const timer = window.setInterval(keepAlive, 45_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <ChainContext.Provider value={{ data, error, loading, refresh: load }}>
      {children}
    </ChainContext.Provider>
  );
}

export function useChainStatus(): ChainState {
  const context = useContext(ChainContext);
  if (!context) {
    throw new Error('useChainStatus must be used inside <ChainDataProvider>.');
  }
  return context;
}

/** Stages the server reports in order, shown while the run is in flight. */
const PHASES = [
  'Requesting the resource',
  'Receiving the 402 challenge',
  'Checking USDC allowance',
  'Signing the EIP-3009 authorization',
  'Paying and routing the receipt',
  'Settling the lender share',
];

export function useDemoPayment() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState(-1);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  /**
   * The server only answers once the whole flow has finished, which leaves the
   * button showing "Running…" for as long as the chain takes. Advancing a phase
   * clock on a timer gives feedback while the request is outstanding. The server
   * remains the source of truth: once it replies, its own step list replaces this.
   */
  useEffect(() => {
    if (!running) return undefined;
    setPhase(0);
    setStartedAt(Date.now());
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      // Front-load so the first stages move quickly, then stretch out.
      const index = Math.min(PHASES.length - 1, Math.floor(elapsed / 2600));
      setPhase((current) => (index > current ? index : current));
    }, 400);
    return () => clearInterval(timer);
  }, [running]);

  const run = useCallback(async (amount: string) => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/demo/buy?amount=${amount}`, {
        method: 'POST',
        headers: { 'x-keeper-secret': 'dashboard' },
      });
      const payload = (await response.json()) as DemoResult;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Demo payment failed (${response.status})`);
      }
      setResult(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }, []);

  return {
    run,
    running,
    result,
    error,
    phase,
    phases: PHASES,
    elapsedMs: startedAt === null ? null : Date.now() - startedAt,
  };
}

export const shortAddress = (value: string) =>
  value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

export const usdc = (value: Amount | undefined) => (value ? `${value.formatted} USDC` : '—');
