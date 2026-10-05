import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SourceInput,
  type SourceSummary,
  type SourceMetadata,
  type Citation,
  type SourceDetail,
  type SourceImportResult,
} from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, Heading, navigate, QueryState, Result, CourseSelect, SourceCatalogPages } from './ui';
import { courseName, isExtracted, matchesCourse, matchesCitationCourse, sourceFormat } from './source-meta';
import s from './styles.module.css';
import { Icon } from './icons';

import { MemoryEditor, scopeNames, type Memory } from './memory-editor';
import { SourceEditor } from './source-editor';
export function LibraryPage() {
  const [archived, setArchived] = useState(false);
  const query = useData<SourceSummary[]>('/sources' + (archived ? '?archived=true' : '')),
    api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [adding, setAdding] = useState(false),
    [tab, setTab] = useState<'sources' | 'memories'>('sources');
  const [duplicate, setDuplicate] = useState<SourceImportResult | null>(null);
  const [draft, setDraft] = useDraft('source', { title: '', content: '' });
  const sourceDraft = useRef(draft);
  sourceDraft.current = draft;
  const [search, setSearch] = useState(''),
    [submitted, setSubmitted] = useState<string | null>(null),
    [course, setCourse] = useState(''),
    [titleSearch, setTitleSearch] = useState(''),
    [page, setPage] = useState(0);
  const titleQuery = useDeferredValue(titleSearch.trim().toLocaleLowerCase());
  const searchQuery = useQuery({
    queryKey: ['/search', submitted, course],
    enabled: submitted !== null,
    queryFn: ({ signal }) =>
      api.get<Citation[]>(
        '/search?q=' + encodeURIComponent(submitted || '') + (course ? '&course=' + encodeURIComponent(course) : ''),
        signal,
      ),
    retry: 1,
  });
  const visible = useMemo(
    () =>
      (query.data || []).filter(
        (source) =>
          matchesCourse(source, course) && (!titleQuery || source.title.toLocaleLowerCase().includes(titleQuery)),
      ),
    [query.data, course, titleQuery],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / 30) - 1)),
    current = visible.slice(currentPage * 30, currentPage * 30 + 30);
  useEffect(() => {
    setPage(currentPage);
  }, [currentPage]);
  const results = (searchQuery.data || []).filter((hit) => matchesCitationCourse(hit, course));
  const save = (allowDuplicate = false) => {
    const sent = draft;
    void action.run(
      () => api.write<SourceImportResult>('/sources', SourceInput.parse({ ...sent, allowDuplicate })),
      (result) => {
        const unchanged = sourceDraft.current.title === sent.title && sourceDraft.current.content === sent.content;
        if (result.duplicate) {
          if (unchanged) setDuplicate(result);
          else action.setMessage('上一份内容已存在，你继续输入的文字仍保留。');
        } else if (unchanged) {
          setDraft({ title: '', content: '' });
          setAdding(false);
          navigate('/source/' + result.id);
        } else action.setMessage('上一份内容已保存，保留了你继续输入的文字。');
        void client.invalidateQueries();
      },
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save();
  };
  const changeDraft = (value: typeof draft) => {
    setDuplicate(null);
    setDraft(value);
  };
  const find = (event: FormEvent) => {
    event.preventDefault();
    const value = search.trim();
    if (!value) return;
    if (value === submitted) void searchQuery.refetch();
    else setSubmitted(value);
  };
  const readFile = (file: File | undefined) => {
    if (!file) return;
    const before = sourceDraft.current;
    void action.run(
      async () => {
        if (!/\.(md|txt)$/i.test(file.name)) throw new Error('请选择 Markdown 或文本文件。');
        if (file.size > 2_000_000) throw new Error('文件超过 2 MB，请拆分后添加。');
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        } catch {
          throw new Error('文件无法按 UTF-8 读取，请另存为 UTF-8 文本后重试。');
        }
      },
      (content) => {
        if (sourceDraft.current !== before) {
          action.setError(new Error('读取期间内容已修改，保留了你的输入；需要替换时请重新选择文件。'));
          return;
        }
        changeDraft({ title: file.name.slice(0, 200), content });
      },
    );
  };
  return (
    <>
      <Heading
        title="资料"
        action={
          tab === 'sources' ? (
            <button className={s.primary} onClick={() => setAdding(!adding)}>
              添加资料
            </button>
          ) : undefined
        }
      >
        把讲义、笔记和学习偏好整理在这里。
      </Heading>
      <div
        className={s.tabs}
        role="tablist"
        aria-label="资料分类"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'sources'
              : event.key === 'End'
                ? 'memories'
                : tab === 'sources'
                  ? 'memories'
                  : 'sources';
          setTab(next);
          document.getElementById('tab-' + next)?.focus();
        }}
      >
        <button
          className={tab === 'sources' ? s.selectedTab : s.tab}
          id="tab-sources"
          role="tab"
          aria-controls="library-panel"
          tabIndex={tab === 'sources' ? 0 : -1}
          aria-selected={tab === 'sources'}
          onClick={() => setTab('sources')}
        >
          学习材料
        </button>
        <button
          className={tab === 'memories' ? s.selectedTab : s.tab}
          id="tab-memories"
          role="tab"
          aria-controls="library-panel"
          tabIndex={tab === 'memories' ? 0 : -1}
          aria-selected={tab === 'memories'}
          onClick={() => setTab('memories')}
        >
          记忆与偏好
        </button>
      </div>
      <div id="library-panel" role="tabpanel" aria-labelledby={'tab-' + tab}>
        {tab === 'memories' ? (
          <Memories />
        ) : (
          <>
            {adding && (
              <form className={s.form} onSubmit={submit}>
                <label>
                  选择文件
                  <input
                    type="file"
                    accept=".md,.txt,text/markdown,text/plain"
                    onChange={(event) => readFile(event.target.files?.[0])}
                  />
                </label>
                <label>
                  标题
                  <input
                    value={draft.title}
                    maxLength={200}
                    required
                    onChange={(event) => changeDraft({ ...draft, title: event.target.value })}
                  />
                </label>
                <label>
                  原文
                  <textarea
                    value={draft.content}
                    rows={9}
                    required
                    maxLength={2000000}
                    onChange={(event) => changeDraft({ ...draft, content: event.target.value })}
                  />
                </label>
                <p className={s.muted}>支持 Markdown 和文本，最多 2 MB。只添加你希望助手使用的材料。</p>
                <button className={s.primary} disabled={action.busy || !draft.title.trim() || !draft.content}>
                  {action.busy ? '正在添加…' : '保存资料'}
                </button>
                {duplicate && (
                  <div className={s.notice} role="status">
                    <p>
                      已有相同正文的资料{duplicate.archivedAt ? '，目前已归档' : ''}。可查看原资料，或保留独立副本。
                    </p>
                    <div className={s.toolbar}>
                      <a className={s.secondary} href={'#/source/' + encodeURIComponent(duplicate.id)}>
                        查看已有资料
                      </a>
                      <button type="button" className={s.textButton} disabled={action.busy} onClick={() => save(true)}>
                        仍保存副本
                      </button>
                    </div>
                  </div>
                )}
              </form>
            )}
            <div className={s.libraryTools}>
              <label>
                资料范围
                <select
                  value={String(archived)}
                  onChange={(event) => {
                    setArchived(event.target.value === 'true');
                    setSubmitted(null);
                    setSearch('');
                    setPage(0);
                  }}
                >
                  <option value="false">使用中</option>
                  <option value="true">已归档</option>
                </select>
              </label>
              <CourseSelect
                sources={query.data || []}
                value={course}
                onChange={(next) => {
                  setCourse(next);
                  setPage(0);
                }}
                label="筛选课程"
              />
              <label>
                按标题查找
                <input
                  type="search"
                  value={titleSearch}
                  maxLength={200}
                  onChange={(event) => {
                    setTitleSearch(event.target.value);
                    setPage(0);
                  }}
                  placeholder="输入资料标题"
                />
              </label>
            </div>
            <ErrorNotice error={action.error} />
            {action.message && (
              <p role="status" className={s.muted}>
                {action.message}
              </p>
            )}
            <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
            {visible.length ? (
              <div className={`${s.rows} ${s.sourceRows}`}>
                {current.map((source) => (
                  <a className={s.row} key={source.id} href={'#/source/' + encodeURIComponent(source.id)}>
                    <span className={s.sourceIcon}>
                      <Icon name="library" />
                    </span>
                    <div>
                      <strong>{source.title}</strong>
                      <p>
                        {courseName(source.metadata)} · {sourceFormat(source.metadata)} · 第 {source.version} 版
                      </p>
                      <span className={s.sourceMeta}>更新于 {date(source.updatedAt)}</span>
                    </div>
                    <span className={s.muted}>
                      {archived ? '已归档' : isExtracted(source.metadata) ? '提取文本' : '原始资料'}
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              query.data && (
                <p className={s.empty}>
                  {titleQuery || course
                    ? '没有符合条件的资料。'
                    : archived
                      ? '没有归档资料。'
                      : '添加一份讲义或笔记，学习回答就能引用你的材料。'}
                </p>
              )
            )}
            {query.data && (
              <SourceCatalogPages page={currentPage} total={visible.length} onChange={setPage} label="资料库分页" />
            )}
            {!archived && (
              <details className={s.disclosure}>
                <summary>检索正文片段</summary>
                <p className={s.muted}>在使用中的资料正文查找关键词，结果包含原文位置。课程筛选同时生效。</p>
                <form className={s.search} onSubmit={find}>
                  <label className={s.srOnly} htmlFor="body-search">
                    正文关键词
                  </label>
                  <input
                    id="body-search"
                    type="search"
                    value={search}
                    maxLength={2000}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      if (!event.target.value) setSubmitted(null);
                    }}
                    placeholder="输入正文关键词"
                  />
                  <button className={s.secondary} disabled={!search.trim()}>
                    检索正文
                  </button>
                </form>
                {submitted !== null && (
                  <section className={s.section} aria-label="正文片段结果">
                    <div className={s.sectionHeading}>
                      <h2>正文片段</h2>
                      <button
                        type="button"
                        className={s.textButton}
                        onClick={() => {
                          setSubmitted(null);
                          setSearch('');
                        }}
                      >
                        清除检索
                      </button>
                    </div>
                    <QueryState
                      pending={searchQuery.isPending}
                      error={searchQuery.error}
                      retry={() => void searchQuery.refetch()}
                    />
                    {results.map((hit, index) => (
                      <article className={s.searchResult} key={hit.sourceId + ':' + index}>
                        <a href={'#/source/' + encodeURIComponent(hit.sourceId) + '?version=' + hit.version}>
                          {hit.title}
                        </a>
                        <p>{hit.quote}</p>
                        <span className={s.muted}>
                          {hit.courseName || hit.course || '未分类'} ·{' '}
                          {hit.location || `字符 ${hit.start + 1}–${hit.end}`} · 第 {hit.version} 版
                        </span>
                      </article>
                    ))}
                    {!searchQuery.isPending && !searchQuery.error && !results.length && (
                      <p className={s.empty}>没有找到。试试更短的关键词或其他课程。</p>
                    )}
                  </section>
                )}
              </details>
            )}
          </>
        )}
      </div>
    </>
  );
}

function SourceOrigin({ metadata }: { metadata: SourceMetadata }) {
  const numbers = [...new Set(metadata.pages.map((page) => page.number))].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < numbers.length; index++) {
    const first = numbers[index]!;
    let last = first;
    while (index + 1 < numbers.length && numbers[index + 1] === last + 1) {
      index++;
      last = numbers[index]!;
    }
    ranges.push(first === last ? String(first) : `${first}–${last}`);
  }
  return (
    <details className={s.disclosure}>
      <summary>来源与提取说明{metadata.warnings.length ? `（${metadata.warnings.length} 项提示）` : ''}</summary>
      <dl className={s.metadata}>
        <div>
          <dt>原文件</dt>
          <dd className={s.prewrap}>{metadata.originPath}</dd>
        </div>
        <div>
          <dt>来源格式</dt>
          <dd>{sourceFormat(metadata)}</dd>
        </div>
        <div>
          <dt>提取方式</dt>
          <dd className={s.prewrap}>{metadata.extraction}</dd>
        </div>
        {numbers.length > 0 && (
          <div>
            <dt>{/^pptx?$/i.test(metadata.format) ? '幻灯片' : '页码'}</dt>
            <dd>{ranges.join('、')}（沿用原文件页序）</dd>
          </div>
        )}
      </dl>
      {isExtracted(metadata) && <p className={s.muted}>当前展示原文件的文字提取结果。图片、公式与版式请核对原文件。</p>}
      {metadata.warnings.length > 0 && (
        <ul className={s.sourceWarnings}>
          {metadata.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
export function SourcePage({ id, version }: { id: string; version?: string }) {
  const query = useData<SourceDetail>(
    '/sources/' + encodeURIComponent(id) + (version ? '?version=' + encodeURIComponent(version) : ''),
  );
  const api = useApi(),
    action = useAction(),
    client = useQueryClient(),
    [editing, setEditing] = useState(false);
  const archive = () => {
    const source = query.data;
    if (!source) return;
    void action.run(
      () =>
        api.write(
          '/sources/' + encodeURIComponent(id) + '/archive',
          { revision: source.revision, archived: !source.archivedAt },
          'PATCH',
        ),
      () => {
        void client.invalidateQueries();
      },
    );
  };
  const download = () => {
    const source = query.data;
    if (!source?.metadata?.assetKey) return;
    void action.run(
      () => api.downloadBlob('/sources/' + encodeURIComponent(id) + '/original?version=' + source.version),
      (blob) => {
        const url = URL.createObjectURL(blob),
          anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = source.metadata!.originPath.replace(/\\/g, '/').split('/').at(-1) || source.title;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    );
  };
  return (
    <>
      <a className={s.back} href="#/library">
        ‹ 全部资料
      </a>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <>
          <Heading
            title={query.data.title}
            action={
              query.data.metadata?.assetKey ? (
                <button className={s.secondary} disabled={action.busy} onClick={download}>
                  {action.busy ? '正在下载…' : '下载原文件'}
                </button>
              ) : undefined
            }
          >
            {query.data.metadata && (
              <>
                {courseName(query.data.metadata)} · {sourceFormat(query.data.metadata)} ·{' '}
              </>
            )}
            {isExtracted(query.data.metadata) ? '提取文本' : '原始资料'} · 第 {query.data.version} 版
            {query.data.version !== query.data.current_version && (
              <>
                {' '}
                · <a href={'#/source/' + encodeURIComponent(id)}>查看最新版</a>
              </>
            )}
          </Heading>
          <ErrorNotice
            error={action.error}
            onReload={() => {
              action.setError(null);
              void query.refetch();
            }}
          />
          {query.data.archivedAt && (
            <p className={s.notice}>已归档，不参与新检索。历史引用与已出题的资料依据继续保留。</p>
          )}
          <div className={s.toolbar}>
            {query.data.version === query.data.current_version && !query.data.archivedAt && (
              <button className={s.secondary} disabled={action.busy} onClick={() => setEditing(!editing)}>
                {editing ? '收起编辑' : '编辑资料'}
              </button>
            )}
            <button className={s.textButton} disabled={action.busy} onClick={archive}>
              {query.data.archivedAt ? '恢复使用' : '归档资料'}
            </button>
            <span className={s.muted}>归档后可恢复，原文不会删除。</span>
          </div>
          {editing && !query.data.archivedAt && query.data.version === query.data.current_version && (
            <SourceEditor source={query.data} done={() => setEditing(false)} />
          )}
          {query.data.versions?.length > 1 && (
            <details className={s.disclosure}>
              <summary>版本历史（{query.data.versions.length}）</summary>
              <div className={s.rows}>
                {query.data.versions.map((item) => (
                  <a
                    className={s.row}
                    key={item.version}
                    href={'#/source/' + encodeURIComponent(id) + '?version=' + item.version}
                  >
                    <span>
                      第 {item.version} 版 · {item.title}
                    </span>
                    <span className={s.muted}>{date(item.createdAt)}</span>
                  </a>
                ))}
              </div>
            </details>
          )}
          {query.data.metadata && <SourceOrigin metadata={query.data.metadata} />}
          <Result>{query.data.content}</Result>
          <details className={s.disclosure}>
            <summary>{isExtracted(query.data.metadata) ? '提取文本原文' : '原文'}</summary>
            <pre className={s.raw}>{query.data.content}</pre>
          </details>
        </>
      )}
    </>
  );
}
function Memories() {
  const query = useData<Memory[]>('/memories'),
    [editing, setEditing] = useState<Memory | null | undefined>(undefined);
  return (
    <>
      <div className={s.sectionHeading}>
        <p className={s.muted}>你可以修改或停用。未确认的信息会单独标明。</p>
        <button className={s.secondary} onClick={() => setEditing(null)}>
          添加偏好
        </button>
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {editing !== undefined && (
        <MemoryEditor key={editing?.key || 'new'} memory={editing} done={() => setEditing(undefined)} />
      )}
      <div className={s.rows}>
        {query.data?.map((memory) => (
          <div className={s.row} key={memory.key}>
            <div>
              <strong>
                {scopeNames[memory.scope] || memory.scope}
                {!memory.enabled ? ' · 已停用' : ''}
                {!memory.confirmed ? ' · 待本人确认' : ''}
              </strong>
              <p className={s.prewrap}>{memory.content}</p>
            </div>
            <button className={s.textButton} onClick={() => setEditing(memory)}>
              修改
            </button>
          </div>
        ))}
      </div>
      {query.data?.length === 0 && <p className={s.empty}>例如：每天学习 20 分钟，先提问，再给解释。</p>}
    </>
  );
}
