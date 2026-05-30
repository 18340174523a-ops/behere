import 'dotenv/config';
import express from 'express';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 8787);
const TAVILY_URL = 'https://api.tavily.com/search';

const MatchRequestSchema = z.object({
  concern: z.string().trim().min(12, '请多写一点你的处境，至少 12 个字。').max(2000, '内容过长，请控制在 2000 字以内。'),
  recentPeople: z.array(z.string().trim().min(1).max(80)).max(12).optional().default([])
});

const StoryResultSchema = z.object({
  sourceId: z.number().int().positive().optional(),
  personName: z.string().min(1),
  storyTitle: z.string().min(1),
  quoteExcerpt: z.string().min(1).max(240),
  sourceTitle: z.string().optional().default(''),
  sourceUrl: z.string().optional().default(''),
  confidence: z.number().min(0).max(1)
});

const SearchAnalysisSchema = z.object({
  userState: z.string().min(1),
  supportNeed: z.string().min(1),
  caseType: z.string().min(1),
  primaryQuery: z.string().min(1),
  fallbackQueries: z.array(z.string().min(1)).min(1).max(4),
  famousCandidates: z.array(z.string().min(1)).min(1).max(8)
});

const CandidateEvaluationSchema = z.object({
  sourceId: z.number().int().positive(),
  personName: z.string().min(1),
  situationSummary: z.string().min(1),
  matchedNeed: z.string().min(1),
  mismatchReason: z.string().optional().default(''),
  matchScore: z.number().min(0).max(1),
  isUsable: z.boolean()
});

const CandidateEvaluationsSchema = z.object({
  evaluations: z.array(CandidateEvaluationSchema).min(1)
});

type SearchAnalysis = z.infer<typeof SearchAnalysisSchema>;
type CandidateEvaluation = z.infer<typeof CandidateEvaluationSchema>;

type SearchResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: unknown;
  score?: number;
  query?: string;
  channel?: 'semantic' | 'famous' | 'fallback';
  evaluation?: CandidateEvaluation;
};

type AiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

const crisisPattern = /(自杀|轻生|不想活|结束生命|伤害自己|自残|活不下去|suicide|kill myself|self-harm)/i;
const reliableMinimum = 2;

const famousSeedLibrary: Record<string, string[]> = {
  job_rejection: ['J.K. Rowling', 'Steve Jobs', 'Oprah Winfrey', 'Walt Disney', 'Abraham Lincoln', '俞敏洪', '马云', '李安'],
  creative_block: ['Vincent van Gogh', 'Ernest Hemingway', 'Haruki Murakami', 'Stephen King', '李安', '余华', '苏轼', '贝多芬'],
  career_failure: ['Steve Jobs', 'Elon Musk', 'Winston Churchill', 'Abraham Lincoln', '任正非', '马云', '张艺谋', '郎平'],
  self_doubt: ['Albert Einstein', 'Charles Darwin', 'Marie Curie', 'Abraham Lincoln', '林肯', '苏轼', '钱钟书', '莫言'],
  relationship_setback: ['Maya Angelou', 'Frida Kahlo', 'Virginia Woolf', 'Audrey Hepburn', '张爱玲', '杨绛', '林徽因', '三毛'],
  general_low_point: ['Nelson Mandela', 'Helen Keller', 'Maya Angelou', 'J.K. Rowling', '史铁生', '苏轼', '王阳明', '俞敏洪']
};

const qualityDomains = [
  'biography.com',
  'britannica.com',
  'achievement.org',
  'nobelprize.org',
  'theparisreview.org',
  'pbs.org',
  'stanford.edu',
  'harvard.edu',
  'mit.edu',
  'people.com.cn',
  'xinhuanet.com',
  'cctv.com',
  'thepaper.cn'
];

const lowQualityDomainHints = ['zhidao', 'baike.baidu', 'douban.com/group', 'tieba', 'reddit.com', 'quora.com', 'pinterest', 'brainyquote'];

const app = express();
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/match-story', async (req, res) => {
  const parsed = MatchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '输入内容无效。' });
    return;
  }

  const concern = parsed.data.concern;
  const recentPeople = parsed.data.recentPeople;
  const crisisDetected = crisisPattern.test(concern);

  try {
    assertEnv();
    const analysis = await analyzeConcernForSearch(concern);
    const searchResults = await searchPublicStories(concern, analysis);
    const rankedResults = rankSearchResults(searchResults, analysis, recentPeople).slice(0, 16);
    const reliableResults = await evaluateCandidatesWithAi(concern, analysis, rankedResults);

    if (reliableResults.length < reliableMinimum) {
      res.status(424).json({
        error: '暂时没有找到足够可靠的原文材料。',
        crisisDetected
      });
      return;
    }

    const story = await findVerifiedQuote(concern, reliableResults, analysis);

    if (!story) {
      res.status(424).json({
        error: '暂时没有找到足够可靠的原文材料。',
        crisisDetected
      });
      return;
    }

    res.json({ story, crisisDetected });
  } catch (error) {
    const message = getPublicErrorMessage(error);
    const status = message.includes('环境变量') ? 500 : 502;
    res.status(status).json({ error: message, crisisDetected });
  }
});

app.listen(PORT, () => {
  console.log(`Story matcher API listening on http://localhost:${PORT}`);
});

function assertEnv() {
  const missing = ['TAVILY_API_KEY', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join(', ')}。请参考 .env.example 配置。`);
  }
}

async function analyzeConcernForSearch(concern: string): Promise<SearchAnalysis> {
  const fallback = buildFallbackAnalysis(concern);
  const prompt = `
请分析用户输入，并为 Tavily 搜索生成高质量查询。用户输入：
${concern}

要求：
1. 分析用户当前状态、主要需求，以及更需要激励、安慰、被理解还是看见类似经历。
2. caseType 用英文短标签，例如 job_rejection、creative_block、career_failure、self_doubt、relationship_setback、general_low_point。
3. primaryQuery 要适合搜索真实公众人物材料，包含 采访/传记/原文/quote/interview/biography 等能提高原文命中率的词。
4. fallbackQueries 给 2-4 条放宽查询，至少一条英文查询。
5. famousCandidates 给 4-8 个可能相关的知名公众人物，跨领域，不要只给商业人物。
6. 只返回 JSON，字段为 userState、supportNeed、caseType、primaryQuery、fallbackQueries、famousCandidates。
`;

  try {
    const json = await callJsonAi([
      {
        role: 'system',
        content: '你是搜索策略分析助手，输出必须是严格 JSON，不要输出 Markdown。'
      },
      { role: 'user', content: prompt }
    ], 0.2);
    const parsed = SearchAnalysisSchema.safeParse(json);
    return parsed.success ? mergeAnalysisWithSeeds(parsed.data) : fallback;
  } catch {
    return fallback;
  }
}

async function searchPublicStories(concern: string, analysis: SearchAnalysis): Promise<SearchResult[]> {
  const rounds = buildSearchRounds(concern, analysis);
  const collected = new Map<string, SearchResult>();

  for (const round of rounds) {
    const responses = await Promise.all(round.map((request) => tavilySearch(request.query, request.channel)));
    for (const result of responses.flat()) {
      if (!result.url) continue;
      const key = normalizeUrl(result.url);
      const existing = collected.get(key);
      if (!existing || getSourceText(result).length > getSourceText(existing).length) {
        collected.set(key, result);
      }
    }

    const reliableCount = Array.from(collected.values()).filter((item) => isReliableSourceCandidate(item)).length;
    if (reliableCount >= 6) {
      break;
    }
  }

  return Array.from(collected.values());
}

async function tavilySearch(query: string, channel: SearchResult['channel']): Promise<SearchResult[]> {
  const response = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: true,
      chunks_per_source: 3,
      max_results: 20,
      topic: 'general'
    })
  });

  if (!response.ok) {
    throw new Error(`搜索服务返回异常：${response.status}`);
  }

  const payload = await response.json() as { results?: SearchResult[] };
  return (payload.results ?? []).map((result) => ({ ...result, query, channel }));
}

function buildFallbackAnalysis(concern: string): SearchAnalysis {
  const caseType = inferCaseType(concern);
  const seeds = getSeedPeople(caseType);
  const topic = getCaseTopic(caseType);

  return {
    userState: '用户正在经历低谷、挫败或自我怀疑。',
    supportNeed: '需要看到公开人物也经历过相似阶段，并从真实原文中获得陪伴感。',
    caseType,
    primaryQuery: `${concern.slice(0, 120)} 公众人物 ${topic} 低谷 采访 原文 传记`,
    fallbackQueries: [
      `知名人物 ${topic} 低谷 采访 原文`,
      `famous person ${topic} setback interview quote biography`,
      `public figure ${topic} failure interview original quote`
    ],
    famousCandidates: seeds.slice(0, 6)
  };
}

function mergeAnalysisWithSeeds(analysis: SearchAnalysis): SearchAnalysis {
  const seeds = getSeedPeople(analysis.caseType);
  const mergedCandidates = uniqueStrings([...analysis.famousCandidates, ...seeds]).slice(0, 8);

  return {
    ...analysis,
    famousCandidates: mergedCandidates.length > 0 ? mergedCandidates : famousSeedLibrary.general_low_point
  };
}

function inferCaseType(concern: string) {
  if (/(找不到工作|工作不要我|面试|简历|失业|求职|offer|被拒)/i.test(concern)) return 'job_rejection';
  if (/(写不出|创作|作品|灵感|卡住|画|小说|剧本|拍摄)/i.test(concern)) return 'creative_block';
  if (/(事业|创业|失败|公司|项目|亏|倒闭|裁员)/i.test(concern)) return 'career_failure';
  if (/(怀疑自己|不适合|没用|自卑|焦虑|迷茫|比较)/i.test(concern)) return 'self_doubt';
  if (/(分手|关系|误解|孤独|朋友|家人|伴侣|爱情)/i.test(concern)) return 'relationship_setback';
  return 'general_low_point';
}

function getCaseTopic(caseType: string) {
  const topics: Record<string, string> = {
    job_rejection: '求职被拒 失业',
    creative_block: '创作瓶颈 失败',
    career_failure: '事业失败 低谷',
    self_doubt: '自我怀疑 挫折',
    relationship_setback: '关系挫折 孤独',
    general_low_point: '人生低谷 挫折'
  };
  return topics[caseType] ?? topics.general_low_point;
}

function getSeedPeople(caseType: string) {
  const direct = famousSeedLibrary[caseType] ?? famousSeedLibrary.general_low_point;
  const crossField = [
    famousSeedLibrary.creative_block[0],
    famousSeedLibrary.career_failure[0],
    famousSeedLibrary.self_doubt[0],
    famousSeedLibrary.general_low_point[4]
  ];
  return uniqueStrings([...rotateByDate(direct), ...crossField]);
}

function buildSearchRounds(concern: string, analysis: SearchAnalysis) {
  const topic = getCaseTopic(analysis.caseType);
  const people = rotateByDate(analysis.famousCandidates).slice(0, 6);
  const famousQueries = people.map((person) => ({
    query: `${person} ${topic} interview quote biography original text 采访 原文 传记`,
    channel: 'famous' as const
  }));

  return [
    [
      { query: analysis.primaryQuery, channel: 'semantic' as const },
      ...famousQueries.slice(0, 3)
    ],
    [
      ...analysis.fallbackQueries.slice(0, 3).map((query) => ({ query, channel: 'fallback' as const })),
      ...famousQueries.slice(3, 6)
    ],
    [
      { query: `${concern.slice(0, 80)} 知名人物 低谷 挫折 采访 原文`, channel: 'fallback' as const },
      { query: `famous public figure ${topic} setback failure interview quote biography`, channel: 'fallback' as const },
      { query: `well known people ${topic} original interview quote`, channel: 'fallback' as const }
    ]
  ];
}

function rankSearchResults(results: SearchResult[], analysis: SearchAnalysis, recentPeople: string[]) {
  const famousNames = uniqueStrings([...analysis.famousCandidates, ...getSeedPeople(analysis.caseType)]);
  return results
    .filter((item) => isReliableSourceCandidate(item))
    .sort((a, b) => scoreSearchResult(b, famousNames, recentPeople) - scoreSearchResult(a, famousNames, recentPeople));
}

async function evaluateCandidatesWithAi(concern: string, analysis: SearchAnalysis, rankedResults: SearchResult[]) {
  const candidates = rankedResults.slice(0, 12);
  if (candidates.length < reliableMinimum) {
    return rankedResults;
  }

  try {
    const prompt = buildCandidateEvaluationPrompt(concern, analysis, candidates);
    const json = await callJsonAi([
      {
        role: 'system',
        content: '你是严谨的检索结果相关性评估助手。你只做后台筛选，不写给用户看的故事。输出必须是严格 JSON。'
      },
      { role: 'user', content: prompt }
    ], 0.1);
    const parsed = CandidateEvaluationsSchema.safeParse(json);
    if (!parsed.success) {
      return rankedResults;
    }

    const reordered = applyCandidateEvaluations(rankedResults, parsed.data.evaluations, 0.55);
    if (reordered.length >= reliableMinimum) {
      return reordered;
    }

    const relaxed = applyCandidateEvaluations(rankedResults, parsed.data.evaluations, 0.45);
    if (relaxed.length >= reliableMinimum) {
      return relaxed;
    }

    return rankedResults.slice(0, 8);
  } catch {
    return rankedResults;
  }
}

function buildCandidateEvaluationPrompt(concern: string, analysis: SearchAnalysis, candidates: SearchResult[]) {
  const compactCandidates = candidates.map((item, index) => ({
    sourceId: index + 1,
    title: item.title,
    url: item.url,
    sourceQuality: getDomain(item.url),
    excerpt: getSourceText(item).slice(0, 1400)
  }));

  return `
用户输入：
${concern}

用户状态分析：
${JSON.stringify({
  userState: analysis.userState,
  supportNeed: analysis.supportNeed,
  caseType: analysis.caseType
}, null, 2)}

候选搜索结果：
${JSON.stringify(compactCandidates, null, 2)}

请逐条评估候选是否真正适合用户。不要为了匹配而牵强解释。
重点判断：
1. 这个来源讲的是谁，以及这个人是否经历了具体低谷、挫折、被拒、失败、自我怀疑或相似困境。
2. 是否和用户当前烦闷点相似，而不是只有关键词相同。
3. 用户需要的是看到真实人物也曾处在类似处境中，不是普通励志语录。
4. 如果内容只是人生简介、名言合集、成功传记摘要、营销号拼贴，降低分数。
5. 奖励困境类型相同、情绪状态相似、有具体事件细节、人物知名且来源可靠的结果。

只返回 JSON，格式：
{
  "evaluations": [
    {
      "sourceId": 1,
      "personName": "人物名",
      "situationSummary": "后台摘要，不给用户展示",
      "matchedNeed": "匹配到的用户需求",
      "mismatchReason": "如果不匹配，说明原因；匹配可为空",
      "matchScore": 0.0,
      "isUsable": true
    }
  ]
}
`;
}

function applyCandidateEvaluations(rankedResults: SearchResult[], evaluations: CandidateEvaluation[], threshold: number) {
  const evaluationByIndex = new Map<number, CandidateEvaluation>();
  for (const evaluation of evaluations) {
    evaluationByIndex.set(evaluation.sourceId - 1, evaluation);
  }

  const evaluated = rankedResults
    .map((result, index) => ({ result, index, evaluation: evaluationByIndex.get(index) }))
    .filter((item) => item.evaluation?.isUsable && item.evaluation.matchScore >= threshold)
    .sort((a, b) => {
      const scoreDelta = (b.evaluation?.matchScore ?? 0) - (a.evaluation?.matchScore ?? 0);
      return scoreDelta !== 0 ? scoreDelta : a.index - b.index;
    })
    .map((item) => ({
      ...item.result,
      score: (item.result.score ?? 0) + (item.evaluation?.matchScore ?? 0),
      evaluation: item.evaluation
    }));

  const evaluatedUrls = new Set(evaluated.map((item) => normalizeUrl(item.url)));
  const leftovers = rankedResults.filter((item) => !evaluatedUrls.has(normalizeUrl(item.url)));
  return [...evaluated, ...leftovers];
}

function isReliableSourceCandidate(item: SearchResult) {
  return Boolean(item.title && item.url && getSourceText(item).length >= 220);
}

function scoreSearchResult(item: SearchResult, famousNames: string[], recentPeople: string[]) {
  const sourceText = getSourceText(item);
  const haystack = `${item.title ?? ''} ${item.url ?? ''} ${sourceText.slice(0, 2000)}`.toLowerCase();
  const domain = getDomain(item.url);
  const matchedFamous = famousNames.some((name) => haystack.includes(name.toLowerCase()));
  const matchedRecent = recentPeople.some((name) => name && haystack.includes(name.toLowerCase()));
  const qualityDomain = qualityDomains.some((hint) => domain.includes(hint));
  const lowQuality = lowQualityDomainHints.some((hint) => domain.includes(hint));
  const rawContentBoost = item.raw_content ? 0.9 : 0;
  const textLengthBoost = Math.min(sourceText.length / 2500, 1.2);
  const channelBoost = item.channel === 'semantic' ? 0.4 : item.channel === 'famous' ? 0.35 : 0.15;
  const nonSeedDiscoveryBoost = !matchedFamous && sourceText.length > 800 && qualityDomain ? 0.45 : 0;

  return (item.score ?? 0)
    + rawContentBoost
    + textLengthBoost
    + channelBoost
    + (matchedFamous ? 0.45 : 0)
    + (qualityDomain ? 0.6 : 0)
    + nonSeedDiscoveryBoost
    - (matchedRecent ? 0.8 : 0)
    - (lowQuality ? 0.7 : 0);
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function rotateByDate<T>(values: T[]) {
  if (values.length === 0) return values;
  const offset = new Date().getDate() % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function getDomain(url?: string) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function buildSourceQuoteFallback(searchResults: SearchResult[], analysis: SearchAnalysis) {
  const famousNames = uniqueStrings([...analysis.famousCandidates, ...getSeedPeople(analysis.caseType)]);

  for (const source of searchResults) {
    const quote = pickOriginalSentence(source, analysis);
    if (!quote || !source.url || !source.title) {
      continue;
    }

    return {
      personName: inferPersonName(source, famousNames),
      storyTitle: source.title,
      quoteExcerpt: wrapChineseQuote(quote),
      sourceTitle: source.title,
      sourceUrl: source.url,
      confidence: Math.max(0.55, Math.min(source.score ?? 0.6, 0.82))
    };
  }

  return null;
}

function pickOriginalSentence(source: SearchResult, analysis: SearchAnalysis) {
  const text = getSourceText(source);
  const sentences = splitCandidateSentences(text);
  const keywords = getQuoteKeywords(analysis.caseType);

  const ranked = sentences
    .filter((sentence) => !isQuoteTooLong(sentence) && sentence.length >= 18)
    .map((sentence) => ({
      sentence,
      score: keywords.reduce((total, keyword) => total + (sentence.toLowerCase().includes(keyword.toLowerCase()) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked.find((item) => item.score > 0)?.sentence ?? ranked[0]?.sentence;
  if (!selected) {
    return null;
  }

  const verified = findOriginalQuote(selected, text);
  return verified;
}

function splitCandidateSentences(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？.!?])\s+|[\n\r]+/)
    .map((sentence) => sentence.trim())
    .flatMap((sentence) => splitLongSentence(sentence))
    .map((sentence) => sentence.replace(/^[\-–—•\s]+/, '').trim())
    .filter(Boolean);
}

function splitLongSentence(sentence: string) {
  if (!isQuoteTooLong(sentence)) {
    return [sentence];
  }

  return sentence
    .split(/[；;，,]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 18 && !isQuoteTooLong(part));
}

function getQuoteKeywords(caseType: string) {
  const shared = ['failure', 'failed', 'rejected', 'struggle', 'difficult', 'hard', 'low', 'setback', '挫折', '失败', '低谷', '困难', '拒绝', '失意'];
  const byType: Record<string, string[]> = {
    job_rejection: ['job', 'work', 'career', 'interview', 'rejection', 'unemployed', '工作', '求职', '面试', '失业'],
    creative_block: ['write', 'book', 'film', 'art', 'creative', '创作', '写作', '作品', '电影'],
    career_failure: ['business', 'company', 'career', 'fired', '创业', '事业', '公司', '裁员'],
    self_doubt: ['doubt', 'confidence', 'afraid', 'anxiety', '怀疑', '焦虑', '自卑', '害怕'],
    relationship_setback: ['alone', 'love', 'relationship', 'lonely', '孤独', '关系', '爱情', '分手'],
    general_low_point: []
  };
  return [...(byType[caseType] ?? []), ...shared];
}

function inferPersonName(source: SearchResult, famousNames: string[]) {
  const haystack = `${source.title ?? ''} ${getSourceText(source).slice(0, 1000)}`;
  const matched = famousNames.find((name) => haystack.toLowerCase().includes(name.toLowerCase()));
  if (matched) {
    return matched;
  }

  const title = source.title ?? '公开人物';
  return title
    .split(/[：:｜|\-–—_]/)[0]
    .replace(/^[\s"'“”]+|[\s"'“”]+$/g, '')
    .slice(0, 40) || '公开人物';
}

async function findVerifiedQuote(concern: string, searchResults: SearchResult[], analysis: SearchAnalysis) {
  let candidates = [...searchResults];

  for (let attempt = 0; attempt < 3 && candidates.length > 0; attempt += 1) {
    const story = await matchWithAi(concern, candidates);
    if (!story) {
      candidates = candidates.slice(1);
      continue;
    }

    const source = story.sourceId
      ? candidates[story.sourceId - 1]
      : candidates.find((item) => normalizeUrl(item.url) === normalizeUrl(story.sourceUrl));

    if (source && story.confidence >= 0.55) {
      const verifiedQuote = findOriginalQuote(story.quoteExcerpt, getSourceText(source));
      if (verifiedQuote) {
        return {
          ...story,
          sourceTitle: source.title ?? story.sourceTitle,
          sourceUrl: source.url ?? story.sourceUrl,
          quoteExcerpt: wrapChineseQuote(verifiedQuote)
        };
      }
    }

    const previousLength = candidates.length;
    candidates = candidates.filter((item) => normalizeUrl(item.url) !== normalizeUrl(story.sourceUrl));
    if (candidates.length === previousLength) {
      candidates = candidates.slice(1);
    }
  }

  return buildSourceQuoteFallback(searchResults, analysis);
}

async function matchWithAi(concern: string, searchResults: SearchResult[]) {
  const prompt = buildPrompt(concern, searchResults);
  const json = await callJsonAi([
    {
      role: 'system',
      content: '你是一个严谨的中文传记原文检索助手。只能从提供的来源文本中逐字摘录，不得总结、改写、翻译、补写或编造。'
    },
    { role: 'user', content: prompt }
  ], 0.2);

  const parsed = StoryResultSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function callJsonAi(messages: AiMessage[], temperature: number) {
  const response = await fetch(`${process.env.AI_BASE_URL?.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.AI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      temperature,
      response_format: { type: 'json_object' },
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`AI 服务返回异常：${response.status}`);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  return parseJsonObject(content);
}

function buildPrompt(concern: string, searchResults: SearchResult[]) {
  const sources = searchResults.map((item, index) => ({
    id: index + 1,
    title: item.title,
    url: item.url,
    excerpt: getSourceText(item).slice(0, 1800)
  }));

  return `
用户的烦闷心事：
${concern}

可用搜索结果：
${JSON.stringify(sources, null, 2)}

请从搜索结果中选择一个最相似的公众人物真实经历。要求：
1. 必须返回所选来源的 sourceId，并复制上面对应来源的 sourceUrl。
2. quoteExcerpt 必须是对应 excerpt 中连续出现的逐字原文，不能总结、改写、翻译或补字。
3. quoteExcerpt 最多 120 个中文字或 240 个英文字符，不要加引号。
4. 如果没有合适的逐字原文，请返回 confidence 低于 0.45。
5. 只返回 JSON，字段为 sourceId、personName、storyTitle、quoteExcerpt、sourceTitle、sourceUrl、confidence。
`;
}

function parseJsonObject(content: string) {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
    }
    return null;
  }
}

function getSourceText(item: SearchResult) {
  return [stringifySourceText(item.raw_content), item.content].filter(Boolean).join('\n\n');
}

function stringifySourceText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stringifySourceText(item)).filter(Boolean).join('\n\n');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => stringifySourceText(item))
      .filter(Boolean)
      .join('\n\n');
  }
  return String(value);
}

function findOriginalQuote(quote: string, sourceText: string) {
  const cleanedQuote = stripWrappingQuotes(quote).trim();
  if (!cleanedQuote || isQuoteTooLong(cleanedQuote)) {
    return null;
  }

  const directIndex = sourceText.indexOf(cleanedQuote);
  if (directIndex >= 0) {
    return sourceText.slice(directIndex, directIndex + cleanedQuote.length);
  }

  return findSourceSliceIgnoringWhitespace(cleanedQuote, sourceText);
}

function stripWrappingQuotes(value: string) {
  return value.replace(/^[“”"']+/, '').replace(/[“”"']+$/, '');
}

function wrapChineseQuote(value: string) {
  const cleaned = stripWrappingQuotes(value).trim();
  return `“${cleaned}”`;
}

function isQuoteTooLong(value: string) {
  const cjkCount = Array.from(value).filter((char) => /[\u3400-\u9fff]/.test(char)).length;
  return cjkCount > 120 || value.length > 240;
}

function findSourceSliceIgnoringWhitespace(quote: string, sourceText: string) {
  let quoteIndex = 0;
  let start = -1;

  for (let sourceIndex = 0; sourceIndex < sourceText.length; sourceIndex += 1) {
    const sourceChar = sourceText[sourceIndex];
    if (/\s/.test(sourceChar)) {
      continue;
    }

    while (quoteIndex < quote.length && /\s/.test(quote[quoteIndex])) {
      quoteIndex += 1;
    }

    if (sourceChar !== quote[quoteIndex]) {
      quoteIndex = sourceChar === quote[0] ? 1 : 0;
      start = sourceChar === quote[0] ? sourceIndex : -1;
      continue;
    }

    if (start === -1) {
      start = sourceIndex;
    }
    quoteIndex += 1;

    while (quoteIndex < quote.length && /\s/.test(quote[quoteIndex])) {
      quoteIndex += 1;
    }

    if (quoteIndex >= quote.length) {
      const slice = sourceText.slice(start, sourceIndex + 1).trim();
      return isQuoteTooLong(slice) ? null : slice;
    }
  }

  return null;
}

function normalizeUrl(url?: string) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

function getPublicErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes('环境变量')) {
      return error.message;
    }
    if (error.message.startsWith('搜索服务返回异常')) {
      return error.message;
    }
    if (error.message.startsWith('AI 服务返回异常')) {
      return error.message;
    }
  }

  return '暂时没有找到足够可靠的原文材料。';
}
