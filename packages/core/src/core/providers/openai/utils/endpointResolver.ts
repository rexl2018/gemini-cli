/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProviderConfig } from '../../types.js';

export interface ResolvedEndpoint {
  baseURL: string;
  headers: Record<string, string>;
}

export function resolveOpenAIEndpoint(
  config: ProviderConfig,
): ResolvedEndpoint {
  let baseURL = config.endpoint || '';
  if (config.endpointPostfix) {
    const endpoint = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const postfix = config.endpointPostfix.startsWith('/')
      ? config.endpointPostfix
      : `/${config.endpointPostfix}`;
    baseURL = `${endpoint}${postfix}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.headers ?? {}),
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return { baseURL, headers };
}
