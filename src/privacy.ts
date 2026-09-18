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

/**
 * Best-effort automatic redaction. Only a value sitting next to a secret-like
 * name is redacted -- high-entropy strings with no context (commit hashes, ids,
 * example text) are left alone, so false positives stay rare. The key name
 * survives so memory keeps the *fact* that a credential was set.
 */
export function autoRedactSecrets(content: string): string {
  let out = content.replace(URL_USERINFO, "$1[REDACTED]@");
  out = out.replace(SECRET_PAIR, (_m, key, q1, pre, sep, ws, q2, _value) =>
    `${key}${q1}${pre}${sep}${ws}${q2}[REDACTED]`,
  );
  out = out.replace(PREFIXED_SECRET, "[REDACTED]");
  out = out.replace(BEARER_TOKEN, "bearer [REDACTED]");
  out = out.replace(JWT_TOKEN, "[REDACTED]");
  out = out.replace(PRIVATE_KEY_BLOCK, "[REDACTED]");
  return out;
}

/**
 * `token = sk-...`, `"apiKey": "..."`, `PASSWORD: hunter2`, camelCase tolerant.
 * A `"` before the separator covers JSON object keys (`"apiKey": ...`); the
 * closing quote is left in place so the shape survives intact.
 */
const SECRET_PAIR =
  /\b((?:token|secret|password|passwd|pwd|api[_ -]*key|access[_ -]*key|private[_ -]*key|client[_ -]*secret)s?)\b(["'`]?)(\s*)([:=])(\s*)(["'`]?)([^\s"'`\\,;}|>\[\]]{8,})/gi;

/**
 * Unmistakable secret prefixes, redacted even without a key name (`key` alone is
 * deliberately not enough: `foreign key = customer_id` is legit memory).
 */
const PREFIXED_SECRET =
  /\b(?:sk[-_][A-Za-z0-9]{10,}|gh[pous]_[A-Za-z0-9]{20,}|xox[bp]?[-_][A-Za-z0-9]{10,}|xapp[-_][A-Za-z0-9]{10,}|glpat[-_][A-Za-z0-9]{10,}|(?:pk|rk|sk)_live_[A-Za-z0-9]{8,}|AKIA[A-Za-z0-9]{12,})\b/g;

/** `Authorization: Bearer ghp_...` */
const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/gi;

/** Anything that starts like a JWT (base64 of `{"` is always `eyJ...`). */
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/** PEM / OpenSSH / encrypted private key blocks, which can span lines. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gi;

/**
 * Credentials embedded in a URL: `scheme://user:pass@host...`. Only the userinfo
 * (`user:pass@`) is replaced, the scheme and everything after the `@` stays, so
 * ephemeral hosts and ports (which may be no secret at all) survive intact.
 */
const URL_USERINFO =
  /([a-z][a-z0-9+.-]*:\/\/)[^@\s/:]+:[^@\s/:]*@/gi;
