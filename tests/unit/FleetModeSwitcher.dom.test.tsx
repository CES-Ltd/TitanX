/**
 * @license Apache-2.0
 * FleetModeSwitcher DOM tests — change-mode modal from Settings.
 *
 * Covers:
 *   - pre-selects current mode
 *   - clicking Continue with the same mode as current = regular closes modal (no-op)
 *   - master/slave paths go pick → configure → confirm → restart
 *   - Back navigation returns to pick
 *   - Restart calls both fleet.setMode and application.restart
 *   - "I'll restart later" closes modal without writes
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

// Arco Design's Message uses ReactDOM portals that need the React 19 adapter.
// Stub it to a no-op so the "setMode error" test path doesn't emit an
// unhandled "CopyReactDOM.render is not a function" in the vitest harness.
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@arco-design/web-react');
  return {
    ...actual,
    Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

vi.mock('@icon-park/react', () => ({
  Computer: () => <span data-testid='icon-computer' />,
  Server: () => <span data-testid='icon-server' />,
  Link: () => <span data-testid='icon-link' />,
}));

const mockSetMode = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockRestart = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/common', () => ({
  ipcBridge: {
    fleet: { setMode: { invoke: mockSetMode } },
    application: { restart: { invoke: mockRestart } },
  },
}));

import FleetModeSwitcher from '@renderer/pages/fleet/FleetModeSwitcher';
import type { FleetConfig } from '@/common/types/fleetTypes';

const regularConfig: FleetConfig = { mode: 'regular' };

beforeEach(() => {
  mockSetMode.mockClear();
  mockRestart.mockClear();
});

describe('FleetModeSwitcher', () => {
  it('shows three mode cards with the current mode pre-selected', () => {
    render(<FleetModeSwitcher visible onClose={() => {}} currentConfig={regularConfig} />);
    expect(screen.getAllByText('fleet.mode.regular.name')[0]).toBeInTheDocument();
    const regularCard = screen.getByRole('button', { name: 'fleet.mode.regular.name' });
    expect(regularCard).toHaveAttribute('aria-pressed', 'true');
  });

  it('picking same mode (regular → regular) closes modal without writes', () => {
    const onClose = vi.fn();
    render(<FleetModeSwitcher visible onClose={onClose} currentConfig={regularConfig} />);
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    expect(onClose).toHaveBeenCalled();
    expect(mockSetMode).not.toHaveBeenCalled();
  });

  it('master path: pick → configure → confirm → restart', async () => {
    render(<FleetModeSwitcher visible onClose={() => {}} currentConfig={regularConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'fleet.mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    // Configure screen
    expect(screen.getByText('fleet.wizard.master.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    // Confirm screen
    expect(screen.getByText('fleet.settings.changeConfirm.body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /fleet.settings\.changeConfirm\.restartNow/ }));
    await waitFor(() => {
      expect(mockSetMode).toHaveBeenCalledWith({ mode: 'master', masterPort: 8888, masterBindAll: false });
      expect(mockRestart).toHaveBeenCalled();
    });
  });

  it('slave skip-later path: pick → configure → confirm → restart', async () => {
    render(<FleetModeSwitcher visible onClose={() => {}} currentConfig={regularConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'fleet.mode.slave.name' }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    // Tick "skip later"
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    // Confirm
    fireEvent.click(screen.getByRole('button', { name: /fleet.settings\.changeConfirm\.restartNow/ }));
    await waitFor(() => {
      expect(mockSetMode).toHaveBeenCalledWith({ mode: 'slave' });
      expect(mockRestart).toHaveBeenCalled();
    });
  });

  it('"I\'ll restart later" closes modal without restart', async () => {
    const onClose = vi.fn();
    render(<FleetModeSwitcher visible onClose={onClose} currentConfig={regularConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'fleet.mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    // On confirm screen
    fireEvent.click(screen.getByRole('button', { name: /fleet.settings\.changeConfirm\.restartLater/ }));
    expect(onClose).toHaveBeenCalled();
    expect(mockSetMode).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it('Back from master configure returns to pick screen', () => {
    render(<FleetModeSwitcher visible onClose={() => {}} currentConfig={regularConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'fleet.mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.back/ }));
    // Master card still highlighted
    expect(screen.getByRole('button', { name: 'fleet.mode.master.name' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('surfaces error from fleet.setMode without restart', async () => {
    mockSetMode.mockResolvedValueOnce({ ok: false, error: 'Invalid port' });
    render(<FleetModeSwitcher visible onClose={() => {}} currentConfig={regularConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'fleet.mode.master.name' }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /fleet.settings\.changeConfirm\.restartNow/ }));
    await waitFor(() => {
      expect(mockSetMode).toHaveBeenCalled();
      expect(mockRestart).not.toHaveBeenCalled();
    });
  });

  it('pre-fills master port from currentConfig when switching from master', () => {
    render(
      <FleetModeSwitcher
        visible
        onClose={() => {}}
        currentConfig={{ mode: 'master', master: { port: 9999, bindAll: true } }}
      />
    );
    // Master card pre-selected
    expect(screen.getByRole('button', { name: 'fleet.mode.master.name' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /fleet.wizard\.continue/ }));
    // Configure shows preserved port
    expect(screen.getByDisplayValue('9999')).toBeInTheDocument();
  });
});
