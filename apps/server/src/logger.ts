const redactPaths = ["req.headers.cookie", "req.headers.set-cookie", "req.headers.authorization", "req.url", "url", "*.url", "*.cookie", "*.set-cookie", "*.authorization"];

export function createLogger(level: string = "info") {
  return {
    level,
    redact: { paths: redactPaths, censor: "[REDACTED]" },
    serializers: {
      req(request: { method?: string; routeOptions?: { url?: string } }) {
        return { method: request.method, route: request.routeOptions?.url ?? "unknown" };
      },
    },
  };
}

export function redactLogValue(value: unknown): unknown {
  if (value instanceof Error) return redactLogValue(value.message);
  if (typeof value === "string") return value.replace(/(cookie|authorization|set-cookie)\s*[:=]\s*[^\r\n,;]+/giu, "$1=[REDACTED]").replace(/(https?:\/\/[^\s#]+)#[^\s]*/giu, "$1#[REDACTED]").replace(/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{24,}/gu, "[COLLAB_LINK]");
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /cookie|authorization|url/iu.test(key) ? "[REDACTED]" : redactLogValue(item)]));
  return value;
}

export function redactEventPayload<T = unknown>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const redacted = value
      .replace(/\b(bearer)\s+[^\s,;]+/giu, "$1 [REDACTED]")
      .replace(/((?:https?|wss?):\/\/[^\s#"']+)?#[^\s#"']+/giu, (match, prefix) =>
        prefix ? `${prefix}#[REDACTED]` : "#[REDACTED]"
      )
      .replace(/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{24,}/gu, "[REDACTED]");
    return redacted as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEventPayload(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (/token|secret|bearer|authorization|cookie/iu.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactEventPayload(val);
      }
    }
    return result as unknown as T;
  }
  return value;
}
