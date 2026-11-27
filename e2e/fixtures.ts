import { expect, test as base, type Page } from '@playwright/test';

import { MOCK_DOWN_NODE_ORIGIN, MOCK_HYDRO_ORIGIN, MOCK_NODE_ORIGIN, MOCK_ORIGIN } from '../src/mock/fixtures';
import { createMockPanel, type MockPanel } from '../src/mock/server';

// Every request to the mock panels and the mock node is answered in-process by the mock server,
// the node's console WebSocket by the mock socket; any other outside request fails the test, so
// no real panel or node is ever contacted.
export const test = base.extend<{ mock: MockPanel; hydro: MockPanel; mockRoutes: void }>({
  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    await use(createMockPanel());
  },
  // eslint-disable-next-line no-empty-pattern
  hydro: async ({}, use) => {
    await use(createMockPanel({ flavor: 'hydrodactyl' }));
  },
  mockRoutes: [
    async ({ context, mock, hydro }, use) => {
      const panels = [mock, hydro];
      await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
        const request = route.request();
        const url = request.url();
        if (url.startsWith(MOCK_DOWN_NODE_ORIGIN)) return route.abort('connectionrefused');
        if (!url.startsWith(MOCK_ORIGIN) && !url.startsWith(MOCK_HYDRO_ORIGIN) && !url.startsWith(MOCK_NODE_ORIGIN)) return route.abort('blockedbyclient');
        const panel = url.startsWith(MOCK_HYDRO_ORIGIN) ? hydro : mock;
        const answer = panel.handle({ method: request.method(), url, headers: request.headers(), body: request.postDataBuffer()?.toString('latin1') ?? null });
        if (!answer) return route.abort('connectionrefused');
        return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
      });
      await context.routeWebSocket(/^wss?:\/\//, (ws) => {
        const owner = panels.find((p) => p.ownsSocket(ws.url()));
        if (!owner) {
          void ws.close({ code: 1006 });
          return;
        }
        const endpoint = owner.openConsole(
          ws.url(),
          (text) => ws.send(text),
          (code) => void ws.close({ code })
        );
        ws.onMessage((message) => endpoint.receive(typeof message === 'string' ? message : message.toString('utf8')));
        ws.onClose(() => endpoint.close());
      });
      await use();
    },
    { auto: true },
  ],
});

export { expect };

export interface ConnectOptions {
  name?: string;
  flavor?: 'pterodactyl' | 'hydrodactyl';
  admin?: boolean;
}

/** Opens the app and connects a mock panel through the connect screen. */
export async function connect(page: Page, panel: MockPanel, options: ConnectOptions = {}): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('screen-connect')).toBeVisible();
  if (options.name) await page.getByTestId('connect-name').fill(options.name);
  await page.getByTestId('connect-url').fill(panel.origin.replace('https://', ''));
  await page.getByTestId('connect-key').fill(panel.clientKey);
  if (options.admin) {
    await page.getByTestId('connect-admin').click();
    await page.getByTestId('connect-app-key').fill(panel.appKey);
  }
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('screen-servers')).toBeVisible();
}

/** Opens a server from the servers list. */
export async function openServer(page: Page, identifier = 'a1b2c3d4'): Promise<void> {
  await page.getByTestId(`row-server-${identifier}`).click();
  await expect(page.getByTestId('screen-server')).toBeVisible();
}
