/**
 * @license Apache-2.0
 * SlaveStatusBanner DOM tests.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

const mockUseSlaveStatus = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/fleet/useSlaveStatus', () => ({
  useSlaveStatus: mockUseSlaveStatus,
}));

import SlaveStatusBanner from '@renderer/components/fleet/SlaveStatusBanner';

describe('SlaveStatusBanner', () => {
  it('renders nothing when mode is not slave (hook returns null)', () => {
    mockUseSlaveStatus.mockReturnValue(null);
    const { container } = render(<SlaveStatusBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when slave is online', () => {
    mockUseSlaveStatus.mockReturnValue({
      mode: 'slave',
      connection: 'online',
      deviceId: 'abc',
      lastHeartbeatAt: Date.now(),
    });
    const { container } = render(<SlaveStatusBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('shows offline banner with last sync time when offline', () => {
    mockUseSlaveStatus.mockReturnValue({
      mode: 'slave',
      connection: 'offline',
      lastHeartbeatAt: Date.now() - 60_000,
      lastErrorMessage: 'ECONNREFUSED',
    });
    const { container } = render(<SlaveStatusBanner />);
    const text = container.textContent ?? '';
    expect(text).toContain('Not connected to master');
    expect(text).toContain('Last synced');
    expect(text).toContain('ECONNREFUSED');
  });

  it('shows revoked banner (error level) when connection is revoked', () => {
    mockUseSlaveStatus.mockReturnValue({
      mode: 'slave',
      connection: 'revoked',
      lastErrorMessage: 'device revoked by admin',
    });
    const { container } = render(<SlaveStatusBanner />);
    expect(container.textContent).toContain('This device was removed from the fleet');
  });

  it('shows unenrolled banner (info) when user skipped setup', () => {
    mockUseSlaveStatus.mockReturnValue({ mode: 'slave', connection: 'unenrolled' });
    const { container } = render(<SlaveStatusBanner />);
    expect(container.textContent).toContain('Enrollment incomplete');
  });
});
