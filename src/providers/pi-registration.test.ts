import { describe, it, expect } from 'vitest';
import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js';

describe('pi provider registration', () => {
  it('registers `pi` with the host-side provider container-config barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('pi');
  });
});
