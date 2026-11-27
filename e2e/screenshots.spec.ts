import { MOCK_DAEMON_TOKEN } from '../src/mock/fixtures';
import { connect, expect, openServer, test } from './fixtures';

// Phone-size screenshots in dark and light for the visual check (CI artifact "screenshots");
// a few of them are copied to docs/screenshots/ for the README. Run with SCREENSHOTS=1.
test.skip(!process.env.SCREENSHOTS, 'screenshots only with SCREENSHOTS=1');

for (const scheme of ['dark', 'light'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test(`screens (${scheme})`, async ({ page, mock }) => {
      test.setTimeout(90_000);
      const shot = (name: string) => page.screenshot({ path: `screenshots/${name}-${scheme}.png` });

      await page.goto('/');
      await expect(page.getByTestId('screen-connect')).toBeVisible();
      await shot('connect');

      await connect(page, mock, { name: 'Game panel', admin: true });
      await expect(page.getByTestId('state-c3d4e5f6')).toHaveText('Node unreachable');
      await shot('servers');

      await openServer(page);
      await expect(page.getByTestId('meter-disk')).toBeVisible();
      await shot('server');

      await page.getByTestId('open-console').click();
      await page.getByTestId('console-input').fill('list');
      await page.getByTestId('console-send').click();
      await expect(page.getByTestId('console-output')).toContainText('players online');
      await shot('console');
      await page.getByTestId('back').click();

      await page.getByTestId('open-files').click();
      await expect(page.getByTestId('file-server.properties')).toBeVisible();
      await shot('files');
      await page.getByTestId('file-server.properties').click();
      await expect(page.getByTestId('file-text')).toHaveValue(/motd/);
      await shot('editor');
      await page.getByTestId('back').click();
      await page.getByTestId('back').click();

      await page.getByTestId('open-backups').click();
      await expect(page.getByTestId('backup-b0000001-0000-4000-8000-000000000001')).toBeVisible();
      await page.getByTestId('backup-b0000001-0000-4000-8000-000000000001').click();
      await page.getByTestId('backup-restore').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await shot('confirm');
      await page.getByTestId('confirm-cancel').click();

      await page.getByTestId('tab-admin').click();
      await shot('admin');
      await page.getByTestId('admin-adminNodes').click();
      await expect(page.getByTestId('node-state-2')).toHaveText('Unreachable');
      await shot('nodes');
      await page.getByTestId('row-node-1').click();
      await page.getByTestId('node-token').fill(MOCK_DAEMON_TOKEN);
      await page.getByTestId('token-save').click();
      await expect(page.getByTestId('node-wings')).toContainText('1.11.13');
      await shot('node');

      await page.getByTestId('tab-alerts').click();
      await expect(page.getByTestId('alert-disk')).toBeVisible();
      await shot('alerts');

      await page.getByTestId('tab-settings').click();
      await shot('settings');
    });

    test(`account without an application key (${scheme})`, async ({ page, mock }) => {
      await connect(page, mock, { name: 'Game panel' });
      await page.getByTestId('tab-settings').click();
      await page.getByTestId('settings-account').click();
      await page.getByTestId('account-2fa-why').click();
      await expect(page.getByTestId('account-2fa-why-body')).toBeVisible();
      await page.screenshot({ path: `screenshots/account-${scheme}.png` });
    });
  });
}
