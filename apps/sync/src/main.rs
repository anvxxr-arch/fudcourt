//! fudcourt live multi-chain balance sync -> Turso `assets` table.
//!
//! HARD RULES (inherited from apps/web/scripts/sync-live.py, which stays in
//! place as the oracle this binary is measured against):
//!   * exact wallet address, exact balance, exact hash
//!   * a failed RPC NEVER becomes 0 -- it raises, so we never fake a zero
//!     balance
//!   * a missing credential STOPS the run loudly; no fallback could ever do
//!     anything but yield garbage credentials

mod chains;
mod jsonrpc;
mod sync;

// Shared with the `fudcourt-reconciled` binary through the library: the Turso
// client and the CPython-exact float rendering (DR-014 added the second
// consumer, which is what made a library surface worth having).
use fudcourt_sync::{db, pyfmt};

use std::path::{Path, PathBuf};

/// `load_env()` -- nearest `.env` walking up from the executable (release
/// binary lives in `apps/sync-rs/target/release/`, so this reaches the repo
/// root exactly like the script's `Path(__file__).resolve().parent` walk).
/// `os.environ.setdefault` semantics: an existing non-empty var wins.
fn load_env() {
    let start = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let mut dir: Option<&Path> = Some(start.as_path());
    while let Some(d) = dir {
        let env_path = d.join(".env");
        if env_path.exists() {
            if let Ok(text) = std::fs::read_to_string(&env_path) {
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') || !line.contains('=') {
                        continue;
                    }
                    let (k, v) = line.split_once('=').unwrap();
                    let k = k.trim();
                    let present = std::env::var(k).map(|e| !e.is_empty()).unwrap_or(false);
                    if !present {
                        let v = v.trim().trim_matches(|c| c == '\'' || c == '"');
                        std::env::set_var(k, v);
                    }
                }
            }
            break;
        }
        dir = d.parent();
    }
}

/// `require_env(name)` -- a missing credential must STOP the sync loudly.
fn require_env(name: &str) -> String {
    let v = std::env::var(name).unwrap_or_default().trim().to_string();
    if v.is_empty() {
        eprintln!(
            "missing {name} (set it in the repo-root .env; rotation runbook: docs/SECRETS.md)"
        );
        std::process::exit(1);
    }
    v
}

/// Days since the Unix epoch -> (year, month, day), Howard Hinnant's civil
/// algorithm (no date crate needed for one log line).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Lifecycle lines carry UTC timestamps the way the service's journal does;
/// body lines stay byte-identical to the Python oracle's output.
fn stamp(line: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d) = civil_from_days(now.div_euclid(86_400));
    let t = now.rem_euclid(86_400);
    println!(
        "[{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z] {line}",
        t / 3600,
        (t / 60) % 60,
        t % 60
    );
}

#[tokio::main]
async fn main() {
    load_env();
    let env = sync::Env {
        turso_token: require_env("TURSO_AUTH_TOKEN"),
        alchemy_key: require_env("ALCHEMY_KEY"),
    };
    stamp("sync start (rust)");
    match sync::run(&env).await {
        Ok(()) => stamp("sync ok"),
        Err(e) => {
            eprintln!("sync failed: {e}");
            stamp(&format!("sync failed: {e}"));
            std::process::exit(1);
        }
    }
}
