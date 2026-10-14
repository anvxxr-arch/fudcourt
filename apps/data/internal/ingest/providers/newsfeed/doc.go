// Package newsfeed implements durable ingestion of crypto news feeds
// (RSS/Atom/JSON Feed, REST API, sitemap) into data.news_article.
//
// Source inventory contract (158-entry manifest):
//   - The full 158-entry source list from the planning conversation is NOT
//     present in this repo or in the execution context. No manifest file,
//     no source-list file exists. This package MUST NOT fabricate rows.
//   - Runtime truth is the Go Sources table in sources.go (modes.go style,
//     one row per canonical source, deduped by lowercased registrable
//     domain). manifest.json in this package is the version-controlled
//     audit trail; an explicitly provided manifest drops in via
//     LoadManifest and is validated by ValidateSources before promotion
//     to the Go table.
//   - Absent entries are recorded as blocked/pending with a BlockReason.
//     A dataset is marked working only after a live HTTP probe returns
//     200 + parseable feed + >=1 item extracted. Config existence alone
//     never marks a source working.
//
// Reuse (do not duplicate):
//   - Scheduling, per-provider rate limiting, circuit breaking, backoff,
//     bounded workers, graceful shutdown, ingestion_run/ingestion_error
//     journal, and job-table double-dispatch guard come from the ingest
//     Engine. This package implements Module/Fetcher only.
//   - Storage is data.news_article via canon.Writer.WriteArticles and
//     canon.Reader.ListArticles. No parallel news_items tables.
//   - research/news is the read-through proxy with its own wire contract
//     (Source{Name,Label,URL}) and verify-news.py assertion. Do not add
//     rows there; durable ingest sources live here only.
//
// Article identity:
//   - ArticleID = canon.ArticleKey(provider, providerArticleID).
//   - RetrievedAt = time.Now().UTC() at write time (never the feed
//     pubDate); feed pubDate goes in PublishedAt. validateArticle
//     rejects empty ArticleID/Headline/URL/Source/RetrievedAt and any
//     retrieved_at beyond now+5min.
package newsfeed
