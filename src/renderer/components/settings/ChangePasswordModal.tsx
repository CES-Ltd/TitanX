/**
 * @license Apache-2.0
 * ChangePasswordModal — in-app admin password change (v1.9.38).
 *
 * Uses the existing `webui.changePassword` IPC which already requires
 * currentPassword (server-side bcrypt verify in WebuiService.changePassword).
 * Until now there was no UI path that wired up to it — you had to
 * run `bun run resetpass` from a dev checkout.
 *
 * Fields:
 *   - current password
 *   - new password
 *   - confirm new password (client-side match check; server validates
 *     strength independently)
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Message, Modal } from '@arco-design/web-react';
import { ipcBridge } from '@/common';

type Props = {
  open: boolean;
  onClose: () => void;
};

const ChangePasswordModal: React.FC<Props> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = useCallback(async () => {
    if (!current) {
      Message.error(t('settings.password.missingCurrent', { defaultValue: 'Enter your current password' }));
      return;
    }
    if (!next || next.length < 8) {
      Message.error(t('settings.password.tooShort', { defaultValue: 'New password must be at least 8 characters' }));
      return;
    }
    if (next !== confirm) {
      Message.error(t('settings.password.mismatch', { defaultValue: 'Passwords do not match' }));
      return;
    }
    if (next === current) {
      Message.error(
        t('settings.password.sameAsCurrent', {
          defaultValue: 'New password must be different from your current password',
        })
      );
      return;
    }
    setSubmitting(true);
    try {
      const result = await ipcBridge.webui.changePassword.invoke({
        currentPassword: current,
        newPassword: next,
      });
      if (result.success) {
        Message.success(t('settings.password.success', { defaultValue: 'Password updated' }));
        reset();
        onClose();
      } else {
        // Server error messages cover: "Current password is incorrect",
        // password-strength failures, etc. Pass them through.
        Message.error(result.msg ?? t('settings.password.genericError', { defaultValue: 'Failed to update password' }));
      }
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [current, next, confirm, onClose, t]);

  return (
    <Modal
      visible={open}
      onCancel={handleClose}
      title={t('settings.password.title', { defaultValue: 'Change password' })}
      footer={
        <div className='flex justify-end gap-2'>
          <Button onClick={handleClose} disabled={submitting}>
            {t('settings.password.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type='primary' loading={submitting} onClick={handleSubmit}>
            {t('settings.password.submit', { defaultValue: 'Update password' })}
          </Button>
        </div>
      }
      style={{ width: 440 }}
    >
      <div className='space-y-3'>
        <div>
          <div className='text-12px text-t-tertiary mb-1'>
            {t('settings.password.current', { defaultValue: 'Current password' })}
          </div>
          <Input.Password value={current} onChange={setCurrent} autoFocus />
        </div>
        <div>
          <div className='text-12px text-t-tertiary mb-1'>
            {t('settings.password.new', { defaultValue: 'New password (at least 8 characters)' })}
          </div>
          <Input.Password value={next} onChange={setNext} />
        </div>
        <div>
          <div className='text-12px text-t-tertiary mb-1'>
            {t('settings.password.confirm', { defaultValue: 'Confirm new password' })}
          </div>
          <Input.Password value={confirm} onChange={setConfirm} onPressEnter={() => void handleSubmit()} />
        </div>
      </div>
    </Modal>
  );
};

export default ChangePasswordModal;
