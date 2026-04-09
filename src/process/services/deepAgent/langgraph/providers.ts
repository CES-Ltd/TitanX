/**
 * LLM provider factory — maps TProviderWithModel config to LangChain BaseChatModel.
 * Supports Anthropic, OpenAI, and Google Gemini providers.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { TProviderWithModel } from '@/common/config/storage';

/**
 * Create a LangChain chat model from the application's provider configuration.
 * Uses dynamic imports to avoid loading all provider SDKs at startup.
 */
export async function createChatModel(provider: TProviderWithModel): Promise<BaseChatModel> {
  const platform = provider.platform.toLowerCase();
  const model = provider.useModel === 'auto' ? undefined : provider.useModel;

  // Anthropic / Claude
  if (platform === 'anthropic' || platform === 'claude') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      anthropicApiKey: provider.apiKey || undefined,
      modelName: model || 'claude-sonnet-4-20250514',
      ...(provider.baseUrl ? { anthropicApiUrl: provider.baseUrl } : {}),
      streaming: true,
    });
  }

  // OpenAI
  if (platform === 'openai') {
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      openAIApiKey: provider.apiKey || undefined,
      modelName: model || 'gpt-4o',
      ...(provider.baseUrl ? { configuration: { baseURL: provider.baseUrl } } : {}),
      streaming: true,
    });
  }

  // Google Gemini
  if (platform === 'gemini' || platform === 'gemini-with-google-auth') {
    const { ChatOpenAI } = await import('@langchain/openai');
    // Use OpenAI-compatible endpoint for Gemini (Google AI Studio)
    return new ChatOpenAI({
      openAIApiKey: provider.apiKey || undefined,
      modelName: model || 'gemini-2.0-flash',
      configuration: {
        baseURL: provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
      },
      streaming: true,
    });
  }

  // new-api / OpenAI-compatible (OneAPI, OpenRouter, etc.)
  if (platform === 'new-api' || platform === 'openrouter') {
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      openAIApiKey: provider.apiKey || undefined,
      modelName: model || 'gpt-4o',
      configuration: {
        baseURL: provider.baseUrl || 'https://openrouter.ai/api/v1',
      },
      streaming: true,
    });
  }

  // Fallback: Anthropic
  const { ChatAnthropic } = await import('@langchain/anthropic');
  return new ChatAnthropic({
    anthropicApiKey: provider.apiKey || undefined,
    modelName: model || 'claude-sonnet-4-20250514',
    ...(provider.baseUrl ? { anthropicApiUrl: provider.baseUrl } : {}),
    streaming: true,
  });
}
