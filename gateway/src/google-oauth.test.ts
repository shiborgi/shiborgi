import { describe, expect, it } from 'bun:test';

import { googleAccessToken } from './google-oauth.js';

describe('googleAccessToken', () => {
  it('refuses an unconnected profile before contacting Google', async () => {
    await expect(
      googleAccessToken('primary', {
        provider: 'google', expectedEmail: 'owner@example.com', clientIdSecret: 'ID', clientSecretSecret: 'SECRET',
        refreshTokenSecret: 'REFRESH', scopes: ['openid'],
      }, {}),
    ).rejects.toThrow('not connected');
  });
});
