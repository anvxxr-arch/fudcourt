package news

import "context"

// This file is the wire shape: the envelope and the Service that ties a Fetcher
// to the feed semantics.
//
// # The envelope is the TS route's, key for key
//
//	{ items: NewsItem[], total: number, upstream: string, timestamp: number }
//
// `total` is the FULL parsed item count while `items` is the `limit` head: a
// 5-row body must never be readable as "the feed has 5 items". That pair is the
// honest-by-construction rule this family's route already shipped, and
// scripts/verify-news.py asserts both.
//
// There is deliberately NO `kind`/`derived` field the other families carry: news
// has no modes and performs no transform beyond the limit slice, so a `derived`
// string would have nothing true to say (`upstream` + `total` already name the
// document and its real length). Adding one to look uniform would be ceremony.
type Envelope struct {
	Items     []Item `json:"items"`
	Total     int    `json:"total"`
	Upstream  string `json:"upstream"`
	Timestamp int64  `json:"timestamp"`
	// Cache is the X-Cache value, carried here because the handler owns the
	// HEADER and the shaper owns the knowledge. It is NOT part of the wire
	// envelope (the TS route put it in a header too), hence `json:"-"`.
	Cache string `json:"-"`
}

// Service ties a Fetcher to the feed semantics. F is the only state it has (the
// fetcher owns the cache and single-flight), so it is a value, like llama's.
type Service struct{ F *Fetcher }

// Envelope builds the response for one already-validated (source, limit).
//
// It fetches by FEED URL -- so every `limit` shares one cached document -- then
// slices the head. Every failure is returned as an error; the handler maps it
// to the frozen body and never substitutes an empty payload.
func (s *Service) Envelope(ctx context.Context, src Source, limit int) (Envelope, error) {
	_, items, info, err := s.F.Fetch(ctx, src.URL)
	if err != nil {
		return Envelope{}, err
	}
	head := items
	if limit >= 0 && limit < len(items) {
		head = items[:limit]
	}
	if head == nil {
		head = []Item{}
	}
	return Envelope{
		Items:     head,
		Total:     len(items),
		Upstream:  src.URL,
		Timestamp: Now() * 1000, // the TS route's Date.now() is milliseconds
		Cache:     info.Cache,
	}, nil
}
