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
import { debugLogger } from '../utils/debugLogger.js';
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
    debugLogger.log(
      `[BYOK] OpenAI provider created with endpoint=${config.endpoint}, postfix=${config.endpoint_postfix}, model=${config.model}`,
    );
    this.provider = createOpenAIProvider(this.providerConfig);
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    this.refreshProviderIfNeeded();
    debugLogger.log(
      `[BYOK] generateContent model=${request.model} promptId=${userPromptId} payloadParts=${Array.isArray(request.contents) ? request.contents.length : 1}`,
    );
    try {
      const response = await this.provider.generate(request, userPromptId);
      debugLogger.log(
        `[BYOK] generateContent success model=${request.model} responseCandidates=${response.candidates?.length ?? 0}`,
      );
      return response;
    } catch (error) {
      debugLogger.error(
        `[BYOK] generateContent failed model=${request.model} promptId=${userPromptId}: ${(error as Error)?.message ?? error}`,
      );
      throw error;
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    this.refreshProviderIfNeeded();
    debugLogger.log(
      `[BYOK] generateContentStream model=${request.model} promptId=${userPromptId} payloadParts=${Array.isArray(request.contents) ? request.contents.length : 1}`,
    );
    try {
      const stream = await this.provider.generateStream(request, userPromptId);
      return this.wrapStream(stream, request.model, userPromptId);
    } catch (error) {
      debugLogger.error(
        `[BYOK] generateContentStream failed model=${request.model} promptId=${userPromptId}: ${(error as Error)?.message ?? error}`,
      );
      throw error;
    }
  }

  private async *wrapStream(
    stream: AsyncGenerator<GenerateContentResponse>,
    model: string,
    promptId: string,
  ): AsyncGenerator<GenerateContentResponse> {
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
      debugLogger.log(
        `[BYOK] generateContentStream completed model=${model} promptId=${promptId}`,
      );
    } catch (error) {
      debugLogger.error(
        `[BYOK] generateContentStream error model=${model} promptId=${promptId}: ${(error as Error)?.message ?? error}`,
      );
      throw error;
    }
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
