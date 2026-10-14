//! Execution identity: how a logical unit of work gets a deterministic key.
//!
//! The key is what the `jobs (guild_id, kind, dedupe_key)` unique constraint
//! enforces, so a re-enqueue of the same logical work collides in the database
//! instead of running twice. Idempotency is a schema property, not a promise the
//! application makes.

/// Units-per-part length prefix. A length-prefixed join is injective, so
/// `dedupe_key(&["a", "b:c"])` can never equal `dedupe_key(&["a:b", "c"])` the
/// way a plain `:` join would.
pub fn dedupe_key(parts: &[&str]) -> String {
    let mut out = String::new();
    for part in parts {
        out.push_str(&part.len().to_string());
        out.push(':');
        out.push_str(part);
    }
    out
}

/// A stable 64-bit FNV-1a hash, hex-encoded.
///
/// Used to fold a value that is too long or too unstructured to be a key — a
/// feed item's URL, a document body — into a fixed-width key that still fits a
/// btree index. Deliberately NOT a cryptographic hash: nothing here needs
/// collision resistance against an adversary, only a stable fingerprint.
pub fn stable_hash(input: &str) -> String {
    // FNV-1a 64-bit: offset basis and prime from the published algorithm.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_are_joined_deterministically() {
        assert_eq!(dedupe_key(&["feed", "42"]), "4:feed2:42");
    }

    #[test]
    fn different_part_splits_do_not_collide() {
        // The classic reason for length prefixes: a separator character that can
        // appear inside a part makes a naive join ambiguous.
        assert_ne!(dedupe_key(&["a", "b:c"]), dedupe_key(&["a:b", "c"]));
        assert_ne!(dedupe_key(&["ab", "c"]), dedupe_key(&["a", "bc"]));
    }

    #[test]
    fn the_same_parts_always_produce_the_same_key() {
        assert_eq!(
            dedupe_key(&["feed", "42", "2026-10-14"]),
            dedupe_key(&["feed", "42", "2026-10-14"])
        );
    }

    #[test]
    fn an_empty_slice_is_the_empty_key() {
        assert_eq!(dedupe_key(&[]), "");
    }

    #[test]
    fn stable_hash_is_stable_and_fixed_width() {
        let a = stable_hash("https://example.com/feed/item/1");
        assert_eq!(a, stable_hash("https://example.com/feed/item/1"));
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn stable_hash_separates_different_inputs() {
        assert_ne!(stable_hash("a"), stable_hash("b"));
        assert_ne!(stable_hash(""), stable_hash("0"));
    }

    #[test]
    fn stable_hash_matches_the_published_fnv1a_vector() {
        // The canonical FNV-1a 64-bit test vector for "a" is 0xaf63dc4c8601ec8c.
        assert_eq!(stable_hash("a"), "af63dc4c8601ec8c");
    }
}
