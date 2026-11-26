/**
 * Frame parser: raw socket string -> validated, typed ServerEvent.
 *
 * Pure and synchronous. Never throws; every failure is a typed ParseResult so
 * the caller can decide whether to drop the frame, log it, or surface it.
 */
import type {
  ParseResult,
  ServerEvent,
  ServerEventType as ServerEventTypeT,
} from "./types";
import { PROTOCOL_VERSION, ServerEventType } from "./types";
import { isToolStatus } from "./toolStatus";

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  Object.values(ServerEventType),
);

const STREAM_END_REASONS: ReadonlySet<string> = new Set([
  "complete",
  "cancelled",
  "error",
]);

const CHAT_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(field: string): ParseResult {
  return { ok: false, error: { code: "missing_field", detail: field } };
}

function isPosSeq(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isFiniteTs(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFraction(value: unknown): boolean {
  return typeof value === "number" && value >= 0 && value <= 1;
}

/** Per-event required-field validation. Returns the offending field, or null. */
function validatePayload(
  type: ServerEventTypeT,
  o: Record<string, unknown>,
): string | null {
  const str = (k: string): boolean => typeof o[k] === "string";
  const bool = (k: string): boolean => typeof o[k] === "boolean";

  switch (type) {
    case ServerEventType.TOKEN:
      if (!str("messageId")) return "messageId";
      if (!str("role") || !CHAT_ROLES.has(o.role as string)) return "role";
      if (!str("token")) return "token";
      if (!isNonNegInt(o.index)) return "index";
      return null;
    case ServerEventType.TOOL_CALL:
      if (!str("callId")) return "callId";
      if (!str("name")) return "name";
      if (!("args" in o)) return "args";
      return null;
    case ServerEventType.TOOL_RESULT:
      if (!str("callId")) return "callId";
      if (!bool("ok")) return "ok";
      if (!isNonNegInt(o.durationMs)) return "durationMs";
      return null;
    case ServerEventType.TOOL_STATUS:
      if (!str("callId")) return "callId";
      if (!str("name")) return "name";
      if (!("args" in o)) return "args";
      if (!isToolStatus(o.status)) return "status";
      if (o.detail !== undefined && !str("detail")) return "detail";
      if (o.progress !== undefined && !isFraction(o.progress)) return "progress";
      if (o.policyRule !== undefined && !str("policyRule")) return "policyRule";
      return null;
    case ServerEventType.STREAM_END:
      if (!str("messageId")) return "messageId";
      if (typeof o.reason !== "string" || !STREAM_END_REASONS.has(o.reason))
        return "reason";
      return null;
    case ServerEventType.CONTEXT_SNAPSHOT:
      if (!isRecord(o.context)) return "context";
      return null;
    case ServerEventType.PING:
      if (!str("nonce")) return "nonce";
      return null;
    case ServerEventType.ERROR:
      if (!str("code")) return "code";
      if (!str("message")) return "message";
      if (!bool("fatal")) return "fatal";
      return null;
    default: {
      const _never: never = type;
      return _never;
    }
  }
}

export function parseFrame(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: { code: "invalid_json", detail: (err as Error).message },
    };
  }

  if (!isRecord(json)) {
    return { ok: false, error: { code: "not_an_object", detail: typeof json } };
  }

  if (json.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: { code: "bad_version", detail: String(json.v) },
    };
  }

  if (!isPosSeq(json.seq)) {
    return missing("seq");
  }

  if (!isFiniteTs(json.ts)) {
    return missing("ts");
  }

  if (typeof json.type !== "string" || !KNOWN_TYPES.has(json.type)) {
    return {
      ok: false,
      error: { code: "unknown_type", detail: String(json.type) },
    };
  }

  const badField = validatePayload(json.type as ServerEventTypeT, json);
  if (badField) return missing(badField);

  // Envelope + payload validated; the discriminated union narrows on `type`.
  return { ok: true, event: json as unknown as ServerEvent };
}
