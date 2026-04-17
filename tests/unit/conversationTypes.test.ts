/**
 * @license Apache-2.0
 * Tests for the conversation-type capability registry.
 *
 * This registry replaced scattered `conversationType === 'gemini'` /
 * `MCP_CAPABLE_TYPES.has(...)` conditionals in TeammateManager / WakeRunner
 * / TurnFinalizer / TeamSessionService. These tests lock in:
 *   - registered capabilities for every shipped backend
 *   - conservative default for unknown types
 *   - agentType → conversationType mapping (many-to-one for ACP family)
 *   - convenience helpers (supportsMcpInjection / sendShapeFor / costProviderFor)
 */

import { describe, it, expect } from 'vitest';
import {
  capabilityFor,
  supportsMcpInjection,
  sendShapeFor,
  costProviderFor,
  resolveConversationType,
  registeredConversationTypes,
} from '@process/team/conversationTypes';

describe('conversationTypes registry', () => {
  describe('capabilityFor', () => {
    it('returns the registered capability for acp', () => {
      expect(capabilityFor('acp')).toEqual({
        supportsMcpInjection: true,
        sendShape: 'content',
        provider: 'anthropic',
      });
    });

    it('returns the registered capability for gemini (input shape + google provider)', () => {
      expect(capabilityFor('gemini')).toEqual({
        supportsMcpInjection: true,
        sendShape: 'input',
        provider: 'google',
      });
    });

    it('returns the default capability for unknown conversation types', () => {
      expect(capabilityFor('nonexistent-backend')).toEqual({
        supportsMcpInjection: false,
        sendShape: 'content',
        provider: 'anthropic',
      });
    });

    it('never returns undefined even for empty string', () => {
      expect(capabilityFor('')).toBeDefined();
      expect(capabilityFor('').sendShape).toBe('content');
    });
  });

  describe('supportsMcpInjection', () => {
    it('returns true for MCP-capable backends', () => {
      expect(supportsMcpInjection('acp')).toBe(true);
      expect(supportsMcpInjection('gemini')).toBe(true);
    });

    it('returns false for non-MCP backends', () => {
      expect(supportsMcpInjection('aionrs')).toBe(false);
      expect(supportsMcpInjection('openclaw-gateway')).toBe(false);
      expect(supportsMcpInjection('nanobot')).toBe(false);
      expect(supportsMcpInjection('remote')).toBe(false);
    });

    it('returns false for unknown types (conservative default)', () => {
      expect(supportsMcpInjection('mystery-backend')).toBe(false);
    });
  });

  describe('sendShapeFor', () => {
    it('returns "input" for gemini', () => {
      expect(sendShapeFor('gemini')).toBe('input');
    });

    it('returns "content" for every non-gemini backend', () => {
      for (const t of ['acp', 'aionrs', 'openclaw-gateway', 'nanobot', 'remote']) {
        expect(sendShapeFor(t)).toBe('content');
      }
    });

    it('returns "content" for unknown types', () => {
      expect(sendShapeFor('unknown')).toBe('content');
    });
  });

  describe('costProviderFor', () => {
    it('returns "google" for gemini', () => {
      expect(costProviderFor('gemini')).toBe('google');
    });

    it('returns "anthropic" for everything else', () => {
      for (const t of ['acp', 'aionrs', 'openclaw-gateway', 'nanobot', 'remote', 'unknown']) {
        expect(costProviderFor(t)).toBe('anthropic');
      }
    });
  });

  describe('resolveConversationType', () => {
    it('preserves gemini / aionrs / openclaw-gateway / nanobot / remote', () => {
      expect(resolveConversationType('gemini')).toBe('gemini');
      expect(resolveConversationType('aionrs')).toBe('aionrs');
      expect(resolveConversationType('openclaw-gateway')).toBe('openclaw-gateway');
      expect(resolveConversationType('nanobot')).toBe('nanobot');
      expect(resolveConversationType('remote')).toBe('remote');
    });

    it('maps codex / opencode / hermes / claude to "acp" (the ACP family)', () => {
      expect(resolveConversationType('codex')).toBe('acp');
      expect(resolveConversationType('opencode')).toBe('acp');
      expect(resolveConversationType('hermes')).toBe('acp');
      expect(resolveConversationType('claude')).toBe('acp');
    });

    it('defaults unknown types to "acp" (largest common denominator)', () => {
      expect(resolveConversationType('mystery-backend')).toBe('acp');
      expect(resolveConversationType('')).toBe('acp');
    });
  });

  describe('registeredConversationTypes', () => {
    it('returns all registered backends', () => {
      const types = registeredConversationTypes();
      expect(types).toContain('acp');
      expect(types).toContain('gemini');
      expect(types).toContain('aionrs');
      expect(types).toContain('openclaw-gateway');
      expect(types).toContain('nanobot');
      expect(types).toContain('remote');
      // Should have exactly the 6 entries we register today; this asserts
      // that new additions are intentional.
      expect(types).toHaveLength(6);
    });
  });
});
