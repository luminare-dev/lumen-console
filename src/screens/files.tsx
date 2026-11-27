import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { classifyFetchError, PanelError } from '../api/errors';
import type { FileObject } from '../api/types';
import { formatBytes, formatDateTime } from '../i18n';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import { useResource } from '../state/useResource';
import { ActionSheet, Button, ConfirmDialog, ErrorPanel, Field, ListRow, Loading, Notice, Screen, T, styles } from '../ui/kit';
import { joinPath, useServer } from './common';

const asPanelError = (error: unknown) => (error instanceof PanelError ? error : classifyFetchError(error));

/** Files up to this size open in the editor; bigger ones are offered as a download. */
export const MAX_EDIT_BYTES = 512 * 1024;
const BINARY = /^(application\/(octet-stream|java-archive|zip|gzip|x-tar|x-7z|x-rar|x-executable|x-sharedlib)|image\/|audio\/|video\/|inode\/)/;

export function isEditable(file: FileObject): boolean {
  return file.is_file && file.size <= MAX_EDIT_BYTES && !BINARY.test(file.mimetype);
}

export function FilesScreen({ id, dir }: { id: string; dir: string }) {
  const { t, client, language, theme } = useApp();
  const nav = useNav();
  const server = useServer(id);
  const s = server.data;
  const list = useResource(s ? client : null, `files:${id}:${dir}`, (c) => c.files(s!, dir));
  const [selected, setSelected] = useState<FileObject | null>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'folder' | null>(null);
  const [target, setTarget] = useState<FileObject | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [notice, setNotice] = useState<string>();

  const entries = useMemo(
    () => [...(list.data ?? [])].sort((a, b) => (a.is_file === b.is_file ? a.name.localeCompare(b.name) : a.is_file ? 1 : -1)),
    [list.data]
  );

  const act = async (work: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      setDialog(null);
      if (done) setNotice(done);
      list.reload();
    } catch (caught) {
      setError(asPanelError(caught));
      setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  const download = async (file: FileObject) => {
    if (!client || !s) return;
    await act(async () => {
      const url = await client.downloadUrl(s, joinPath(dir, file.name));
      await Linking.openURL(url);
    });
  };

  const upload = async () => {
    if (!client || !s) return;
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0];
    await act(
      () => client.upload(s, dir, { uri: asset.uri, name: asset.name, type: asset.mimeType ?? undefined, blob: asset.file ?? undefined }),
      t('files.uploaded', { name: asset.name })
    );
  };

  const crumbs = dir === '/' ? ['/'] : ['/', ...dir.split('/').filter(Boolean)];

  return (
    <Screen title={t('files.title')} onBack={nav.pop} testID="screen-files">
      <T variant="caption" testID="files-path">
        {`${s?.name ?? id}: ${crumbs.join(' › ').replace('/ › ', '/')}`}
      </T>
      <View style={[styles.row, { gap: theme.space(2), flexWrap: 'wrap' }]}>
        <Button label={t('files.newFolder')} kind="secondary" compact onPress={() => (setName(''), setDialog('folder'))} testID="files-new-folder" />
        <Button label={t('files.upload')} kind="secondary" compact onPress={() => void upload()} busy={busy && dialog === null} testID="files-upload" />
      </View>
      {notice ? <Notice tone="success" testID="files-notice">{notice}</Notice> : null}
      {error ? <ErrorPanel error={error} /> : null}
      {list.error ? <ErrorPanel error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && entries.length === 0 ? <T variant="muted" testID="list-empty">{t('files.empty')}</T> : null}
      {entries.map((file) => (
        <ListRow
          key={file.name}
          title={`${file.is_file ? '' : '▸ '}${file.name}`}
          subtitle={file.is_file ? `${formatBytes(file.size, language)} · ${formatDateTime(file.modified_at, language)}` : formatDateTime(file.modified_at, language)}
          onPress={() => (file.is_file ? (isEditable(file) ? nav.push({ name: 'file', id, path: joinPath(dir, file.name) }) : setSelected(file)) : nav.push({ name: 'files', id, dir: joinPath(dir, file.name) }))}
          right={<Button label="⋯" kind="ghost" compact onPress={() => setSelected(file)} testID={`file-menu-${file.name}`} />}
          testID={`file-${file.name}`}
        />
      ))}

      <ActionSheet
        visible={selected !== null}
        title={selected?.name ?? ''}
        onClose={() => setSelected(null)}
        actions={
          selected
            ? [
                ...(selected.is_file && isEditable(selected) ? [{ label: t('files.open'), onPress: () => nav.push({ name: 'file', id, path: joinPath(dir, selected.name) }), testID: 'file-open' }] : []),
                ...(selected.is_file ? [{ label: t('files.download'), onPress: () => void download(selected), testID: 'file-download' }] : []),
                { label: t('files.rename'), onPress: () => (setTarget(selected), setName(selected.name), setDialog('rename')), testID: 'file-rename' },
                { label: t('files.delete'), danger: true, onPress: () => (setTarget(selected), setDialog('delete')), testID: 'file-delete' },
              ]
            : []
        }
      />
      <ConfirmDialog
        visible={dialog === 'rename' || dialog === 'folder'}
        title={dialog === 'folder' ? t('files.newFolder') : t('files.renameTitle', { name: target?.name ?? '' })}
        body={dialog === 'folder' ? t('files.newFolderBody', { dir }) : t('files.renameBody')}
        confirmLabel={dialog === 'folder' ? t('common.create') : t('files.rename')}
        danger={false}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (!client || !s || name.trim() === '') return;
          if (dialog === 'folder') void act(() => client.createFolder(s, dir, name.trim()));
          else if (target) void act(() => client.rename(s, dir, target.name, name.trim()));
        }}
      >
        <Field label={t('files.name')} value={name} onChangeText={setName} testID="files-name" />
      </ConfirmDialog>
      <ConfirmDialog
        visible={dialog === 'delete'}
        title={t('files.deleteTitle', { name: target?.name ?? '' })}
        body={target?.is_file ? t('files.deleteBody') : t('files.deleteFolderBody')}
        confirmLabel={t('files.delete')}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (client && s && target) void act(() => client.deleteFiles(s, dir, [target.name]));
        }}
      />
    </Screen>
  );
}

export function FileScreen({ id, path }: { id: string; path: string }) {
  const { t, client } = useApp();
  const nav = useNav();
  const server = useServer(id);
  const s = server.data;
  // Loaded fresh every time (no cache), so the editor never starts from an old copy.
  const [original, setOriginal] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<PanelError>();
  const [round, setRound] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!client || !s) return undefined;
    let cancelled = false;
    setLoadError(undefined);
    client
      .fileContents(s, path)
      .then((value) => {
        if (cancelled) return;
        setOriginal(value);
        setText((current) => current ?? value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(asPanelError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [client, s, path, round]);

  const contents = { data: original, error: loadError, reload: () => setRound((n) => n + 1) };

  const dirty = text !== null && contents.data !== undefined && text !== contents.data;

  const save = async () => {
    if (!client || !s || text === null) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await client.writeFile(s, path, text);
      setSaved(true);
      contents.reload();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={path.split('/').pop() ?? path} onBack={nav.pop} testID="screen-file">
      <T variant="caption">{path}</T>
      {contents.error ? <ErrorPanel error={contents.error} onRetry={contents.reload} /> : null}
      {text === null && !contents.error ? <Loading /> : null}
      {text !== null ? <Field label={t('files.contents')} value={text} onChangeText={(next) => (setText(next), setSaved(false))} multiline testID="file-text" /> : null}
      {error ? <ErrorPanel error={error} /> : null}
      {saved && !dirty ? <Notice tone="success" testID="file-saved">{t('files.saved')}</Notice> : null}
      <Button label={t('common.save')} onPress={() => void save()} busy={busy} disabled={!dirty} testID="file-save" />
    </Screen>
  );
}
