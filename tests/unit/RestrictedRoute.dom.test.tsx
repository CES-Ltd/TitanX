/**
 * @license Apache-2.0
 * RestrictedRoute DOM tests — route-level guard for slave mode.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));

vi.mock('@icon-park/react', () => ({
  Lock: () => <span data-testid='lock-icon' />,
}));

// Hook mock: return value per test via mockReturnValue
const mockUseFleetMode = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/fleet/useFleetMode', () => ({
  useFleetMode: mockUseFleetMode,
}));

import RestrictedRoute from '@renderer/components/common/RestrictedRoute';

describe('RestrictedRoute', () => {
  it('renders children when the current mode is in allowedModes', () => {
    mockUseFleetMode.mockReturnValue('regular');
    render(
      <RestrictedRoute feature='Governance' allowedModes={['regular', 'master']}>
        <span data-testid='governance-content'>Governance body</span>
      </RestrictedRoute>
    );
    expect(screen.getByTestId('governance-content')).toBeInTheDocument();
  });

  it('renders the restricted banner when mode is not in allowedModes', () => {
    mockUseFleetMode.mockReturnValue('slave');
    render(
      <RestrictedRoute feature='Governance' allowedModes={['regular', 'master']}>
        <span data-testid='governance-content'>Governance body</span>
      </RestrictedRoute>
    );
    expect(screen.queryByTestId('governance-content')).not.toBeInTheDocument();
    expect(screen.getByTestId('lock-icon')).toBeInTheDocument();
    expect(screen.getByText(/Governance/)).toBeInTheDocument();
  });

  it('blocks master when allowedModes is regular-only', () => {
    mockUseFleetMode.mockReturnValue('master');
    render(
      <RestrictedRoute feature='Private' allowedModes={['regular']}>
        <span data-testid='body'>Body</span>
      </RestrictedRoute>
    );
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('allows master-only routes for master mode only', () => {
    mockUseFleetMode.mockReturnValue('master');
    render(
      <RestrictedRoute feature='Fleet' allowedModes={['master']}>
        <span data-testid='fleet-body'>Fleet</span>
      </RestrictedRoute>
    );
    expect(screen.getByTestId('fleet-body')).toBeInTheDocument();

    mockUseFleetMode.mockReturnValue('regular');
    render(
      <RestrictedRoute feature='Fleet' allowedModes={['master']}>
        <span data-testid='fleet-body-2'>Fleet</span>
      </RestrictedRoute>
    );
    expect(screen.queryByTestId('fleet-body-2')).not.toBeInTheDocument();
  });
});
