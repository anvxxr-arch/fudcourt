//! fudcourt live multi-chain balance sync -> the Postgres `assets` table (DR-040).
//!
//! HARD RULES (inherited from tests/oracle/sync-live.py, which
//! stays in place as the oracle this binary is measured against):
//!   * exact wallet address, exact balance, exact hash
//!   * a failed RPC NEVER becomes 0 -- it raises, so we never fake a zero
//!     balance
//!   * a missing credential STOPS the run loudly; no fallback could ever do
//!     anything but yield garbage credentials

use fudcourt_sync::oracle;
use fudcourt_sync::streams::sync;

// The pipeline stages and shared primitives come from the library
// (`fudcourt_sync`): the Postgres client from `persistence`, the sync pipeline
// from `streams`, and the Python-parity oracle replay seam at the crate root.

use std::path::{Path, PathBuf};

/// `load_env()` -- nearest `.env` walking up from the executable (release
/// binary lives in `backend/sync/target/release/`, so this reaches the repo
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
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut oracle_inputs: Option<String> = None;
    let mut oracle_trace: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            // --oracle-inputs FILE: replay a recorded capture (no network, no
            // writes; prints the projection between the same markers the
            // Python oracle uses). Mirrors sync-live.py's seam.
            "--oracle-inputs" => match argv.get(i + 1) {
                Some(v) => {
                    oracle_inputs = Some(v.clone());
                    i += 2;
                }
                None => usage("--oracle-inputs needs a FILE"),
            },
            "--oracle-trace" => match argv.get(i + 1) {
                Some(v) => {
                    oracle_trace = Some(v.clone());
                    i += 2;
                }
                None => usage("--oracle-trace needs a FILE"),
            },
            other => usage(&format!("unknown flag {other}")),
        }
    }
    if let Some(path) = oracle_inputs {
        if let Err(e) = oracle::init(&path, oracle_trace.as_deref()) {
            eprintln!("oracle init failed: {e}");
            std::process::exit(2);
        }
    }
    load_env();
    // Oracle mode needs no credential: every upstream call is served from the
    // capture and the store's write path is never reached. The live (flagless)
    // path still requires both tokens (a missing credential STOPs the run).
    let env = if oracle::active() {
        sync::Env {
            pg_dsn: std::env::var("FUDCOURT_PG_URL").unwrap_or_default(),
            alchemy_key: std::env::var("ALCHEMY_KEY").unwrap_or_default(),
        }
    } else {
        sync::Env {
            pg_dsn: require_env("FUDCOURT_PG_URL"),
            alchemy_key: require_env("ALCHEMY_KEY"),
        }
    };
    stamp("sync start (rust)");
    match sync::run(&env).await {
        Ok(()) => {
            if oracle::active() {
                oracle::save_trace();
            }
            stamp("sync ok");
        }
        Err(e) => {
            eprintln!("sync failed: {e}");
            stamp(&format!("sync failed: {e}"));
            std::process::exit(1);
        }
    }
}

fn usage(problem: &str) -> ! {
    eprintln!("{problem}\nusage: fudcourt-sync [--oracle-inputs FILE] [--oracle-trace FILE]");
    std::process::exit(2);
}
