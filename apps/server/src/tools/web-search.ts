/** web_search:优先 Tavily(配 TAVILY_API_KEY),否则 DuckDuckGo HTML;都失败时返回降级结果而不炸 turn。 */
import type { ToolFn } from './index.js';

export const webSearch: ToolFn = async (args, ctx) => {
  const query = String(args.query ?? '').slice(0, 200);
  ctx.progress({ status: 'searching', query });

  if (process.env.TAVILY_API_KEY) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 }),
    });
    if (r.ok) {
      const j: any = await r.json();
      return { query, results: (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content?.slice(0, 200) })) };
    }
  }
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'user-agent': 'Mozilla/5.0 (dura-agent)' }, signal: AbortSignal.timeout(8000),
    });
    const html = await r.text();
    const results: { title: string; url: string; snippet: string }[] = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const realUrl = (u: string) => {   // DDG 跳转链接 //duckduckgo.com/l/?uddg=<真实URL> → 解码
      const mm = u.match(/[?&]uddg=([^&]+)/);
      return mm ? decodeURIComponent(mm[1]) : u;
    };
    while ((m = re.exec(html)) && results.length < 5) results.push({ title: strip(m[2]), url: realUrl(m[1]), snippet: strip(m[3]).slice(0, 200) });
    if (results.length) return { query, results };
  } catch { /* fallthrough */ }
  return { query, results: [], note: '搜索源不可用(可配置 TAVILY_API_KEY)。请基于已有知识回答并注明未联网。' };
};
