/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';

export type ProviderId = 'openai' | 'ollama' | 'openrouter' | 'ark' | 'custom';

export type ApiFlavor = 'chat' | 'responses';

export interface ProviderCapability {
  providerId: ProviderId;
  flavor: ApiFlavor;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

export interface ProviderConfig {
  providerId: ProviderId;
  model: string;
  endpoint?: string;
  endpointPostfix?: string;
  apiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  useResponsesApi?: boolean;
}

export interface LLMProvider {
  capability: ProviderCapability;

  generate(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse>;

  generateStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;
}
