/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
} from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import type { Config } from '../config/config.js';
import { loadApiKey } from './apiKeyCredentialStorage.js';

import type { UserTierId } from '../code_assist/types.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { InstallationManager } from '../utils/installationManager.js';
import { debugLogger } from '../utils/debugLogger.js';
import { FakeContentGenerator } from './fakeContentGenerator.js';
import { RecordingContentGenerator } from './recordingContentGenerator.js';

import { OpenAICompatibleContentGenerator } from './openAICompatibleContentGenerator.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  userTier?: UserTierId;
}

export enum AuthType {
  LOGIN_WITH_GOOGLE = 'oauth-personal',
  USE_GEMINI = 'gemini-api-key',
  USE_VERTEX_AI = 'vertex-ai',
  CLOUD_SHELL = 'cloud-shell',
  USE_LLM_BYOK = 'llm_byok',
}

export type ContentGeneratorConfig = {
  apiKey?: string;
  vertexai?: boolean;
  authType?: AuthType;
  proxy?: string;
};

export async function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
): Promise<ContentGeneratorConfig> {
  const geminiApiKey =
    (await loadApiKey()) || process.env['GEMINI_API_KEY'] || undefined;
  const googleApiKey = process.env['GOOGLE_API_KEY'] || undefined;
  const googleCloudProject =
    process.env['GOOGLE_CLOUD_PROJECT'] ||
    process.env['GOOGLE_CLOUD_PROJECT_ID'] ||
    undefined;
  const googleCloudLocation = process.env['GOOGLE_CLOUD_LOCATION'] || undefined;

  const contentGeneratorConfig: ContentGeneratorConfig = {
    authType,
    proxy: config?.getProxy(),
  };

  // if we are using LLM with your own key, no auth needed
  if (authType === AuthType.USE_LLM_BYOK) {
    return contentGeneratorConfig;
  }

  // If we are using Google auth or we are in Cloud Shell, there is nothing else to validate for now
  if (
    authType === AuthType.LOGIN_WITH_GOOGLE ||
    authType === AuthType.CLOUD_SHELL
  ) {
    return contentGeneratorConfig;
  }

  if (authType === AuthType.USE_GEMINI && geminiApiKey) {
    contentGeneratorConfig.apiKey = geminiApiKey;
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  if (
    authType === AuthType.USE_VERTEX_AI &&
    (googleApiKey || (googleCloudProject && googleCloudLocation))
  ) {
    contentGeneratorConfig.apiKey = googleApiKey;
    contentGeneratorConfig.vertexai = true;

    return contentGeneratorConfig;
  }

  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  const generator = await (async () => {
    if (gcConfig.fakeResponses) {
      return FakeContentGenerator.fromFile(gcConfig.fakeResponses);
    }
    if (config.authType === AuthType.USE_LLM_BYOK) {
      const providerConfig = gcConfig.getProviderConfig();
      const endpoint = providerConfig?.llm_endpoint;
      const resolvedEndpoint = endpoint || process.env['LLM_BYOK_ENDPOINT'];
      if (!endpoint && process.env['LLM_BYOK_ENDPOINT']) {
        debugLogger.warn(
          'Using LLM_BYOK_ENDPOINT environment variable. Please move this value to model.providerConfig.llm_endpoint in settings.json.',
        );
      }
      const model = providerConfig?.model;
      const resolvedModel = model || process.env['LLM_BYOK_MODEL'];
      if (!model && process.env['LLM_BYOK_MODEL']) {
        debugLogger.warn(
          'Using LLM_BYOK_MODEL environment variable. Provide model.providerConfig.model in settings.json.',
        );
      }
      const endpointPostfix = providerConfig?.llm_endpoint_postfix;
      const resolvedEndpointPostfix =
        endpointPostfix || process.env['LLM_BYOK_ENDPOINT_POSTFIX'];
      if (!endpointPostfix && process.env['LLM_BYOK_ENDPOINT_POSTFIX']) {
        debugLogger.warn(
          'Using LLM_BYOK_ENDPOINT_POSTFIX environment variable. Provide model.providerConfig.llm_endpoint_postfix in settings.json.',
        );
      }

      const protocol = providerConfig?.llm_protocol || 'responses_api';
      let apiKey = providerConfig?.llm_apikey;
      if (!apiKey) {
        if (process.env['LLM_BYOK_API_KEY']) {
          debugLogger.warn(
            'Using LLM_BYOK_API_KEY environment variable. Please move this value to model.providerConfig.llm_apikey in settings.json.',
          );
          apiKey = process.env['LLM_BYOK_API_KEY'];
        } else if (process.env['OPENAI_API_KEY']) {
          debugLogger.warn(
            'Using OPENAI_API_KEY environment variable as a fallback. Provide model.providerConfig.llm_apikey in settings.json to avoid this warning.',
          );
          apiKey = process.env['OPENAI_API_KEY'];
        }
      }
      const effectiveEndpoint = resolvedEndpoint || 'http://localhost:11434/v1';
      const effectiveModel = resolvedModel || 'gemma3:latest';
      const effectivePostfix = resolvedEndpointPostfix || '/chat/completions';
      debugLogger.log(
        `[BYOK] Initializing OpenAI compatible generator with endpoint=${effectiveEndpoint}, model=${effectiveModel}, postfix=${effectivePostfix}, protocol=${protocol}`,
      );
      return new LoggingContentGenerator(
        new OpenAICompatibleContentGenerator({
          endpoint: effectiveEndpoint,
          model: effectiveModel,
          apiKey,
          endpoint_postfix: effectivePostfix,
          protocol,
        }),
        gcConfig,
      );
    }
    const version = process.env['CLI_VERSION'] || process.version;
    const userAgent = `GeminiCLI/${version} (${process.platform}; ${process.arch})`;
    const baseHeaders: Record<string, string> = {
      'User-Agent': userAgent,
    };
    if (
      config.authType === AuthType.LOGIN_WITH_GOOGLE ||
      config.authType === AuthType.CLOUD_SHELL
    ) {
      const httpOptions = { headers: baseHeaders };
      return new LoggingContentGenerator(
        await createCodeAssistContentGenerator(
          httpOptions,
          config.authType,
          gcConfig,
          sessionId,
        ),
        gcConfig,
      );
    }

    if (
      config.authType === AuthType.USE_GEMINI ||
      config.authType === AuthType.USE_VERTEX_AI
    ) {
      let headers: Record<string, string> = { ...baseHeaders };
      if (gcConfig?.getUsageStatisticsEnabled()) {
        const installationManager = new InstallationManager();
        const installationId = installationManager.getInstallationId();
        headers = {
          ...headers,
          'x-gemini-api-privileged-user-id': `${installationId}`,
        };
      }
      const httpOptions = { headers };

      const googleGenAI = new GoogleGenAI({
        apiKey: config.apiKey === '' ? undefined : config.apiKey,
        vertexai: config.vertexai,
        httpOptions,
      });
      return new LoggingContentGenerator(googleGenAI.models, gcConfig);
    }
    throw new Error(
      `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
    );
  })();

  if (gcConfig.recordResponses) {
    return new RecordingContentGenerator(generator, gcConfig.recordResponses);
  }

  return generator;
}
