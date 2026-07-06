"use client";

import { useWebSocket } from "@/hooks/useWebSocket";
import { mockSocketFactory } from "@/lib/mockSocket";
import { ConnectionStatus } from "@/components/Connection/ConnectionStatus";
import { ChatPanel } from "@/components/Chat/ChatPanel";
import { TimelinePanel } from "@/components/Timeline/TimelinePanel";
import { ContextPanel } from "@/components/Context/ContextPanel";

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-lg border border-edge bg-bg-panel ${className}`}
    >
      <header className="border-b border-edge px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-dim">
        {title}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export default function Page() {
  // Swap `socketFactory` for a real endpoint by removing it and setting `url`.
  const { send, retryNow } = useWebSocket({
    url: "wss://mock.agent.local/stream",
    socketFactory: mockSocketFactory,
    heartbeat: { intervalMs: 10000, timeoutMs: 30000 },
    pollMs: 1000,
  });

  return (
    <div className="flex h-screen flex-col gap-3 p-3">
      <header className="flex items-center justify-between rounded-lg border border-edge bg-bg-panel px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h1 className="text-sm font-semibold text-ink">Agent Console</h1>
        </div>
        <ConnectionStatus onRetry={retryNow} />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Chat">
          <ChatPanel onSend={send} />
        </Panel>
        <Panel title="Timeline">
          <TimelinePanel />
        </Panel>
        <Panel title="Context">
          <ContextPanel />
        </Panel>
      </main>
    </div>
  );
}
