import type { ErrorCode } from "@caw/contracts";

export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail;
  }
}

export class RegistryUnreadableError extends AdapterError {
  constructor(message = "Collab registry is unreadable", detail?: Record<string, unknown>) {
    super("internal", message, detail);
    this.name = "RegistryUnreadableError";
  }
}

export class StaleGenerationError extends AdapterError {
  constructor(message = "Collab host generation is stale", detail?: Record<string, unknown>) {
    super("stale_generation", message, detail);
    this.name = "StaleGenerationError";
  }
}

export class ToolMissingError extends AdapterError {
  constructor(tool: string, message = `Required tool is missing: ${tool}`) {
    super("capability_missing", message, { tool });
    this.name = "ToolMissingError";
  }
}
