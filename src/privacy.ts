const PRIVATE_PATTERN = /<private>[\s\S]*?<\/private>/gi;

export function containsPrivate(content: string): boolean {
  return new RegExp(PRIVATE_PATTERN.source, "i").test(content);
}

/** Replace every <private>...</private> block with a marker. */
export function stripPrivate(content: string): string {
  return content.replace(PRIVATE_PATTERN, "[REDACTED]");
}

/** True when nothing survives redaction, so the message should not be stored at all. */
export function isFullyPrivate(content: string): boolean {
  const stripped = stripPrivate(content).replace(/\[REDACTED\]/g, "").trim();
  return stripped === "";
}
