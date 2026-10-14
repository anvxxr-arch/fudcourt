//! Turning a fetched feed body into the one shape the ledger stores.
//!
//! Two things here are load-bearing beyond "parse the XML":
//!
//! **The item key** decides what "already announced" means, and it is persisted,
//! so it must be stable across restarts, Rust versions and code changes. It
//! prefers the feed's own entry id, falls back to the entry link, and falls back
//! again to a title+date digest — each prefixed with a tag, so a feed that
//! switches which one it offers does not collide with its own past.
//!
//! **The text** is never trusted. It is external content on its way into a
//! Discord message, so HTML is reduced to plain text and every mention is
//! defanged: a feed item must not be able to ping `@everyone` or a role in a
//! channel it has no business touching.

use chrono::{DateTime, Utc};
use feed_rs::model::Entry;
use feed_rs::parser;
use sha2::{Digest, Sha256};

/// How many entries one poll may carry into the ledger. A feed that suddenly
/// serves 50 000 entries must not turn into 50 000 inserts and 50 000
/// announcements; the cap is the difference between a busy feed and an outage.
pub const MAX_ITEMS_PER_POLL: usize = 200;

/// Where a stored summary is cut. Long enough for a useful embed, short enough
/// that one item cannot dominate the row.
pub const MAX_SUMMARY_CHARS: usize = 1000;

/// One entry, normalized. `key` is namespaced and stable; everything else is
/// display data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub key: String,
    pub external_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub summary: String,
    pub image: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
}

/// Parse a feed body into normalized items.
///
/// `limit` is clamped to [`MAX_ITEMS_PER_POLL`] so a caller cannot raise the
/// bound by passing a larger number.
pub fn items_from(bytes: &[u8], limit: usize) -> Result<Vec<Item>, String> {
    let feed = parser::parse(bytes).map_err(|e| format!("not a parseable feed: {e}"))?;
    let limit = limit.min(MAX_ITEMS_PER_POLL);

    let mut items: Vec<Item> = feed.entries.iter().map(item_from).collect();
    // Newest first, so a capped poll keeps the most relevant entries rather than
    // whatever order the document happened to use.
    // Newest first; an entry with no date sorts last rather than first.
    items.sort_by_key(|i| std::cmp::Reverse(i.published_at));
    items.truncate(limit);
    Ok(items)
}

fn item_from(entry: &Entry) -> Item {
    let external_id = entry.id.trim();
    let external_id = (!external_id.is_empty()).then(|| external_id.to_string());
    let url = link_of(entry);

    let title = entry
        .title
        .as_ref()
        .map(|t| t.content.as_str())
        .unwrap_or_default();
    let body = entry
        .summary
        .as_ref()
        .map(|c| c.content.as_str())
        .or_else(|| entry.content.as_ref().and_then(|c| c.body.as_deref()))
        .unwrap_or_default();

    Item {
        key: key_for(
            external_id.as_deref(),
            url.as_deref(),
            title,
            entry.published.or(entry.updated),
        ),
        external_id,
        title: clean(title, 300),
        url,
        summary: clean(body, MAX_SUMMARY_CHARS),
        image: image_of(entry),
        published_at: entry.published.or(entry.updated),
    }
}

/// The entry's canonical link: `rel=alternate` if the feed says so, else the
/// first link that is a real URL. Audio/self links are skippable noise.
fn link_of(entry: &Entry) -> Option<String> {
    let alternate = entry
        .links
        .iter()
        .find(|l| l.rel.as_deref() == Some("alternate") && is_http(&l.href));
    let any = entry.links.iter().find(|l| is_http(&l.href));
    alternate.or(any).map(|l| l.href.clone())
}

fn image_of(entry: &Entry) -> Option<String> {
    entry
        .media
        .iter()
        .flat_map(|m| m.thumbnails.iter())
        .map(|t| t.image.uri.clone())
        .find(|u| is_http(u))
}

fn is_http(u: &str) -> bool {
    u.starts_with("http://") || u.starts_with("https://")
}

/// The stable identity of an entry, in order of how much the feed itself
/// promises: its own id, else the link, else the title and date together.
fn key_for(
    external_id: Option<&str>,
    url: Option<&str>,
    title: &str,
    at: Option<DateTime<Utc>>,
) -> String {
    if let Some(id) = external_id {
        return format!("id:{}", digest(id).as_str());
    }
    if let Some(u) = url {
        return format!("link:{}", digest(u).as_str());
    }
    let fallback = format!(
        "{title}\u{1f}{}",
        at.map(|d| d.to_rfc3339()).unwrap_or_default()
    );
    format!("t:{}", digest(&fallback).as_str())
}

/// A stable, version-independent digest, truncated to 32 hex chars.
fn digest(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    out.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// HTML (or any markup a feed hands us) reduced to a single line of plain text.
///
/// Deliberately small and bounded: it drops tags, decodes the handful of
/// entities that actually appear in feeds, collapses whitespace, defangs
/// mentions, and then cuts to `cap` **characters** (not bytes — slicing a UTF-8
/// string by byte index panics mid-codepoint).
pub fn clean(raw: &str, cap: usize) -> String {
    let mut out = String::with_capacity(raw.len().min(cap * 2));
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            _ => out.push(ch),
        }
    }
    let out = decode_entities(&out);
    let out = collapse_ws(&out);
    let out = neutralize_mentions(&out);
    truncate_chars(out.trim(), cap)
}

fn decode_entities(s: &str) -> String {
    // Feed bodies use a small set; a full entity decoder is a dependency and a
    // parse surface for no gain here.
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&hellip;", "…")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(ch);
        }
    }
    out
}

/// Break every mention, and drop control characters while we are here.
///
/// A zero-width space after the `@` and inside the `<@id>` form is enough: the
/// text stays readable and Discord's parser no longer sees a mention. This is
/// the difference between "someone's RSS title says @everyone" being a curiosity
/// and being a server-wide ping.
pub fn neutralize_mentions(s: &str) -> String {
    let mut broken = s
        .replace("@everyone", "@\u{200b}everyone")
        .replace("@here", "@\u{200b}here");
    // `<@123>`, `<@!123>`, `<@&123>` — the mention forms a payload can carry.
    let mut out = String::with_capacity(broken.len());
    let bytes: Vec<char> = broken.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '<' && i + 1 < bytes.len() && bytes[i + 1] == '@' {
            out.push_str("<\u{200b}");
            i += 1;
            continue;
        }
        let ch = bytes[i];
        // Everything below U+0020 except a tab is control noise in a Discord
        // message; U+007F and the C1 range are the same story.
        if (ch < ' ' && ch != '\t') || ch == '\u{7f}' || ('\u{80}'..='\u{9f}').contains(&ch) {
            i += 1;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    broken.clear();
    out
}

/// Cut to at most `cap` characters, appending an ellipsis when it had to.
///
/// Public because the delivery side caps embed fields with it too.
pub fn truncate_chars(s: &str, cap: usize) -> String {
    if cap == 0 {
        return String::new();
    }
    let mut out: String = s.chars().take(cap).collect();
    if s.chars().count() > cap {
        // Make room, so the result is exactly `cap` characters including the
        // ellipsis.
        out.pop();
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test feed</title>
  <item>
    <title>Older &amp; first</title>
    <link>https://example.com/a</link>
    <guid>post-1</guid>
    <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt; @everyone&lt;/p&gt;</description>
  </item>
  <item>
    <title>Newer</title>
    <link>https://example.com/b</link>
    <guid>post-2</guid>
    <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
    <description>newer body</description>
  </item>
</channel></rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom feed</title>
  <updated>2026-10-06T10:00:00Z</updated>
  <entry>
    <title>Entry one</title>
    <id>urn:uuid:entry-1</id>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <updated>2026-10-06T09:00:00Z</updated>
    <summary>atom summary</summary>
  </entry>
</feed>"#;

    const JSONFEED: &str = r#"{
      "version": "https://jsonfeed.org/version/1.1",
      "title": "JSON feed",
      "items": [
        {"id": "j1", "url": "https://example.com/j/1", "title": "JSON one",
         "content_text": "plain body", "date_published": "2026-10-06T10:00:00Z"}
      ]
    }"#;

    #[test]
    fn an_rss_feed_becomes_items_newest_first() {
        let items = items_from(RSS.as_bytes(), 10).expect("rss parses");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Newer", "newest entry must come first");
        assert_eq!(items[1].title, "Older & first", "entities are decoded");
        assert_eq!(items[1].url.as_deref(), Some("https://example.com/a"));
        assert!(items[0].key.starts_with("id:"), "key: {}", items[0].key);
        assert!(items[0].published_at.is_some());
    }

    #[test]
    fn markup_is_stripped_and_mentions_are_broken() {
        let items = items_from(RSS.as_bytes(), 10).expect("rss parses");
        let older = items.iter().find(|i| i.title.starts_with("Older")).unwrap();
        // Tags gone, whitespace collapsed, and `@everyone` is no longer a ping.
        assert_eq!(older.summary, "Hello world @\u{200b}everyone");
    }

    #[test]
    fn an_atom_feed_and_a_json_feed_use_the_same_code_path() {
        let atom = items_from(ATOM.as_bytes(), 10).expect("atom parses");
        assert_eq!(atom.len(), 1);
        assert_eq!(atom[0].external_id.as_deref(), Some("urn:uuid:entry-1"));
        assert_eq!(atom[0].url.as_deref(), Some("https://example.com/atom/1"));
        assert_eq!(atom[0].summary, "atom summary");

        let json = items_from(JSONFEED.as_bytes(), 10).expect("json parses");
        assert_eq!(json.len(), 1);
        assert_eq!(json[0].external_id.as_deref(), Some("j1"));
        assert_eq!(json[0].url.as_deref(), Some("https://example.com/j/1"));
        assert_eq!(json[0].summary, "plain body");
    }

    #[test]
    fn the_key_is_stable_across_parses() {
        // It is PERSISTED, so a key that changed between runs would re-announce
        // every item in the feed.
        let a = items_from(RSS.as_bytes(), 10).expect("parses");
        let b = items_from(RSS.as_bytes(), 10).expect("parses");
        let keys_a: Vec<&str> = a.iter().map(|i| i.key.as_str()).collect();
        let keys_b: Vec<&str> = b.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys_a, keys_b);
        assert_ne!(keys_a[0], keys_a[1], "two entries are two keys");
    }

    #[test]
    fn the_key_prefers_the_feeds_own_id_then_the_link() {
        // The feed's id is the strongest promise about identity.
        assert!(key_for(Some("post-1"), Some("https://x/1"), "t", None).starts_with("id:"));
        // Without one, the link is the next best thing.
        assert!(key_for(None, Some("https://x/1"), "t", None).starts_with("link:"));
        // Neither: the title alone is a weak key, and the namespace says so.
        assert!(key_for(None, None, "t", None).starts_with("t:"));
    }

    #[test]
    fn every_mention_form_in_a_payload_is_broken() {
        for raw in ["@everyone", "@here"] {
            assert!(!neutralize_mentions(raw).contains("@everyone"));
            assert!(neutralize_mentions(raw).contains('\u{200b}'));
        }
        // The three angle-bracket forms Discord parses as mentions.
        for raw in ["<@123>", "<@!123>", "<@&456>"] {
            let out = neutralize_mentions(raw);
            assert!(out.starts_with("<\u{200b}"), "{raw} → {out}");
            assert!(!out.contains("<@"));
        }
        // A plain `<` is left alone.
        assert_eq!(neutralize_mentions("a < b"), "a < b");
    }

    #[test]
    fn control_characters_are_dropped() {
        let out = neutralize_mentions("clean\u{0}text\u{7f}\u{9b}here");
        assert_eq!(out, "cleantexthere");
        assert_eq!(neutralize_mentions("keep\ttab"), "keep\ttab");
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        // A byte-index slice would panic mid-codepoint on the 3-byte characters.
        let s = "é".repeat(50);
        let cut = truncate_chars(&s, 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'));
        // Under the cap: untouched, no ellipsis.
        assert_eq!(truncate_chars("short", 10), "short");
        assert_eq!(truncate_chars("anything", 0), "");
        // The summary cap is applied by `clean`, so a huge body cannot dominate
        // the row.
        let huge = "x".repeat(MAX_SUMMARY_CHARS * 2);
        assert_eq!(
            clean(&huge, MAX_SUMMARY_CHARS).chars().count(),
            MAX_SUMMARY_CHARS
        );
    }

    #[test]
    fn the_item_cap_is_clamped_and_respected() {
        assert_eq!(MAX_ITEMS_PER_POLL, 200);
        // A caller cannot raise the bound by asking for more.
        assert_eq!(items_from(RSS.as_bytes(), usize::MAX).unwrap().len(), 2);
        // And a small bound is honoured.
        assert_eq!(items_from(RSS.as_bytes(), 1).unwrap().len(), 1);
        assert_eq!(items_from(RSS.as_bytes(), 0).unwrap().len(), 0);
    }

    #[test]
    fn a_body_that_is_not_a_feed_is_an_error() {
        // A 200 with an HTML login page must be reported, not silently treated as
        // an empty feed (which would look like "no new items" forever).
        let err = items_from(b"<html><body>nope</body></html>", 10).unwrap_err();
        assert!(err.contains("not a parseable feed"), "got: {err}");
    }
}
