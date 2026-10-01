import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/app-shell';
import { ChainDataProvider } from '@/lib/chain-status';
import { OverviewPage } from '@/pages/overview';
import { SplittersPage } from '@/pages/splitters';
import { AdvancesPage } from '@/pages/advances';
import { RepaymentsPage } from '@/pages/repayments';
import { TransactionsPage } from '@/pages/transactions';
import { X402Page } from '@/pages/x402';
import { ContractsPage } from '@/pages/contracts';
import { PayPage } from '@/pages/pay';
import { TestsPage } from '@/pages/tests';
import { ThreatsPage } from '@/pages/threats';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

/** Reset scroll to the top whenever the route changes. */
function ScrollToTop() {
  const [location] = useLocation();
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }
  return <span hidden data-route={location} />;
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={OverviewPage} />
      <Route path="/contracts" component={ContractsPage} />
      <Route path="/splitters" component={SplittersPage} />
      <Route path="/advances" component={AdvancesPage} />
      <Route path="/loans" component={AdvancesPage} />
      <Route path="/repayments" component={RepaymentsPage} />
      <Route path="/transactions" component={TransactionsPage} />
      <Route path="/x402" component={X402Page} />
      <Route path="/pay" component={PayPage} />
      <Route path="/tests" component={TestsPage} />
      <Route path="/threats" component={ThreatsPage} />
      <Route path="/status" component={OverviewPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <ChainDataProvider>
            <ScrollToTop />
            {/* The shell lives outside the boundary so a page crash keeps nav. */}
            <RoutedErrorBoundary>
              <AppShell>
                <Routes />
              </AppShell>
            </RoutedErrorBoundary>
          </ChainDataProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
