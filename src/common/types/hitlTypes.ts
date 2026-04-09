/**
 * Human-in-the-Loop (HITL) types for AG-UI interrupt/confirmation flows.
 * Used by both main process (StreamBridge) and renderer (HumanInTheLoop component).
 */

export type HitlStepStatus = 'enabled' | 'disabled' | 'executing';

export type HitlStep = {
  description: string;
  status: HitlStepStatus;
};

export type HitlInterrupt = {
  id: string;
  message: string;
  steps: HitlStep[];
  status: 'pending' | 'accepted' | 'rejected';
};

export type HitlResponse = {
  interruptId: string;
  accepted: boolean;
  steps?: HitlStep[];
};
