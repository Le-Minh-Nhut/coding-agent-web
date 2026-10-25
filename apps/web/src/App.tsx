import { useState, useEffect } from "react";
import { api } from "./api.js";
import { LoginView } from "./components/LoginView.js";
import { ProjectsView } from "./components/ProjectsView.js";
import { ProjectDetailView } from "./components/ProjectDetailView.js";
import { ConversationView } from "./components/ConversationView.js";
import { SettingsView } from "./components/SettingsView.js";

type View = "projects" | "project-detail" | "conversation" | "settings";

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [currentView, setCurrentView] = useState<View>("projects");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    api.getMe().then((res) => {
      setIsAuthenticated(res.ok);
    });
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
        onSuccess={() => {
          setIsAuthenticated(true);
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
