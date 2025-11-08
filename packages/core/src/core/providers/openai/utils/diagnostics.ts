/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Safely stringify objects for logging, truncating long payloads.
 */
export function stringifyForLog(obj: unknown, max: number = 1200): string {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Build a sanitized cURL command for reproducing requests (Authorization redacted).
 */
export function buildCurlCommand(
  url: string,
  headersObj: unknown,
  bodyObj: unknown,
): string {
  const headers: Record<string, string> = {};
  try {
    const h = headersObj as Record<string, unknown>;
    const maybeCommon = (h?.['common'] ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(maybeCommon)) {
      if (typeof v === 'string') headers[k] = v;
    }
    for (const [k, v] of Object.entries(h || {})) {
      if (typeof v === 'string') headers[k] = v;
    }
  } catch {
    // ignore malformed header objects
  }

  if (headers['Authorization']) {
    headers['Authorization'] = 'Bearer <REDACTED>';
  }

  const headerLines = Object.entries(headers)
    .map(([k, v]) => `  -H '${k}: ${v}' \\\n`)
    .join('');

  let body = '';
  try {
    body = JSON.stringify(bodyObj ?? {}, null, 2);
  } catch {
    body = '{}';
  }

  return `curl -X POST '${url}' \\\n${headerLines}  --data-binary @- <<'JSON'\n${body}\nJSON`;
}

/**
 * Convert a Node readable stream to string.
 */
export async function readStreamToString(stream: unknown): Promise<string> {
  try {
    const readable = stream as {
      setEncoding?: (enc: string) => void;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    return await new Promise<string>((resolve, reject) => {
      let buffer = '';
      try {
        readable.setEncoding?.('utf8');
      } catch {
        // ignore
      }
      readable.on('data', (chunk: unknown) => {
        buffer += typeof chunk === 'string' ? chunk : String(chunk);
      });
      readable.on('end', () => resolve(buffer));
      readable.on('error', (err: unknown) => reject(err));
    });
  } catch {
    return '[unserializable]';
  }
}
