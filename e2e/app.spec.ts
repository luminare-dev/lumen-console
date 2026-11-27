import { MOCK_DAEMON_TOKEN } from '../src/mock/fixtures';
import { connect, expect, openServer, test } from './fixtures';

test.describe('connect', () => {
  test('warns that keys are session-only on the web', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('web-key-warning')).toContainText('only for this browser tab');
  });

  test('refuses http:// before sending anything', async ({ page, mock }) => {
    await page.goto('/');
    await page.getByTestId('connect-url').fill('http://panel.example.net');
    await page.getByTestId('connect-key').fill(mock.clientKey);
    await page.getByTestId('connect-submit').click();
    await expect(page.getByTestId('error-insecure')).toBeVisible();
    expect(mock.log).toEqual([]);
  });

  test('explains a wrong key, a key in the wrong field and an unreachable panel', async ({ page, mock }) => {
    await page.goto('/');
    await page.getByTestId('connect-url').fill('panel.example.net');
    await page.getByTestId('connect-key').fill('ptlc_wrong');
    await page.getByTestId('connect-submit').click();
    await expect(page.getByTestId('error-unauthorized')).toBeVisible();
    await page.getByTestId('connect-key').fill(mock.appKey);
    await page.getByTestId('connect-submit').click();
    await expect(page.getByTestId('error-wrongKeyType')).toBeVisible();
    await page.getByTestId('connect-url').fill('unreachable.example.org');
    await page.getByTestId('connect-key').fill(mock.clientKey);
    await page.getByTestId('connect-submit').click();
    await expect(page.getByTestId('error-network')).toBeVisible();
  });

  test('connects and lists the servers with their state', async ({ page, mock }) => {
    await connect(page, mock, { name: 'Game panel' });
    await expect(page.getByTestId('state-a1b2c3d4')).toHaveText('Running');
    await expect(page.getByTestId('state-b2c3d4e5')).toHaveText('Offline');
    await expect(page.getByTestId('state-c3d4e5f6')).toHaveText('Node unreachable');
    await expect(page.getByTestId('row-server-d4e5f6a7')).toBeHidden();
    // A plain user without an application key has no admin tab.
    await expect(page.getByTestId('tab-admin')).toBeVisible(); // ada is a root admin
    expect(mock.log).toContain('GET /api/client/account');
    expect(mock.log).toContain('GET /api/client/version');
  });

  test('keeps the panel after a reload (same tab session) and searches', async ({ page, mock }) => {
    await connect(page, mock);
    await page.reload();
    await expect(page.getByTestId('row-server-a1b2c3d4')).toBeVisible();
    await page.getByTestId('search').fill('creat');
    await expect(page.getByTestId('row-server-a1b2c3d4')).toBeHidden();
    await expect(page.getByTestId('row-server-b2c3d4e5')).toBeVisible();
  });
});

test.describe('server', () => {
  test('shows usage and asks before every power action', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await expect(page.getByTestId('server-state')).toHaveText('Running');
    await expect(page.getByTestId('meter-disk')).toContainText('93 %');
    await page.getByTestId('power-stop').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Stop Survival?');
    await page.getByTestId('confirm-cancel').click();
    expect(mock.data.servers[0].state).toBe('running');
    await page.getByTestId('power-kill').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('server-state')).toHaveText('Offline');
    expect(mock.data.servers[0].state).toBe('offline');
  });

  test('streams the live console, sends commands and follows power changes', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await page.getByTestId('open-console').click();
    await expect(page.getByTestId('console-status')).toHaveText('Live');
    await expect(page.getByTestId('console-output')).toContainText('ben joined the game');
    await expect(page.getByTestId('console-stats')).toContainText('CPU');
    await page.getByTestId('console-input').fill('list');
    await page.getByTestId('console-send').click();
    await expect(page.getByTestId('console-output')).toContainText('There are 1 of a max of 20 players online: ben');
    expect(mock.commands.a1b2c3d4).toEqual(['list']);
    await page.getByTestId('console-input').fill('say hello');
    await page.getByTestId('console-input').press('Enter');
    await expect(page.getByTestId('console-output')).toContainText('ran say hello');
    // A stop from elsewhere (the panel, a schedule) reaches the console.
    const server = mock.data.servers[0];
    await page.getByTestId('back').click();
    await page.getByTestId('power-stop').click();
    await page.getByTestId('confirm-ok').click();
    expect(server.state).toBe('offline');
    await page.getByTestId('open-console').click();
    await expect(page.getByTestId('console-power')).toHaveText('Offline');
  });

  test('explains when the console cannot connect', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page, 'c3d4e5f6');
    await page.getByTestId('open-console').click();
    await expect(page.getByTestId('console-error')).toContainText('cannot reach the node');
  });

  test('browses, edits, renames, creates and deletes files', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await page.getByTestId('open-files').click();
    await expect(page.getByTestId('file-logs')).toBeVisible();
    await page.getByTestId('file-logs').click();
    await expect(page.getByTestId('file-latest.log')).toBeVisible();
    await page.getByTestId('back').click();

    await page.getByTestId('file-server.properties').click();
    await expect(page.getByTestId('file-text')).toHaveValue(/max-players=20/);
    await page.getByTestId('file-text').fill('max-players=40\n');
    await page.getByTestId('file-save').click();
    await expect(page.getByTestId('file-saved')).toBeVisible();
    expect(mock.data.servers[0].contents['/server.properties']).toBe('max-players=40\n');
    await page.getByTestId('back').click();

    await page.getByTestId('file-menu-eula.txt').click();
    await page.getByTestId('file-rename').click();
    await page.getByTestId('files-name').fill('eula-old.txt');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('file-eula-old.txt')).toBeVisible();

    await page.getByTestId('files-new-folder').click();
    await page.getByTestId('files-name').fill('maps');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('file-maps')).toBeVisible();

    await page.getByTestId('file-menu-eula-old.txt').click();
    await page.getByTestId('file-delete').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('cannot be undone');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('file-eula-old.txt')).toBeHidden();
  });

  test('downloads through a signed link and uploads a file', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await page.getByTestId('open-files').click();
    await page.getByTestId('file-menu-server.jar').click();
    const popup = page.waitForEvent('popup');
    await page.getByTestId('file-download').click();
    const opened = await popup;
    await opened.waitForURL(/^https:\/\/node1\.example\.net:8080\/download\/file\?token=/);

    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('files-upload').click();
    await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.getByTestId('files-notice')).toContainText('notes.txt was uploaded');
    expect(mock.uploads).toEqual([{ directory: '/', name: 'notes.txt' }]);
    await expect(page.getByTestId('file-notes.txt')).toBeVisible();
  });

  test('creates and restores backups with confirmation', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await page.getByTestId('open-backups').click();
    await expect(page.getByTestId('backup-b0000002-0000-4000-8000-000000000002')).toContainText('Failed');
    await page.getByTestId('backup-create').click();
    await page.getByTestId('backup-name').fill('Before update');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('backups-notice')).toBeVisible();
    expect(mock.data.servers[0].backups.some((b) => b.name === 'Before update')).toBe(true);
    await page.getByTestId('backup-b0000001-0000-4000-8000-000000000001').click();
    await page.getByTestId('backup-restore').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Changes since the backup can be lost');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('backups-notice')).toContainText('restore has started');
    expect(mock.data.servers[0].status).toBe('restoring_backup');
  });

  test('runs a schedule and edits startup variables', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await page.getByTestId('open-schedules').click();
    await page.getByTestId('schedule-run-11').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('schedules-notice')).toContainText('Nightly restart');
    await page.getByTestId('back').click();

    await page.getByTestId('open-startup').click();
    await expect(page.getByTestId('startup-command')).toContainText('java');
    await expect(page.getByTestId('variable-BUILD_TYPE')).toContainText('Read-only');
    await page.getByTestId('variable-input-GAME_VERSION').fill('x'.repeat(25));
    await page.getByTestId('variable-save-GAME_VERSION').click();
    await expect(page.getByTestId('variable-GAME_VERSION').getByTestId('error-badRequest')).toContainText('20 characters');
    await page.getByTestId('variable-input-GAME_VERSION').fill('1.21.5');
    await page.getByTestId('variable-save-GAME_VERSION').click();
    await expect(page.getByTestId('variable-GAME_VERSION')).toContainText('Saved');
    expect(mock.data.servers[0].variables.find((v) => v.env_variable === 'GAME_VERSION')?.server_value).toBe('1.21.5');
  });

  test('shows databases, allocations, users and the account', async ({ page, mock }) => {
    await connect(page, mock);
    await openServer(page);
    await page.getByTestId('open-databases').click();
    await expect(page.getByTestId('database-kz8Q2a')).toContainText('s1_stats');
    await page.getByTestId('back').click();
    await page.getByTestId('open-network').click();
    await expect(page.getByTestId('allocation-101')).toContainText('play.example.net:25565');
    await expect(page.getByTestId('allocation-101')).toContainText('Primary');
    await page.getByTestId('back').click();
    await page.getByTestId('open-subusers').click();
    await expect(page.getByTestId('subuser-ben')).toContainText('2FA on');
    await page.getByTestId('tab-settings').click();
    await page.getByTestId('settings-account').click();
    await expect(page.getByTestId('account-2fa')).toHaveText('Unknown');
    await expect(page.getByTestId('api-key-ptlc_mockKey02')).toContainText('198.51.100.7');
  });
});

test.describe('admin', () => {
  test('lists, searches and creates users', async ({ page, mock }) => {
    await connect(page, mock, { admin: true });
    await page.getByTestId('tab-admin').click();
    await page.getByTestId('admin-adminUsers').click();
    await expect(page.getByTestId('row-user-3')).toBeVisible();
    await page.getByTestId('search').fill('cle');
    await expect(page.getByTestId('row-user-1')).toBeHidden();
    await expect(page.getByTestId('row-user-3')).toBeVisible();
    await page.getByTestId('search').fill('');
    await page.getByTestId('create').click();
    await page.getByTestId('user-email').fill('ben@example.net');
    await page.getByTestId('user-username').fill('newbie');
    await page.getByTestId('user-first').fill('New');
    await page.getByTestId('user-last').fill('Person');
    await page.getByTestId('form-submit').click();
    await expect(page.getByTestId('error-badRequest')).toContainText('email has already been taken');
    await page.getByTestId('user-email').fill('newbie@example.net');
    await page.getByTestId('form-submit').click();
    await expect(page.getByTestId('screen-admin-users')).toBeVisible();
    expect(mock.data.users.some((u) => u.username === 'newbie')).toBe(true);
  });

  test('edits a user and suspends all their servers', async ({ page, mock }) => {
    await connect(page, mock, { admin: true });
    await page.getByTestId('tab-admin').click();
    await page.getByTestId('admin-adminUsers').click();
    await page.getByTestId('row-user-2').click();
    await expect(page.getByTestId('user-2fa')).toHaveText('2FA on');
    await page.getByTestId('user-edit').click();
    await expect(page.getByTestId('user-first')).toHaveValue('Ben');
    await page.getByTestId('user-first').fill('Benedikt');
    await page.getByTestId('form-submit').click();
    expect(mock.data.users.find((u) => u.id === 2)?.first_name).toBe('Benedikt');
    await page.getByTestId('user-suspend').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('user-server-2')).toContainText('Suspended');
    expect(mock.data.servers[1].status).toBe('suspended');
  });

  test('suspends, unsuspends and reinstalls a server only after confirming', async ({ page, mock }) => {
    await connect(page, mock, { admin: true });
    await page.getByTestId('tab-admin').click();
    await page.getByTestId('admin-adminServers').click();
    await page.getByTestId('row-admin-server-2').click();
    await page.getByTestId('server-suspend').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('admin-server-state')).toHaveText('Suspended');
    await page.getByTestId('server-unsuspend').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('admin-server-state')).toHaveText('Active');
    await page.getByTestId('server-reinstall').click();
    await page.getByTestId('confirm-ok').click();
    expect(mock.data.servers[1].status).toBeNull();
    await page.getByTestId('confirm-name').fill('Creative');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('admin-server-notice')).toContainText('reinstall of Creative');
    expect(mock.data.servers[1].status).toBe('installing');
  });

  test('shows node health, allocation usage and Wings details with a token', async ({ page, mock }) => {
    await connect(page, mock, { admin: true });
    await page.getByTestId('tab-admin').click();
    await page.getByTestId('admin-adminNodes').click();
    await expect(page.getByTestId('node-state-1')).toHaveText('Online');
    await expect(page.getByTestId('node-state-2')).toHaveText('Unreachable');
    await page.getByTestId('row-node-1').click();
    await expect(page.getByTestId('node-allocations')).toContainText('9 of 40 ports assigned');
    await expect(page.getByTestId('node-wings')).toContainText('daemon token');
    await page.getByTestId('node-token').fill(MOCK_DAEMON_TOKEN);
    await page.getByTestId('token-save').click();
    await expect(page.getByTestId('node-wings')).toContainText('1.11.13');
    await expect(page.getByTestId('node-wings')).toContainText('Ubuntu 24.04.1 LTS');
    await page.getByTestId('back').click();
    await page.getByTestId('back').click();
    await page.getByTestId('admin-adminLocations').click();
    await expect(page.getByTestId('location-1')).toContainText('Falkenstein');
    await page.getByTestId('back').click();
    await page.getByTestId('admin-adminNests').click();
    await page.getByTestId('nest-1').click();
    await expect(page.getByTestId('egg-1')).toContainText('Voxel');
  });

  test('reads 2FA from the admin API on the account screen', async ({ page, mock }) => {
    await connect(page, mock, { admin: true });
    await page.getByTestId('tab-settings').click();
    await page.getByTestId('settings-account').click();
    await expect(page.getByTestId('account-2fa')).toHaveText('2FA on');
  });
});

test.describe('Hydrodactyl', () => {
  test('is detected and uses the daemon-type routes for files and the console', async ({ page, hydro }) => {
    await connect(page, hydro, { admin: true });
    await expect(page.getByTestId('flavor-badge')).toContainText('Hydrodactyl canary-2026.10');
    await openServer(page);
    await expect(page.getByTestId('cpu-history')).toBeVisible();
    await page.getByTestId('open-files').click();
    await expect(page.getByTestId('file-server.properties')).toBeVisible();
    expect(hydro.log).toContain('GET /api/client/servers/wings/a1b2c3d4/files/list?directory=/');
    await page.getByTestId('back').click();
    await page.getByTestId('open-console').click();
    await expect(page.getByTestId('console-status')).toHaveText('Live');
    await page.getByTestId('tab-admin').click();
    await expect(page.getByTestId('panel-status')).toContainText('4 cores');
  });
});

test.describe('alerts and settings', () => {
  test('lists the alerts of the mock panel', async ({ page, mock }) => {
    await connect(page, mock, { name: 'Main', admin: true });
    await page.getByTestId('tab-alerts').click();
    await expect(page.getByTestId('alert-disk')).toContainText('Main: Survival uses 93 % of its disk.');
    await expect(page.getByTestId('alert-backup')).toContainText('Nightly');
    await expect(page.getByTestId('alert-nodeDown')).toContainText('hel-2');
  });

  test('switches off a panel’s alerts', async ({ page, mock }) => {
    await connect(page, mock, { name: 'Main' });
    await page.getByTestId('tab-settings').click();
    await page.getByTestId('settings-panels').click();
    await page.locator('[data-testid^="panel-"]').first().click();
    await expect(page.getByTestId('panel-flavor')).toHaveText('Pterodactyl panel');
    await page.getByTestId('alerts-enabled').click();
    await page.getByTestId('tab-alerts').click();
    await expect(page.getByTestId('alerts-none')).toBeVisible();
  });

  test('switches to German', async ({ page, mock }) => {
    await connect(page, mock);
    await page.getByTestId('tab-settings').click();
    await page.getByTestId('language-de').click();
    await expect(page.getByTestId('tab-settings')).toContainText('Einstellungen');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  });

  test('imports a token file and reports the invalid values', async ({ page, mock }) => {
    await connect(page, mock);
    await page.getByTestId('tab-settings').click();
    await page.getByTestId('tokens-import').click();
    await page.getByTestId('tokens-json').fill('{"color":{"dark":{"accent":"#FF8800","text":"red"}}}');
    await page.getByTestId('tokens-apply').click();
    await expect(page.getByTestId('tokens-result')).toContainText('color.dark.text');
    await page.getByTestId('tokens-json').fill('not json');
    await page.getByTestId('tokens-apply').click();
    await expect(page.getByTestId('tokens-result')).toContainText('not valid JSON');
  });
});
