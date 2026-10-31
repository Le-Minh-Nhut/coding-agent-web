import { useState, useEffect } from "react";
import { api, setCsrfToken } from "./api.js";
import { LoginView } from "./components/LoginView.js";
import { ProjectsView } from "./components/ProjectsView.js";
import { ProjectDetailView } from "./components/ProjectDetailView.js";
import { ConversationView, type RefusedRecovery } from "./components/ConversationView.js";
import { SettingsView } from "./components/SettingsView.js";
import { resetMutationQueues } from "./mutation-order.js";
import { resetProjectMutationState } from "./components/ProjectsView.js";

type View = "projects" | "project-detail" | "conversation" | "settings";

/**
 * Every place the app transitions to unauthenticated goes through here: the
 * module-scope mutation queues outlive the session that filled them, and an
 * intent chained under one session must not be replayed under the next (nor may
 * a hung chain block the next session's keys). Collected in one function so a
 * new auth-loss path cannot forget one of the two resets.
 */
function clearSessionScopedMutations(): void {
  // Retire the in-memory CSRF token too: a held closure is not the only thing that
  // can mis-send after a sign-out, and the next login's `getMe` overwrites it anyway.
  setCsrfToken(null);
  resetMutationQueues();
  resetProjectMutationState();
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [startupFailure, setStartupFailure] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupUnavailable, setSetupUnavailable] = useState(false);
  const [currentView, setCurrentView] = useState<View>("projects");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({});
  const [refusedRecoveries, setRefusedRecoveries] = useState<Record<string, RefusedRecovery[]>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await api.getMe();
      if (cancelled) return;
      if (me.ok) {
        const probe = await api.getCapabilities();
        if (cancelled) return;
        if (probe.ok) {
          setIsAuthenticated(true);
          return;
        }
        if (probe.httpStatus === 403) {
          const refreshed = await api.getMe();
          if (cancelled) return;
          if (refreshed.ok) setSetupRequired(true);
          else setSetupUnavailable(true);
          clearSessionScopedMutations();
          setIsAuthenticated(false);
          return;
        }
        // The session answered; only the capability probe failed. A 500 or a dead
        // transport is not proof the session is gone, so nothing session-scoped is
        // retired here — the workspace degrades behind a retryable surface instead.
        setStartupFailure(probe.error.message || "The server could not answer the capabilities probe.");
        return;
      }

      if (me.httpStatus === 403) {
        const probe = await api.getCapabilities();
        if (cancelled) return;
        if (probe.httpStatus === 403) {
          const refreshed = await api.getMe();
          if (cancelled) return;
          if (refreshed.ok) setSetupRequired(true);
          else setSetupUnavailable(true);
        }
        clearSessionScopedMutations();
        setIsAuthenticated(false);
        return;
      }

      if (me.httpStatus === 401) {
        clearSessionScopedMutations();
        setIsAuthenticated(false);
        return;
      }

      // No status at all means the probe never landed (transport failure), and any
      // other status is a server fault: both are "we could not ask", not "you are
      // signed out". Retrying re-runs the whole probe.
      setStartupFailure(me.error.message || "The server could not be reached.");
    })();
    return () => { cancelled = true; };
  }, [startupAttempt]);

  if (isAuthenticated === null) {
    if (startupFailure !== null) {
      return (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
          <div className="card" style={{ maxWidth: "360px" }}>
            <div role="alert">{startupFailure}</div>
            <p style={{ color: "var(--text-muted)" }}>Your session was not reported as ended; this is a connectivity or server problem.</p>
            <button type="button" className="primary" onClick={() => { setStartupFailure(null); setStartupAttempt((attempt) => attempt + 1); }}>Retry</button>
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p style={{ color: "var(--text-muted)" }}>Loading workspace…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <LoginView
        setupRequired={setupRequired}
        setupUnavailable={setupUnavailable}
        onSuccess={() => {
          setIsAuthenticated(true);
          setSetupRequired(false);
          setSetupUnavailable(false);
          setCurrentView("projects");
        }}
      />
    );
  }

  return (
    <>
      {currentView === "projects" && (
        <ProjectsView
          onSelectProject={(id) => {
            setSelectedProjectId(id);
            setCurrentView("project-detail");
          }}
          onOpenSettings={() => setCurrentView("settings")}
        />
      )}

      {currentView === "project-detail" && selectedProjectId && (
        <ProjectDetailView
          projectId={selectedProjectId}
          onBack={() => {
            setSelectedProjectId(null);
            setCurrentView("projects");
          }}
          onSelectConversation={(id) => {
            setSelectedConversationId(id);
            setCurrentView("conversation");
          }}
        />
      )}

      {currentView === "conversation" && selectedConversationId && (
        <ConversationView
          conversationId={selectedConversationId}
          draft={conversationDrafts[selectedConversationId] ?? ""}
          onDraftChange={(draft) => {
            setConversationDrafts((prev) => ({ ...prev, [selectedConversationId]: draft }));
          }}
          refusedRecoveries={refusedRecoveries[selectedConversationId] ?? []}
          onRefusedRecoveriesChange={(next) => {
            setRefusedRecoveries((prev) => ({ ...prev, [selectedConversationId]: next }));
          }}
          onBack={() => {
            setSelectedConversationId(null);
            setCurrentView(selectedProjectId ? "project-detail" : "projects");
          }}
        />
      )}

      {currentView === "settings" && (
        <SettingsView
          onBack={() => setCurrentView("projects")}
          onLogout={() => {
            clearSessionScopedMutations();
            setIsAuthenticated(false);
          }}
        />
      )}
    </>
  );
}
