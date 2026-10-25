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

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string>),
  };

  const isMutation = method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT";
  if (isMutation) {
    if (inMemoryCsrfToken) {
      headers["x-caw-csrf"] = inMemoryCsrfToken;
    }
    // Declare JSON only when there is actually a body: endpoints like link minting
    // take none, and claiming a type while sending zero bytes is a malformed
    // request by definition.
    const hasBody = typeof options.body === "string" && options.body.length > 0;
    if (hasBody && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  try {
    const res = await fetch(endpoint, {
      ...options,
      headers,
      credentials: "include",
    });

    const data = (await res.json()) as ApiResult<T>;
    return data;
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
  async getMe(): Promise<ApiResult<{ csrfToken: string }>> {
    const res = await request<{ csrfToken: string }>("/api/auth/me");
    if (res.ok) {
      setCsrfToken(res.data.csrfToken);
    }
    return res;
  },

  async login(password: string): Promise<ApiResult<{ csrfToken: string; expiresAt: string }>> {
    const res = await request<{ csrfToken: string; expiresAt: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setCsrfToken(res.data.csrfToken);
    }
    return res;
  },

  async logout(): Promise<ApiResult<{ loggedOut: boolean }>> {
    const res = await request<{ loggedOut: boolean }>("/api/auth/logout", {
      method: "POST",
    });
    setCsrfToken(null);
    return res;
  },

  async getCapabilities(): Promise<ApiResult<Capabilities>> {
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

  async browse(path?: string): Promise<ApiResult<DirectoryListing>> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return request<DirectoryListing>(`/api/browse${q}`);
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

  async getConversationLink(id: string): Promise<ApiResult<CollabLinkResponse>> {
    return request<CollabLinkResponse>(`/api/conversations/${encodeURIComponent(id)}/link`, {
      method: "POST",
    });
  },

  async listNativeSessions(projectId: string): Promise<ApiResult<NativeSessionSummary[]>> {
    return request<NativeSessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  },
};
