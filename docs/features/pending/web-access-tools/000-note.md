## Recommendations for Internet Access Tools

Your existing tool architecture (`AgentTool` interface + `ToolRegistry` + category system) makes this straightforward to add. Here are the options, ranked by practicality:

### Option 1: Web Search Tool (recommended first step)

Add a `web_search` tool that calls a search API. Best candidates:

| Provider | Pros | Cons |
|----------|------|------|
| **Tavily** | Built for AI agents, returns pre-extracted content, structured results | Paid (generous free tier) |
| **Brave Search API** | Good free tier, fast, privacy-focused | Raw snippets, needs content extraction |
| **SerpAPI / Serper.dev** | Google results, reliable | Paid |
| **Exa** | Semantic search, returns clean content | Newer, paid |

**Tavily** is the strongest fit — it's purpose-built for LLM agents and returns cleaned, relevant text rather than raw HTML, which keeps token usage down.

### Option 2: Web Browse/Scrape Tool

A `browse_url` tool that fetches and extracts readable content from a URL. Use something like Mozilla's Readability (via `@mozilla/readability` + `linkedom`) to extract article text without needing a headless browser.

### Option 3: News/Crypto-Specific Feeds

A `crypto_news` tool that pulls from structured APIs (CoinGecko news, CryptoPanic, The Block API) — more relevant signal, lower token cost, no HTML parsing.

---

### Implementation Shape

You'd add a new category to `ToolCategory`:

```typescript
| 'read-web'  // internet research, web search, URL browsing
```

Then a new file like `apps/worker/src/tools/web-access.ts` implementing tools such as:

- **`web_search(query, opts?)`** — search the internet, return top results with snippets
- **`browse_url(url)`** — fetch and extract readable text from a URL (with byte/token limits)

These would be `read-web` category tools, gated by your capability engine so you can control per-agent access and rate-limit external calls.

### Key Considerations

1. **Token budget** — web content is verbose. Truncate/summarize fetched pages (e.g., first 4000 chars or use Tavily's `search_depth: "basic"` which returns concise extracts).
2. **Rate limiting** — add provider entries in your rate-limit config for search APIs.
3. **Sandboxing** — `browse_url` should only fetch `https://` URLs, reject private IPs (SSRF prevention), and enforce a response size cap.
4. **Cost** — Tavily is ~$0.01/search. At one search per agent tick, this is negligible vs. LLM costs.
5. **Skill wiring** — add a `research` skill that exposes these tools so agents can be given research capability selectively.

### My Recommendation

Start with **Tavily `web_search`** + a simple **`browse_url`** using `fetch` + `@mozilla/readability` + `linkedom`. This gives agents both broad search and targeted page reading without heavy dependencies or headless browsers. Add `crypto_news` later as a structured, lower-cost complement for market-relevant research.