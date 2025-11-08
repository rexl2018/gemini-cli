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
import type { ContentGenerator } from './contentGenerator.js';
import type { LLMProvider, ProviderConfig } from './providers/types.js';
import { createOpenAIProvider } from './providers/openai/openaiProviderFactory.js';

export interface OpenAIConfig {
  endpoint?: string;
  model: string;
  apiKey?: string;
  endpoint_postfix?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private provider: LLMProvider;
  private providerConfig: ProviderConfig;

  constructor(config: OpenAIConfig) {
    this.providerConfig = {
      providerId: 'openai',
      model: config.model,
      endpoint: config.endpoint,
      endpointPostfix: config.endpoint_postfix,
      apiKey: config.apiKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      useResponsesApi: this.shouldUseResponsesApi(),
    };
    this.provider = createOpenAIProvider(this.providerConfig);
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    this.refreshProviderIfNeeded();
    return this.provider.generate(request, userPromptId);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    this.refreshProviderIfNeeded();
    return this.provider.generateStream(request, userPromptId);
  }

  private refreshProviderIfNeeded(): void {
    const flag = this.shouldUseResponsesApi();
    if (flag === this.providerConfig.useResponsesApi) {
      return;
    }
    this.providerConfig = {
      ...this.providerConfig,
      useResponsesApi: flag,
    };
    this.provider = createOpenAIProvider(this.providerConfig);
  }

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    return this.provider.countTokens(request);
  }

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    return this.provider.embedContent(request);
  }

  private shouldUseResponsesApi(): boolean {
    const v = process.env['LLM_BYOK_RESPONSE_API'];
    return !!v && v !== '0';
  }
}
