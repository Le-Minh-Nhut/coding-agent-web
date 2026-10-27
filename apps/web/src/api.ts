/**
 * API client for Coding Agent Web.
 * Keeps CSRF token in-memory only.
 * Always sends credentials: "include" and "x-caw-csrf" on mutations.
 */

import type {
  ApiResult,
  AttachInstructions,
  Capabilities,
  Conversation,
  ConversationEventsResponse,
  DirectoryListing,
  NativeSessionSummary,
  ProjectWithStats,
  RuntimeSnapshot,
} from "@caw/contracts";

export interface ModelCatalog {
  models: string[];
  source: "omp" | "unavailable";
  reason: string | null;
}

export interface SavedConversationHistory {
  header: { sessionId: string; cwd: string; timestamp: string | null; version: number | null; title: string | null };
  entries: Array<Record<string, unknown>>;
  truncated: boolean;
  truncatedByBytes: boolean;
  truncatedByEntries: boolean;
  skippedOversized: boolean;
  hasOlder: boolean;
  nextCursor: string | null;
}

export interface CollabLinkResponse {
  url: string;
  access: "view" | "full";
  instanceId: string;
  generation: number;
}

let inMemoryCsrfToken: string | null = null;

export function getCsrfToken(): string | null {
  return inMemoryCsrfToken;
}

export function setCsrfToken(token: string | null): void {
  inMemoryCsrfToken = token;
}

type ApiResultWithStatus<T> = ApiResult<T> & { httpStatus?: number };

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResultWithStatus<T>> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string>),
  };

  const isMutation = method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT";
  if (isMutation) {
    if (inMemoryCsrfToken) headers["x-caw-csrf"] = inMemoryCsrfToken;
    const hasBody = typeof options.body === "string" && options.body.length > 0;
    if (hasBody && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
  }

  try {
    const res = await fetch(endpoint, { ...options, headers, credentials: "include" });
    const data = (await res.json()) as ApiResult<T>;
    return { ...data, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "internal",
        message: err instanceof Error ? err.message : "Network request failed",
      },
    };
  }
}

export const api = {
  async getMe(): Promise<ApiResultWithStatus<{ csrfToken: string }>> {
    const res = await request<{ csrfToken: string }>("/api/auth/me");
    if (res.ok) setCsrfToken(res.data.csrfToken);
    return res;
  },

  async login(password: string): Promise<ApiResultWithStatus<{ status: "authenticated" | "password_setup_required"; csrfToken: string; expiresAt: string }>> {
    const res = await request<{ status: "authenticated" | "password_setup_required"; csrfToken: string; expiresAt: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    if (res.ok) setCsrfToken(res.data.csrfToken);
    return res;
  },

  async setPassword(password: string): Promise<ApiResultWithStatus<{ status: "authenticated"; csrfToken: string; expiresAt: string }>> {
    const res = await request<{ status: "authenticated"; csrfToken: string; expiresAt: string }>("/api/auth/set-password", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    if (res.ok) setCsrfToken(res.data.csrfToken);
    return res;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<ApiResultWithStatus<{ changed: boolean }>> {
    return request<{ changed: boolean }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  async logout(): Promise<ApiResult<{ loggedOut: boolean }>> {
    const res = await request<{ loggedOut: boolean }>("/api/auth/logout", {
      method: "POST",
    });
    setCsrfToken(null);
    return res;
  },

  async getCapabilities(): Promise<ApiResultWithStatus<Capabilities>> {
    return request<Capabilities>("/api/capabilities");
  },
  async getRuntime(): Promise<ApiResult<RuntimeSnapshot>> {
    return request<RuntimeSnapshot>("/api/runtime");
  },

  async listProjects(): Promise<ApiResult<ProjectWithStats[]>> {
    return request<ProjectWithStats[]>("/api/projects");
  },

  async createProject(path: string, label: string): Promise<ApiResult<ProjectWithStats>> {
    return request<ProjectWithStats>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path, label }),
    });
  },

  async createDirectory(path: string, name: string): Promise<ApiResult<{ path: string }>> {
    return request<{ path: string }>("/api/directories", {
      method: "POST",
      body: JSON.stringify({ path, name }),
    });
  },

  async updateProject(id: string, updates: { label?: string; favorite?: boolean }): Promise<ApiResult<ProjectWithStats>> {
    return request<ProjectWithStats>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  },

  async deleteProject(id: string): Promise<ApiResult<{ deleted: boolean; filesRemoved: boolean }>> {
    return request<{ deleted: boolean; filesRemoved: boolean }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async browse(path?: string, options?: { limit?: number; cursor?: string }): Promise<ApiResult<DirectoryListing>> {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return request<DirectoryListing>(`/api/browse${query ? `?${query}` : ""}`);
  },

  async listConversations(projectId: string): Promise<ApiResult<Conversation[]>> {
    return request<Conversation[]>(`/api/projects/${encodeURIComponent(projectId)}/conversations`);
  },

  async createConversation(projectId: string, title?: string, resumeSessionId?: string): Promise<ApiResult<Conversation>> {
    return request<Conversation>(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
      method: "POST",
      body: JSON.stringify({ title: title ?? "New conversation", ...(resumeSessionId ? { resumeSessionId } : {}) }),
    });
  },

  async setConversationModel(id: string, model: string): Promise<ApiResult<Conversation>> {
    return request<Conversation>(`/api/conversations/${encodeURIComponent(id)}/model`, {
      method: "PATCH",
      body: JSON.stringify({ model }),
    });
  },

  async restartConversation(id: string): Promise<ApiResult<Conversation>> {
    return request<Conversation>(`/api/conversations/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "restart" }),
    });
  },

  async getConversation(id: string): Promise<ApiResult<Conversation>> {
    return request<Conversation>(`/api/conversations/${encodeURIComponent(id)}`);
  },
  async getConversationHistory(id: string, before?: string): Promise<ApiResult<SavedConversationHistory>> {
    const cursor = before ? `?${new URLSearchParams({ before }).toString()}` : "";
    return request<SavedConversationHistory>(`/api/conversations/${encodeURIComponent(id)}/history${cursor}`);
  },

  async getConversationEvents(id: string, options?: { after?: number; limit?: number }): Promise<ApiResult<ConversationEventsResponse>> {
    const params = new URLSearchParams();
    if (options?.after !== undefined) params.set("after", String(options.after));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<ConversationEventsResponse>(`/api/conversations/${encodeURIComponent(id)}/events${qs}`);
  },

  async getAttachInstructions(id: string): Promise<ApiResult<AttachInstructions>> {
    return request<AttachInstructions>(`/api/conversations/${encodeURIComponent(id)}/attach`);
  },

  async getModels(): Promise<ApiResult<ModelCatalog>> {
    return request<ModelCatalog>("/api/models");
  },
  async getConversationLink(id: string, access: "control" | "view" = "control"): Promise<ApiResult<CollabLinkResponse>> {
    return request<CollabLinkResponse>(`/api/conversations/${encodeURIComponent(id)}/link?access=${access}`, {
      method: "POST",
    });
  },

  async listNativeSessions(projectId: string): Promise<ApiResult<NativeSessionSummary[]>> {
    return request<NativeSessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  },
  async attachLiveSession(projectId: string, sessionId: string): Promise<ApiResult<Conversation>> {
    return request<Conversation>(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attach-live`, { method: "POST" });
  },
};
