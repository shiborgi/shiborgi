import { describe, it, expect } from 'bun:test';
import { listProviderNames } from './provider-registry.js';
import './index.js';

describe('pi provider registration (container)', () => {
  it("registers `pi` with the agent-runner's provider registry", () => {
    expect(listProviderNames()).toContain('pi');
  });
});
