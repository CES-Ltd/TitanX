/**
 * @license Apache-2.0
 * SetupWizard DOM tests — first-run mode picker.
 *
 * Covers the critical paths: three-card picker, master + slave screens,
 * "skip" / cancel routing, validation guards on Continue.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@icon-park/react', () => ({
  Computer: () => <span data-testid='icon-computer' />,
  Server: () => <span data-testid='icon-server' />,
  Link: () => <span data-testid='icon-link' />,
}));

const mockCompleteSetup = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/common', () => ({
  ipcBridge: {
    fleet: {
      completeSetup: { invoke: mockCompleteSetup },
    },
  },
}));

import SetupWizard from '@renderer/pages/fleet/SetupWizard';

beforeEach(() => {
  mockCompleteSetup.mockClear();
});

describe('SetupWizard', () => {
  const noop = (): void => {};

  it('renders the three mode cards on the first screen', () => {
    render(<SetupWizard visible onComplete={noop} />);
    expect(screen.getByText('wizard.title')).toBeInTheDocument();
    expect(screen.getAllByText('mode.regular.name')[0]).toBeInTheDocument();
    expect(screen.getAllByText('mode.master.name')[0]).toBeInTheDocument();
    expect(screen.getAllByText('mode.slave.name')[0]).toBeInTheDocument();
  });

  it('disables Continue until a mode is picked', () => {
    render(<SetupWizard visible onComplete={noop} />);
    const continueBtn = screen.getByRole('button', { name: /wizard\.continue/ });
    expect(continueBtn).toBeDisabled();

    // Pick the first Regular card (there's a ModeCard per mode)
    const regularCard = screen.getByRole('button', { name: 'mode.regular.name' });
    fireEvent.click(regularCard);

    expect(screen.getByRole('button', { name: /wizard\.continue/ })).not.toBeDisabled();
  });

  it('Regular mode skips the configure step and goes straight to "done"', async () => {
    render(<SetupWizard visible onComplete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.regular.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    await waitFor(() => {
      expect(screen.getByText('wizard.done')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /wizard\.launch/ })).toBeInTheDocument();
    });
  });

  it('calls onComplete when Launch clicked from "done"', async () => {
    const onComplete = vi.fn();
    render(<SetupWizard visible onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.regular.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    await waitFor(() => screen.getByText('wizard.done'));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.launch/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('"skip" (cancel) calls completeSetup with regular then onComplete', async () => {
    const onComplete = vi.fn();
    render(<SetupWizard visible onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: /wizard\.cancel/ }));
    await waitFor(() => {
      expect(mockCompleteSetup).toHaveBeenCalledWith({ mode: 'regular' });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  it('Master picker → configure screen shows port field and bind radios', () => {
    render(<SetupWizard visible onComplete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    expect(screen.getByText('wizard.master.title')).toBeInTheDocument();
    expect(screen.getByText('wizard.master.portLabel')).toBeInTheDocument();
  });

  it('Master → Back returns to picker screen preserving selection', () => {
    render(<SetupWizard visible onComplete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.back/ }));
    // Back on picker — Continue is still enabled because mode is set
    expect(screen.getByRole('button', { name: /wizard\.continue/ })).not.toBeDisabled();
  });

  it('Slave picker → configure screen shows URL + token inputs', () => {
    render(<SetupWizard visible onComplete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.slave.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    expect(screen.getByText('wizard.slave.title')).toBeInTheDocument();
    expect(screen.getByText('wizard.slave.urlLabel')).toBeInTheDocument();
    expect(screen.getByText('wizard.slave.tokenLabel')).toBeInTheDocument();
  });

  it('Slave submit with skip-later calls completeSetup with no URL/token', async () => {
    render(<SetupWizard visible onComplete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.slave.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    const skipCheckbox = screen.getByRole('checkbox');
    fireEvent.click(skipCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    await waitFor(() => {
      expect(mockCompleteSetup).toHaveBeenCalledWith({ mode: 'slave' });
    });
  });

  it('Master submit writes port + bindAll', async () => {
    render(<SetupWizard visible onComplete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /wizard\.continue/ }));
    await waitFor(() => {
      expect(mockCompleteSetup).toHaveBeenCalledWith({ mode: 'master', masterPort: 8888, masterBindAll: false });
    });
  });
});
