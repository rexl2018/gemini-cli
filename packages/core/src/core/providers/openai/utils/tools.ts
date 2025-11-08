/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

export type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name?: string; arguments: string };
};

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAIToolMessage = {
  role: 'tool';
  tool_call_id: string;
  content: string;
};

export function convertToolsToOpenAIFormat(tools: unknown):
  | Array<{
      type: 'function';
      function: { name?: string; description?: string; parameters: unknown };
    }>
  | undefined {
  if (!tools || !Array.isArray(tools)) return undefined;
  const openAITools: Array<{
    type: 'function';
    function: { name?: string; description?: string; parameters: unknown };
  }> = [];
  for (const group of tools) {
    const fns = group?.functionDeclarations;
    if (Array.isArray(fns)) {
      for (const fn of fns) {
        openAITools.push({
          type: 'function',
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parametersJsonSchema || {},
          },
        });
      }
    }
  }
  return openAITools.length > 0 ? openAITools : undefined;
}

export function convertToolsToResponsesFormat(tools: unknown):
  | Array<{
      type: 'function';
      name?: string;
      description?: string;
      parameters?: unknown;
    }>
  | undefined {
  if (!tools || !Array.isArray(tools)) return undefined;
  const respTools: Array<{
    type: 'function';
    name?: string;
    description?: string;
    parameters?: unknown;
  }> = [];
  for (const group of tools) {
    const fns = group?.functionDeclarations;
    if (Array.isArray(fns)) {
      for (const fn of fns) {
        respTools.push({
          type: 'function',
          name: fn.name,
          description: fn.description,
          parameters: fn.parametersJsonSchema || { type: 'object' },
        });
      }
    }
  }
  return respTools.length > 0 ? respTools : undefined;
}

export function getToolCounts(
  messages: Array<OpenAIMessage | OpenAIToolMessage>,
): {
  calls: number;
  results: number;
  missingResults: number;
  orphanResults: number;
  missingIds: string[];
  orphanIds: string[];
} {
  let calls = 0;
  let results = 0;
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages || []) {
    const role = (m as { role?: string }).role;
    if (
      role === 'assistant' &&
      Array.isArray((m as OpenAIMessage).tool_calls)
    ) {
      for (const tc of (m as OpenAIMessage).tool_calls!) {
        calls++;
        const id = (tc as OpenAIToolCall)?.id;
        if (typeof id === 'string' && id) callIds.add(id);
      }
    } else if (role === 'tool') {
      results++;
      const tid = (m as OpenAIToolMessage).tool_call_id;
      if (typeof tid === 'string' && tid) resultIds.add(tid);
    }
  }
  const missingIds: string[] = [];
  for (const id of callIds) {
    if (!resultIds.has(id)) missingIds.push(id);
  }
  const orphanIds: string[] = [];
  for (const id of resultIds) {
    if (!callIds.has(id)) orphanIds.push(id);
  }
  return {
    calls,
    results,
    missingResults: missingIds.length,
    orphanResults: orphanIds.length,
    missingIds,
    orphanIds,
  };
}

export function createTextParts(parts: Part[]): string {
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('');
}
