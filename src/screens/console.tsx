import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, TextInput, View } from 'react-native';

import { ConsoleSession, platformSocket, type ConsoleState, type SocketFactory } from '../api/console';
import { formatBytes, formatNumber } from '../i18n';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import { Badge, Button, ErrorPanel, Loading, Notice, Screen, T, styles, type Tone } from '../ui/kit';
import { stateBadge, useServer } from './common';

/** Tests replace the socket; the app uses the platform WebSocket. */
let socketFactory: SocketFactory = platformSocket;
export function setConsoleSocketFactory(factory: SocketFactory): void {
  socketFactory = factory;
}

const KNOWN_ERRORS = ['suspended', 'origin', 'jwt', 'daemon', 'conflict', 'forbidden', 'network', 'insecure'] as const;

function consoleError(t: ReturnType<typeof useApp>['t'], error: string): string {
  const known = KNOWN_ERRORS.find((k) => k === error);
  return known ? t(`console.error.${known}`) : t('console.error.generic', { reason: error });
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, monospace' });

export function ConsoleScreen({ id }: { id: string }) {
  const { t, client, theme, language } = useApp();
  const nav = useNav();
  const server = useServer(id);
  const [state, setState] = useState<ConsoleState>({ status: 'connecting', lines: [] });
  const [command, setCommand] = useState('');
  const session = useRef<ConsoleSession | null>(null);
  const scroll = useRef<ScrollView>(null);
  const s = server.data;

  useEffect(() => {
    if (!client || !s) return undefined;
    const next = new ConsoleSession(client, s, socketFactory);
    session.current = next;
    const unsubscribe = next.subscribe(setState);
    void next.start();
    return () => {
      unsubscribe();
      next.stop();
      session.current = null;
    };
  }, [client, s]);

  const send = () => {
    if (session.current?.sendCommand(command)) setCommand('');
  };

  const statusTone: Record<ConsoleState['status'], Tone> = { connecting: 'info', connected: 'success', reconnecting: 'warning', closed: 'neutral', failed: 'danger' };
  const power = stateBadge(t, state.power, s?.status);
  const stats = state.stats;

  return (
    <Screen title={t('console.title', { name: s?.name ?? id })} onBack={nav.pop} scroll={false} testID="screen-console">
      {server.error ? <ErrorPanel error={server.error} onRetry={server.reload} /> : null}
      {!s && !server.error ? <Loading /> : null}
      <View style={[styles.row, { gap: theme.space(2), flexWrap: 'wrap' }]}>
        <Badge label={t(`console.${state.status}`)} tone={statusTone[state.status]} testID="console-status" />
        {state.power ? <Badge label={power.label} tone={power.tone} testID="console-power" /> : null}
        {stats ? (
          <T variant="caption" testID="console-stats">
            {`${formatNumber(stats.cpu_absolute, language)} % CPU · ${formatBytes(stats.memory_bytes, language)} / ${stats.memory_limit_bytes ? formatBytes(stats.memory_limit_bytes, language) : '∞'}`}
          </T>
        ) : null}
      </View>
      {state.status === 'failed' && state.error ? (
        <Notice tone="danger" testID="console-error">
          {consoleError(t, state.error)}
        </Notice>
      ) : null}
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        style={{ flex: 1, backgroundColor: theme.mode === 'dark' ? theme.color.surfaceSunken : '#0B1220', borderRadius: theme.radius, padding: theme.space(3) }}
        testID="console-output"
      >
        {state.lines.map((line, index) => (
          <T key={index} selectable style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 17, color: theme.mode === 'dark' ? theme.color.text : '#E6EDF7' }}>
            {line || ' '}
          </T>
        ))}
      </ScrollView>
      <View style={[styles.row, { gap: theme.space(2) }]}>
        <TextInput
          value={command}
          onChangeText={setCommand}
          onSubmitEditing={send}
          placeholder={t('console.placeholder')}
          placeholderTextColor={theme.color.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={state.status === 'connected'}
          aria-label={t('console.placeholder')}
          testID="console-input"
          returnKeyType="send"
          style={{
            flex: 1,
            color: theme.color.text,
            backgroundColor: theme.color.surfaceSunken,
            borderColor: theme.color.border,
            borderWidth: 1,
            borderRadius: Math.max(6, theme.radius * 0.6),
            paddingHorizontal: theme.space(3),
            paddingVertical: theme.space(2.5),
            fontFamily: MONO,
            fontSize: 14,
          }}
        />
        <Button label={t('console.send')} onPress={send} disabled={state.status !== 'connected' || command.trim() === ''} testID="console-send" />
      </View>
    </Screen>
  );
}
