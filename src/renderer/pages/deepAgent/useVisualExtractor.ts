/**
 * Listens to the IPC response stream for a Deep Agent conversation,
 * accumulates text content per turn, and extracts VisualItem[] on turn
 * completion to populate the insights panel.
 */

import { useEffect, useRef } from 'react';
import { ipcBridge } from '@/common';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import { parseVisuals } from '@renderer/components/visuals/visualParser';
import type { VisualItem } from './types';

function contentHash(item: VisualItem): string {
  return `${item.type}:${JSON.stringify(item.config)}`;
}

export function useVisualExtractor(conversationId: string | undefined, addVisual: (v: VisualItem) => void): void {
  const seenRef = useRef(new Set<string>());
  const bufferRef = useRef('');

  useEffect(() => {
    if (!conversationId) return;

    const handler = (message: IResponseMessage) => {
      if (message.conversation_id !== conversationId) return;

      if (message.type === 'content') {
        const data = message.data;
        const text =
          typeof data === 'string'
            ? data
            : typeof data === 'object' && data !== null && 'content' in data
              ? (data as { content: string }).content
              : '';
        bufferRef.current += text;
      }

      if (message.type === 'finish') {
        const accumulated = bufferRef.current;
        bufferRef.current = '';

        if (accumulated.length === 0) return;

        const items = parseVisuals(accumulated);
        for (const item of items) {
          const hash = contentHash(item);
          if (!seenRef.current.has(hash)) {
            seenRef.current.add(hash);
            addVisual(item);
          }
        }
      }
    };

    return ipcBridge.acpConversation.responseStream.on(handler);
  }, [conversationId, addVisual]);
}
