import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';

interface ContractInfo {
  name: string;
  address: string;
  explorerUrl: string;
}

interface AgentInfo {
  id: string;
  splitterAddress: string;
  totalRevenue: string;
  loanStatus: 'active' | 'repaid' | 'delinquent' | 'flagged';
  loanPrincipal?: string;
  loanRepaid?: string;
  watcherStatus: 'ok' | 'flagged';
  lastUpdated: string;
}

const mockAgents: AgentInfo[] = [
  {
    id: 'agent-1',
    splitterAddress: '0x...',
    totalRevenue: '1,234.56 USDC',
    loanStatus: 'active',
    loanPrincipal: '500 USDC',
    loanRepaid: '150 USDC',
    watcherStatus: 'ok',
    lastUpdated: '2 min ago'
  }
];

const contracts: ContractInfo[] = [
  { name: 'RunwayVault', address: '0x...', explorerUrl: 'https://explorer.arc.xyz/address/0x...' },
  { name: 'RunwayFactory', address: '0x...', explorerUrl: 'https://explorer.arc.xyz/address/0x...' },
  { name: 'RevenueSplitter (Agent 1)', address: '0x...', explorerUrl: 'https://explorer.arc.xyz/address/0x...' }
];

export default function StatusPage() {
  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      active: 'default',
      repaid: 'secondary',
      delinquent: 'destructive',
      flagged: 'destructive',
      ok: 'default',
    };
    return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
  };

  return (
    <div className="container mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Runway Status Dashboard</h1>
        <p className="text-muted-foreground mt-2">
          Revenue-routed working capital for AI agents on Arc
        </p>
      </div>

      {/* Contracts Section */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Deployed Contracts</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {contracts.map((contract) => (
            <Card key={contract.name} className="border-muted">
              <CardHeader>
                <CardTitle className="text-lg">{contract.name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="font-mono text-sm break-all">{contract.address}</p>
                <Button variant="outline" size="sm" asChild>
                  <a href={contract.explorerUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View on Explorer
                  </a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Agents Section */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Active Agents</h2>
        <div className="overflow-x-auto">
          <table className="w-full caption-bottom text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left p-4">Agent</th>
                <th className="text-left p-4">Total Revenue</th>
                <th className="text-left p-4">Loan Status</th>
                <th className="text-left p-4">Loan Progress</th>
                <th className="text-left p-4">Watcher</th>
                <th className="text-left p-4">Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {mockAgents.map((agent) => (
                <tr key={agent.id} className="border-b">
                  <td className="p-4 font-mono text-sm">{agent.splitterAddress}</td>
                  <td className="p-4">{agent.totalRevenue}</td>
                  <td className="p-4">{getStatusBadge(agent.loanStatus)}</td>
                  <td className="p-4">
                    {agent.loanPrincipal && agent.loanRepaid && (
                      <div className="w-full bg-secondary rounded-full h-2">
                        <div 
                          className="bg-primary h-2 rounded-full transition-all"
                          style={{ width: `${(parseFloat(agent.loanRepaid) / parseFloat(agent.loanPrincipal)) * 100}%` }}
                        />
                      </div>
                    )}
                  </td>
                  <td className="p-4">{getStatusBadge(agent.watcherStatus)}</td>
                  <td className="p-4 text-muted-foreground">{agent.lastUpdated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Threat Model Summary */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Threat Model Summary</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Payee Swap</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Watcher flags within one polling interval. Revenue between swap and flag is lost.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Wash Trading</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Cap grows only 2× lifetime revenue. Hard global cap bounds exposure.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Borrower Stops</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No revenue = no repayment. Lender loss bounded by cap.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Unaudited</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Prototype only. Own funds only. No external depositors.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Links */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Links</h2>
        <div className="flex flex-wrap gap-4">
          <Button variant="outline" asChild>
            <a href="https://github.com/Mosss-OS/RunWay" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              GitHub Repository
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href="https://arc.xyz" target="_blank" rel="noopener noreferrer">
              Arc Network
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href="https://github.com/coinbase/x402" target="_blank" rel="noopener noreferrer">
              x402 Specification
            </a>
          </Button>
        </div>
      </section>
    </div>
  );
}