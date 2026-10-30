import { useState, useEffect } from "react";
import { api } from "./api.js";
import { LoginView } from "./components/LoginView.js";
import { ProjectsView } from "./components/ProjectsView.js";
import { ProjectDetailView } from "./components/ProjectDetailView.js";
import { ConversationView, type RefusedRecovery } from "./components/ConversationView.js";
import { SettingsView } from "./components/SettingsView.js";

type View = "projects" | "project-detail" | "conversation" | "settings";

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupUnavailable, setSetupUnavailable] = useState(false);
  const [currentView, setCurrentView] = useState<View>("projects");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({});
  const [refusedRecoveries, setRefusedRecoveries] = useState<Record<string, RefusedRecovery[]>>({});

  useEffect(() => {
    void (async () => {
      const me = await api.getMe();
      if (me.ok) {
        const probe = await api.getCapabilities();
        if (probe.ok) {
          setIsAuthenticated(true);
          return;
        }
        if (probe.httpStatus === 403) {
          const refreshed = await api.getMe();
          if (refreshed.ok) {
            setSetupRequired(true);
            setIsAuthenticated(false);
          } else {
            setSetupUnavailable(true);
            setIsAuthenticated(false);
          }
        } else setIsAuthenticated(false);
        return;
      }

      if (me.httpStatus === 403) {
        const probe = await api.getCapabilities();
        if (probe.httpStatus === 403) {
          const refreshed = await api.getMe();
          if (refreshed.ok) setSetupRequired(true);
          else setSetupUnavailable(true);
        }
      }
      setIsAuthenticated(false);
    })();
  }, []);

  if (isAuthenticated === null) {
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
            setIsAuthenticated(false);
          }}
        />
      )}
    </>
  );
}
