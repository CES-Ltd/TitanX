import { ipcBridge } from '@/common';
import useSWR from 'swr';

export const COMMAND_QUEUE_ENABLED_SWR_KEY = 'system.commandQueueEnabled';

/**
 * Returns whether the conversation command queue feature is enabled globally.
 *
 * Optimistic default `true` mirrors the process-side default in
 * `systemSettingsBridge.ts` so the first render doesn't flash a disabled
 * state (which would briefly block queueing for the few ms before SWR
 * resolves).
 */
export const useCommandQueueEnabled = (): boolean => {
  const { data = true } = useSWR(COMMAND_QUEUE_ENABLED_SWR_KEY, () =>
    ipcBridge.systemSettings.getCommandQueueEnabled.invoke()
  );

  return data;
};
