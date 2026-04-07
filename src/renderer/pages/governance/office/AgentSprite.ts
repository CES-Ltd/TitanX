/**
 * @license Apache-2.0
 * Agent sprite class for the Phaser pixel-art office.
 * Represents a team agent as an animated character at a desk.
 */

import Phaser from 'phaser';
import type { TeammateStatus } from '@/common/types/teamTypes';

export class AgentSprite extends Phaser.GameObjects.Sprite {
  public slotId: string;
  public agentName: string;
  public currentStatus: TeammateStatus;
  private bobTween: Phaser.Tweens.Tween | null = null;
  private tooltip: Phaser.GameObjects.Container | null = null;
  private taskText: string = '';

  constructor(scene: Phaser.Scene, x: number, y: number, textureKey: string, slotId: string, agentName: string) {
    super(scene, x, y, textureKey, 0);
    this.slotId = slotId;
    this.agentName = agentName;
    this.currentStatus = 'pending';

    this.setScale(2);
    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', () => this.toggleTooltip());

    scene.add.existing(this);
    this.setStatus('idle');
  }

  setStatus(status: TeammateStatus, lastMessage?: string): void {
    this.currentStatus = status;
    if (lastMessage) this.taskText = lastMessage;

    // Clear existing animations
    if (this.bobTween) {
      this.bobTween.stop();
      this.bobTween = null;
    }

    switch (status) {
      case 'idle':
        this.setFrame(0);
        this.bobTween = this.scene.tweens.add({
          targets: this,
          y: this.y - 2,
          duration: 1000,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
        break;
      case 'active':
        // Rapid frame swap between 0 and 1
        this.scene.time.addEvent({
          delay: 300,
          loop: true,
          callback: () => {
            if (this.currentStatus === 'active') {
              this.setFrame(String(this.frame.name) === '0' ? 1 : 0);
            }
          },
        });
        break;
      case 'failed':
        this.setFrame(2);
        break;
      case 'completed':
        this.setFrame(3);
        this.scene.tweens.add({
          targets: this,
          y: this.y - 8,
          duration: 400,
          yoyo: true,
          repeat: 2,
          ease: 'Bounce.easeOut',
        });
        break;
      case 'pending':
        this.setFrame(0);
        this.setAlpha(0.5);
        return;
    }
    this.setAlpha(1);
  }

  private toggleTooltip(): void {
    if (this.tooltip) {
      this.tooltip.destroy();
      this.tooltip = null;
      return;
    }

    const bg = this.scene.add.rectangle(0, 0, 160, 50, 0x1a1a2e, 0.9).setOrigin(0.5);
    bg.setStrokeStyle(1, 0x4488ff);

    const nameText = this.scene.add
      .text(0, -16, this.agentName, {
        fontSize: '11px',
        color: '#ffffff',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);

    const statusColor =
      this.currentStatus === 'active' ? '#44ff44' : this.currentStatus === 'failed' ? '#ff4444' : '#aaaaff';
    const statusText = this.scene.add
      .text(0, 0, this.currentStatus.toUpperCase(), {
        fontSize: '9px',
        color: statusColor,
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);

    const taskLabel = this.scene.add
      .text(0, 12, this.taskText.slice(0, 30) || '—', {
        fontSize: '8px',
        color: '#888899',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);

    this.tooltip = this.scene.add.container(this.x, this.y - 50, [bg, nameText, statusText, taskLabel]);

    // Auto-dismiss after 3 seconds
    this.scene.time.delayedCall(3000, () => {
      if (this.tooltip) {
        this.tooltip.destroy();
        this.tooltip = null;
      }
    });
  }

  destroy(fromScene?: boolean): void {
    if (this.bobTween) this.bobTween.stop();
    if (this.tooltip) this.tooltip.destroy();
    super.destroy(fromScene);
  }
}
