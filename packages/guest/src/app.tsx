import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient, PromptRecoveryStore } from "./lib/client";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";

interface Creds {
  link: string;
  name: string;
}

function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "guest";
  } catch {
    return "guest";
  }
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
  const href = window.location.href;
  const i = href.indexOf("#");
  if (i < 0 || i + 1 >= href.length) return null;
  return href.slice(i + 1);
}

export function App(): ReactNode {
  const [client, setClient] = useState<GuestClient | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const credsRef = useRef<Creds | null>(null);
  const promptRecoveryStore = useRef(new PromptRecoveryStore()).current;
  const [recoveryRecords, setRecoveryRecords] = useState(() => [...promptRecoveryStore.records.values()]);
  useEffect(() => promptRecoveryStore.subscribe(() => {
    setRecoveryRecords([...promptRecoveryStore.records.values()]);
    setRecoveryVersion(value => value + 1);
  }), [promptRecoveryStore]);
  const changeDraft = useCallback((roomId: string, value: string) => {
    setDrafts(current => ({ ...current, [roomId]: value }));
  }, []);

  const connect = useCallback((link: string, name: string): void => {
    let next: GuestClient;
    try {
      next = new GuestClient(link, name, promptRecoveryStore);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      next.connect();
    } catch (err) {
      client?.restoreRecoveryOwnership();
      next.close();
      setConnectError(err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // storage unavailable (private mode) — non-fatal
    }
    credsRef.current = { link, name };
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    setConnectError(null);
    setClient((prev) => {
      prev?.close();
      return next;
    });
  }, [promptRecoveryStore, client]);

  const leave = useCallback((): void => {
    setConnectError(null);
    setClient((prev) => {
      prev?.close();
      return null;
    });
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);

  const rejoin = useCallback((): void => {
    const creds = credsRef.current;
    if (creds) connect(creds.link, creds.name);
  }, [connect]);

  // Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const updateHeight = () => {
      document.documentElement.style.setProperty(
        "--viewport-height",
        `${vv.height}px`,
      );
      window.scrollTo(0, 0);
    };

    updateHeight();
    vv.addEventListener("resize", updateHeight);
    vv.addEventListener("scroll", updateHeight);

    return () => {
      vv.removeEventListener("resize", updateHeight);
      vv.removeEventListener("scroll", updateHeight);
    };
  }, []);

  // Deep link: a page load with a hash auto-connects.
  useEffect(() => {
    const link = hashLink();
    if (link) connect(link, storedName());
  }, [connect]);

  useEffect(() => {
    if (!client) document.title = "omp collab";
  }, [client]);

  if (!client) {
    return (
      <ConnectScreen
        defaultName={storedName()}
        error={connectError}
        onConnect={connect}
        recoveries={recoveryRecords}
        onDismissRecovery={id => { promptRecoveryStore.records.delete(id); promptRecoveryStore.changed(); }}
      />
    );
  }
  return <Session client={client} connectError={connectError} onLeave={leave} onRejoin={rejoin} draft={drafts[client.roomId] ?? ""} onDraftChange={value => changeDraft(client.roomId, value)} />;
}

interface SessionProps {
  client: GuestClient;
  connectError: string | null;
  onLeave(): void;
  onRejoin(): void;
  draft: string;
  onDraftChange(value: string): void;
}

function Session({ client, connectError, onLeave, onRejoin, draft, onDraftChange }: SessionProps): ReactNode {
  const snap = useGuestSnapshot(client);
  const [railOpen, setRailOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);

  const subCount = useMemo(
    () => snap.agents.filter((a) => a.kind === "sub").length,
    [snap.agents],
  );

  // Task-card agent chips drill into the same drawer the rail uses.
  const agentIds = useMemo(
    () => new Set(snap.agents.map((a) => a.id)),
    [snap.agents],
  );
  const toolHost = useMemo<ToolRenderHost>(
    () => ({
      hasAgent: (id) => agentIds.has(id),
      openAgent: (id) => {
        if (agentIds.has(id)) setSelectedId(id);
      },
    }),
    [agentIds],
  );

  // Auto-open the rail the first time a subagent appears.
  useEffect(() => {
    if (subCount > 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setRailOpen(true);
    }
  }, [subCount]);

  const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
  useEffect(() => {
    document.title = `${title} · omp collab`;
  }, [title]);

  const drawerAgent =
    selectedId != null
      ? snap.agents.find((a) => a.id === selectedId)
      : undefined;
  const toggleRail = useCallback(() => setRailOpen((open) => !open), []);
  const closeDrawer = useCallback(() => setSelectedId(null), []);

  return (
    <div className="sh-app">
      <div className="sh-ambient" />
      {connectError && snap.phase !== "ended" && <div className="sh-banner" role="alert">{connectError}</div>}
      <HeaderBar
        header={snap.header}
        state={snap.state}
        phase={snap.phase}
        readOnly={snap.readOnly}
        subCount={subCount}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        onLeave={onLeave}
      />
      <main className="sh-main">
        <section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
          <div className="sh-transcript">
            <Transcript
              entries={snap.entries}
              stream={snap.stream}
              streamDone={snap.streamDone}
              activeTools={snap.activeTools}
              working={snap.working}
              host={toolHost}
              phase={snap.phase}
            />
          </div>
          <Composer
            client={client}
            phase={snap.phase}
            readOnly={snap.readOnly}
            uiRequest={snap.uiRequest}
            uiRequestEnd={snap.uiRequestEnd}
            uiResponsePending={snap.uiResponsePending}
            working={snap.working}
            queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
            draft={draft}
            onDraftChange={onDraftChange}
          />
 [packages/guest/src/app.tsx#6BE5]
        </section>
        {railOpen && (
          <>
            <div
              className="sh-rail-backdrop"
              onClick={() => setRailOpen(false)}
            />
            <aside className="sh-rail">
              <AgentsPanel
                agents={snap.agents}
                progress={snap.progress}
                lifecycle={snap.lifecycle}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </aside>
          </>
        )}
      </main>
      {drawerAgent && (
        <>
          <div className="ag-drawer-backdrop" onClick={closeDrawer} />
          <AgentDrawer
            agent={drawerAgent}
            progress={snap.progress.get(drawerAgent.id)}
            lifecycle={snap.lifecycle.get(drawerAgent.id)}
            client={client}
            phase={snap.phase}
            readOnly={snap.readOnly}
            host={toolHost}
            onClose={closeDrawer}
          />
        </>
      )}
      <Banners
        phase={snap.phase}
        endedReason={snap.endedReason}
        loading={snap.loading}
        onRejoin={onRejoin}
        onNewLink={onLeave}
        client={client}
        readOnly={snap.readOnly}
        draft={draft}
        onDraftChange={onDraftChange}
        connectError={connectError}
      />
      <Toasts notices={snap.notices} />
    </div>
  );
}
