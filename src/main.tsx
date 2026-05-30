import React from 'react';
import ReactDOM from 'react-dom/client';
import { AlertTriangle, BookOpen, Clock, ExternalLink, Loader2, Search, Trash2 } from 'lucide-react';
import './styles.css';

type StoryResult = {
  personName: string;
  storyTitle: string;
  quoteExcerpt: string;
  sourceTitle: string;
  sourceUrl: string;
  confidence: number;
};

type MatchResponse = {
  story: StoryResult;
  crisisDetected: boolean;
  requestId?: string;
};

type ApiErrorCode = 'CONFIG_MISSING' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT' | 'NO_RELIABLE_SOURCE' | 'BAD_REQUEST';

type ApiErrorResponse = {
  error?: string;
  code?: ApiErrorCode;
  requestId?: string;
  crisisDetected?: boolean;
};

type HistoryItem = {
  id: string;
  concernPreview: string;
  createdAt: string;
  story: StoryResult;
};

const HISTORY_KEY = 'resonant-stories-history';
const EXAMPLE_TEXT = '最近我觉得自己很努力却一直没有进展，看到别人都往前走，我开始怀疑是不是自己根本不适合现在做的事。';
const MATCH_TIMEOUT_MS = 35000;

function App() {
  const [concern, setConcern] = React.useState('');
  const [result, setResult] = React.useState<StoryResult | null>(null);
  const [history, setHistory] = React.useState<HistoryItem[]>(() => readHistory());
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [crisisDetected, setCrisisDetected] = React.useState(false);

  async function submitConcern(event: React.FormEvent) {
    event.preventDefault();
    if (loading) {
      return;
    }

    const trimmed = concern.trim();
    if (trimmed.length < 12) {
      setError('请多写一点你的处境，至少 12 个字。');
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);
    setCrisisDetected(false);

    try {
      const data = await requestMatchStory({
        concern: trimmed,
        recentPeople: history.map((item) => item.story.personName).slice(0, 8)
      });

      setResult(data.story);
      setCrisisDetected(data.crisisDetected);
      const nextHistory = [
        {
          id: crypto.randomUUID(),
          concernPreview: trimmed.slice(0, 80),
          createdAt: new Date().toISOString(),
          story: data.story
        },
        ...history
      ].slice(0, 12);
      setHistory(nextHistory);
      writeHistory(nextHistory);
    } catch (caught) {
      if (caught instanceof MatchRequestError) {
        setCrisisDetected(caught.crisisDetected);
      }
      setError(caught instanceof Error ? caught.message : '服务暂时不可用，请稍后再试。');
    } finally {
      setLoading(false);
    }
  }

  function deleteHistory(id: string) {
    const nextHistory = history.filter((item) => item.id !== id);
    setHistory(nextHistory);
    writeHistory(nextHistory);
  }

  function clearHistory() {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  }

  return (
    <main className="shell">
      <section className="intro">
        <div>
          <p className="eyebrow">真实来源 · 克制匹配 · 本地历史</p>
          <h1>看看谁也曾在相似的地方停住过</h1>
          <p className="lead">
            写下最近困住你的事。应用会联网检索公众人物的公开材料，只展示可核验的原文摘录和来源。
          </p>
        </div>
      </section>

      <section className="workspace">
        <form className="composer" onSubmit={submitConcern}>
          <div className="composerHeader">
            <label htmlFor="concern">你的烦闷心事</label>
            <button type="button" className="textButton" onClick={() => setConcern(EXAMPLE_TEXT)}>
              填入示例
            </button>
          </div>
          <textarea
            id="concern"
            value={concern}
            onChange={(event) => setConcern(event.target.value)}
            placeholder="比如：努力很久没有结果、关系里感到被误解、创作卡住、事业低谷、对未来没有把握……"
            maxLength={2000}
          />
          <div className="formFooter">
            <span>{concern.length}/2000</span>
            <button className="primaryButton" type="submit" disabled={loading}>
              {loading ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
              {loading ? '正在寻找' : '匹配故事'}
            </button>
          </div>
        </form>

        <div className="resultPane" aria-live="polite">
          {crisisDetected && <CrisisNotice />}
          {error && (
            <div className="notice error">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          )}
          {loading && (
            <div className="emptyState">
              <Loader2 className="spin" size={26} />
              <p>正在检索公开资料，并核对原文出处。</p>
            </div>
          )}
          {!loading && !result && !error && (
            <div className="emptyState">
              <BookOpen size={28} />
              <p>结果会显示在这里，包括人物、原文摘录和引用来源。</p>
            </div>
          )}
          {result && <StoryCard story={result} />}
        </div>
      </section>

      <section className="historySection">
        <div className="sectionHeader">
          <h2>本地历史</h2>
          {history.length > 0 && (
            <button className="iconTextButton" type="button" onClick={clearHistory}>
              <Trash2 size={16} />
              清空
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="muted">历史只保存在这台设备的浏览器里。</p>
        ) : (
          <div className="historyGrid">
            {history.map((item) => (
              <article className="historyCard" key={item.id}>
                <div className="historyTop">
                  <span><Clock size={14} /> {formatDate(item.createdAt)}</span>
                  <button aria-label="删除历史" className="iconButton" onClick={() => deleteHistory(item.id)} type="button">
                    <Trash2 size={15} />
                  </button>
                </div>
                <p className="historyConcern">{item.concernPreview}</p>
                <strong>{item.story.personName}</strong>
                <a href={item.story.sourceUrl} target="_blank" rel="noreferrer">
                  {item.story.sourceTitle}
                  <ExternalLink size={14} />
                </a>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function StoryCard({ story }: { story: StoryResult }) {
  return (
    <article className="storyCard">
      <div className="storyMeta">
        <span>匹配人物</span>
        <strong>{story.personName}</strong>
      </div>
      <h2>{story.storyTitle}</h2>
      <p className="reason">原文摘录</p>
      <blockquote>{story.quoteExcerpt}</blockquote>
      <div className="sourceRow">
        <span>可信度 {Math.round(story.confidence * 100)}%</span>
        <a href={story.sourceUrl} target="_blank" rel="noreferrer">
          查看来源：{story.sourceTitle}
          <ExternalLink size={16} />
        </a>
      </div>
    </article>
  );
}

function CrisisNotice() {
  return (
    <div className="notice crisis">
      <AlertTriangle size={18} />
      <span>
        如果你正在考虑伤害自己或已经处在危险中，请立刻联系身边可信任的人或当地紧急服务。这个应用不能替代专业帮助。
      </span>
    </div>
  );
}

function readHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) as HistoryItem[] : [];
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

class MatchRequestError extends Error {
  readonly crisisDetected: boolean;

  constructor(message: string, crisisDetected = false) {
    super(message);
    this.name = 'MatchRequestError';
    this.crisisDetected = crisisDetected;
  }
}

async function requestMatchStory(body: { concern: string; recentPeople: string[] }): Promise<MatchResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), MATCH_TIMEOUT_MS);

  try {
    const response = await fetch('/api/match-story', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await parseApiPayload(response);

    if (!response.ok) {
      throw new MatchRequestError(getFriendlyErrorMessage(response.status, payload), Boolean(payload.crisisDetected));
    }

    if (!isMatchResponse(payload)) {
      throw new MatchRequestError('服务返回格式异常，请稍后再试。');
    }

    return payload;
  } catch (caught) {
    if (caught instanceof MatchRequestError) {
      throw caught;
    }
    if (caught instanceof DOMException && caught.name === 'AbortError') {
      throw new MatchRequestError('这次匹配耗时过久，请稍后再试。');
    }
    throw new MatchRequestError('服务连接中断，请稍后再试。');
  } finally {
    window.clearTimeout(timeout);
  }
}

async function parseApiPayload(response: Response): Promise<ApiErrorResponse | MatchResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await response.json() as ApiErrorResponse | MatchResponse;
  }

  const text = await response.text();
  return {
    error: text.trim().slice(0, 180)
  };
}

function isMatchResponse(value: ApiErrorResponse | MatchResponse): value is MatchResponse {
  return typeof (value as MatchResponse).story === 'object'
    && (value as MatchResponse).story !== null
    && typeof (value as MatchResponse).crisisDetected === 'boolean';
}

function getFriendlyErrorMessage(status: number, payload: ApiErrorResponse) {
  if (payload.code === 'CONFIG_MISSING') {
    return payload.error ?? '服务缺少必要配置，请检查部署环境变量。';
  }
  if (payload.code === 'UPSTREAM_TIMEOUT' || status === 504) {
    return payload.error ?? '外部服务响应超时，请稍后再试。';
  }
  if (payload.code === 'UPSTREAM_ERROR' || status === 502) {
    return payload.error ?? '外部服务暂时不可用，请稍后再试。';
  }
  if (payload.code === 'NO_RELIABLE_SOURCE' || status === 424) {
    return payload.error ?? '暂时没有找到足够可靠的原文材料。';
  }
  if (payload.code === 'BAD_REQUEST' || status === 400) {
    return payload.error ?? '输入内容无效，请调整后再试。';
  }
  return payload.error || '服务暂时不可用，请稍后再试。';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
