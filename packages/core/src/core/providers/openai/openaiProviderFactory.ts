/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import axios, { type AxiosInstance } from 'axios';
import type {
  ProviderConfig,
  LLMProvider,
  ProviderCapability,
} from '../types.js';
import { OpenAIChatProvider } from './providers/openAIChatProvider.js';
import { resolveOpenAIEndpoint } from './utils/endpointResolver.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export function createOpenAIProvider(config: ProviderConfig): LLMProvider {
  const { baseURL, headers } = resolveOpenAIEndpoint(config);

  const axiosInstance: AxiosInstance = axios.create({
    baseURL,
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers,
  });

  const capability: ProviderCapability = {
    providerId: 'openai',
    flavor: config.useResponsesApi ? 'responses' : 'chat',
    supportsStreaming: true,
    supportsTools: true,
  };

  return new OpenAIChatProvider({
    axios: axiosInstance,
    config,
    capability,
  });
}
