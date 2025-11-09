/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import { AuthType, debugLogger, OutputFormat } from '@google/gemini-cli-core';
import { USER_SETTINGS_PATH } from './config/settings.js';
import { validateAuthMethod } from './config/auth.js';
import { type LoadedSettings } from './config/settings.js';
import { handleError } from './utils/errors.js';

function detectByokFromSettings(settings: LoadedSettings): boolean {
  const providerConfig = settings.merged.model?.providerConfig;
  if (providerConfig?.llm_provider === 'llm_byok_openai') {
    return true;
  }
  const investigatorProvider =
    settings.merged.experimental?.codebaseInvestigatorSettings?.providerConfig;
  return investigatorProvider?.llm_provider === 'llm_byok_openai';
}

function getAuthType(
  configuredAuthType: AuthType | undefined,
  settings: LoadedSettings,
): { authType: AuthType | undefined; usedEnvFallback: boolean } {
  if (configuredAuthType) {
    return { authType: configuredAuthType, usedEnvFallback: false };
  }

  if (detectByokFromSettings(settings)) {
    return { authType: AuthType.USE_LLM_BYOK, usedEnvFallback: false };
  }

  if (process.env['LLM_BYOK_API_KEY'] || process.env['LLM_BYOK_ENDPOINT']) {
    return { authType: AuthType.USE_LLM_BYOK, usedEnvFallback: true };
  }

  if (process.env['GOOGLE_GENAI_USE_GCA'] === 'true') {
    return { authType: AuthType.LOGIN_WITH_GOOGLE, usedEnvFallback: true };
  }
  if (process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
    return { authType: AuthType.USE_VERTEX_AI, usedEnvFallback: true };
  }
  if (process.env['GEMINI_API_KEY']) {
    return { authType: AuthType.USE_GEMINI, usedEnvFallback: true };
  }
  return { authType: undefined, usedEnvFallback: false };
}

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
  settings: LoadedSettings,
) {
  try {
    const { authType: effectiveAuthType, usedEnvFallback } = getAuthType(
      configuredAuthType,
      settings,
    );

    if (usedEnvFallback) {
      debugLogger.warn(
        'Detected deprecated BYOK environment variables. Please migrate to model.providerConfig settings.json entries.',
      );
    }

    const enforcedType = settings.merged.security?.auth?.enforcedType;
    if (enforcedType && effectiveAuthType !== enforcedType) {
      const message = effectiveAuthType
        ? `The enforced authentication type is '${enforcedType}', but the current type is '${effectiveAuthType}'. Please re-authenticate with the correct type.`
        : `The auth type '${enforcedType}' is enforced, but no authentication is configured.`;
      throw new Error(message);
    }

    if (!effectiveAuthType) {
      const message = `Please set an Auth method in your ${USER_SETTINGS_PATH} (e.g. security.auth.selectedType or model.providerConfig.llm_provider) or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA, LLM_BYOK_API_KEY/OPENAI_API_KEY (with LLM_BYOK_ENDPOINT)`;
      throw new Error(message);
    }

    const authType: AuthType = effectiveAuthType as AuthType;

    if (!useExternalAuth) {
      const err = validateAuthMethod(String(authType));
      if (err != null) {
        throw new Error(err);
      }
    }

    await nonInteractiveConfig.refreshAuth(authType);
    return nonInteractiveConfig;
  } catch (error) {
    if (nonInteractiveConfig.getOutputFormat() === OutputFormat.JSON) {
      handleError(
        error instanceof Error ? error : new Error(String(error)),
        nonInteractiveConfig,
        1,
      );
    } else {
      debugLogger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}
