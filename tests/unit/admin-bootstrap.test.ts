import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The admin bootstrap script is a privileged recovery tool: it must refuse to
 * run unless CONFIRM_ADMIN_BOOTSTRAP=YES is set, and it must abort BEFORE any
 * database connection when the confirmation is missing or wrong.
 *
 * These tests do not require a database: if the gate works, the process exits
 * with the confirmation error and never attempts a Prisma connection.
 */

const runScript = (extraEnv: Record<string, string>) =>
  execFileAsync('npx', ['tsx', 'prisma/admin.ts'], {
    env: {
      ...process.env,
      ADMIN_EMAIL: 'admin@kiensports.com',
      ADMIN_PASSWORD: 'test-password-123456',
      ...extraEnv,
    },
    timeout: 30_000,
  });

describe('admin bootstrap confirmation gate', () => {
  it('aborts when CONFIRM_ADMIN_BOOTSTRAP is missing', async () => {
    await expect(runScript({ CONFIRM_ADMIN_BOOTSTRAP: '' })).rejects.toThrow();
  });

  it('aborts when CONFIRM_ADMIN_BOOTSTRAP has the wrong value', async () => {
    await expect(runScript({ CONFIRM_ADMIN_BOOTSTRAP: 'yes' })).rejects.toThrow();
  });

  it('reports the confirmation requirement, not credentials, in the abort message', async () => {
    try {
      await runScript({ CONFIRM_ADMIN_BOOTSTRAP: '' });
      expect.unreachable('script should have aborted');
    } catch (err) {
      const message = String(err);
      expect(message).toContain('CONFIRM_ADMIN_BOOTSTRAP');
      expect(message).not.toContain('test-password-123456');
    }
  });
});
