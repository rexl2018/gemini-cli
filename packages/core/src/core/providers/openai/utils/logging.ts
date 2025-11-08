/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { debugLogger } from '../../../../utils/debugLogger.js';
import { stringifyForLog } from './diagnostics.js';

export function logConversation(contents: Content[]): void {
  const truncate = (s: string, max = 120) =>
    s.length > max ? `${s.slice(0, max)}...` : s;
  debugLogger.log(`[OpenAIComp] Conversation (${contents.length} messages)`);
  contents.forEach((content, i) => {
    const role =
      content.role === 'model' ? 'assistant' : content.role || 'user';
    debugLogger.log(`[OpenAIComp]   [${i}] Role: ${role}`);
    (content.parts || []).forEach((p: unknown, idx: number) => {
      const textVal = (p as { text?: unknown }).text;
      if (typeof textVal === 'string') {
        debugLogger.log(`[OpenAIComp]     Part[${idx}] ${truncate(textVal)}`);
      }
    });
  });
}

export function logToolCounts(
  counts: {
    calls: number;
    results: number;
    missingResults: number;
    orphanResults: number;
    missingIds: string[];
    orphanIds: string[];
  },
  mode: 'stream' | 'standard' = 'standard',
): void {
  debugLogger.log(
    `[OpenAICompSend]${mode === 'stream' ? ' (stream)' : ''} tool_calls=${counts.calls}, tool_results=${counts.results}, missing_results=${counts.missingResults}, orphan_results=${counts.orphanResults}, missing_ids=${JSON.stringify(counts.missingIds)}, orphan_ids=${JSON.stringify(counts.orphanIds)}`,
  );
}

export function logRequestDebug(message: string, payload: unknown): void {
  debugLogger.log(message);
  debugLogger.log(`[OpenAI Debug] Request Body: ${stringifyForLog(payload)}`);
}

export function logHeaders(headers: unknown): void {
  debugLogger.log(
    `[OpenAI Debug] Request Headers: ${stringifyForLog(headers)}`,
  );
}

export function logCurl(curl: string): void {
  debugLogger.log(`[OpenAI Debug] cURL: ${curl}`);
}
