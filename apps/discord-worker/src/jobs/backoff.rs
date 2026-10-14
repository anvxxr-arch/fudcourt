//! Retry policy: exponential backoff with a cap.
//!
//! Pure — no clock, no database — so the arithmetic is unit-tested directly
//! instead of being inferred from an integration run.

/// Exponential backoff parameters. `base_secs * factor^(attempts-1)`, capped at
/// `max_secs` so a long-lived retry never sleeps for days.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    pub base_secs: u64,
    pub factor: u64,
    pub max_secs: u64,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            base_secs: 5,
            factor: 2,
            max_secs: 3600,
        }
    }
}

impl Backoff {
    /// The delay to wait before the attempt that FOLLOWS `attempts` failures.
    ///
    /// `attempts` is the count already burned (so `1` means "one attempt just
    /// failed"; the wait before the second attempt). The exponent is clamped: a
    /// job that somehow reached attempt 1000 must not overflow the shift, and
    /// the saturating arithmetic means the cap wins long before it could.
    pub fn delay_secs(&self, attempts: u32) -> u64 {
        let exponent = attempts.saturating_sub(1).min(20);
        self.base_secs
            .saturating_mul(self.factor.saturating_pow(exponent))
            .min(self.max_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_retry_waits_the_base_delay() {
        assert_eq!(Backoff::default().delay_secs(1), 5);
    }

    #[test]
    fn each_retry_doubles() {
        let b = Backoff::default();
        assert_eq!(b.delay_secs(2), 10);
        assert_eq!(b.delay_secs(3), 20);
        assert_eq!(b.delay_secs(4), 40);
    }

    #[test]
    fn the_cap_wins() {
        let b = Backoff {
            base_secs: 60,
            factor: 2,
            max_secs: 300,
        };
        assert_eq!(b.delay_secs(1), 60);
        assert_eq!(b.delay_secs(2), 120);
        assert_eq!(b.delay_secs(3), 240);
        assert_eq!(b.delay_secs(4), 300);
        assert_eq!(b.delay_secs(50), 300);
    }

    #[test]
    fn a_huge_attempt_count_does_not_overflow() {
        // 2^20 * 5 already exceeds the cap; the point is that it returns the cap
        // instead of panicking or wrapping.
        assert_eq!(Backoff::default().delay_secs(u32::MAX), 3600);
    }

    #[test]
    fn zero_attempts_is_treated_as_the_first_wait() {
        // Defensive: a caller passing 0 must not underflow.
        assert_eq!(Backoff::default().delay_secs(0), 5);
    }
}
