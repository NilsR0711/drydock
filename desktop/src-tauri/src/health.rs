use std::collections::HashMap;

use serde::Deserialize;

/// The `driver` block of `/api/health`: the global automation toggles the tray
/// mirrors and lets the operator flip.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Driver {
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub draining: bool,
}

/// The subset of `/api/health` the tray consumes. The endpoint returns 200 when
/// the driver loop is ticking and 503 when degraded, but the body shape is the
/// same either way, so the tray always parses the body regardless of status.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Health {
    #[serde(default)]
    pub driver: Driver,
    /// Job counts keyed by status; `null` (here `None`) when the DB is
    /// unreachable.
    #[serde(default)]
    pub queue: Option<HashMap<String, i64>>,
}

/// A render-ready view of the dashboard state for the tray title, tooltip, and
/// toggle check-marks. Derived from {@link Health} so the formatting is pure and
/// testable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub reachable: bool,
    pub paused: bool,
    pub draining: bool,
    /// Jobs actively running: `working` + `ci_running` + `retrying`.
    pub active: i64,
    pub queued: i64,
    pub needs_human: i64,
}

impl Snapshot {
    /// The state shown when the dashboard cannot be reached (server not started
    /// yet, or shutting down). Counts read zero and toggles are cleared.
    pub fn unreachable() -> Self {
        Self {
            reachable: false,
            paused: false,
            draining: false,
            active: 0,
            queued: 0,
            needs_human: 0,
        }
    }

    pub fn from_health(h: &Health) -> Self {
        let count = |key: &str| -> i64 {
            h.queue.as_ref().and_then(|m| m.get(key)).copied().unwrap_or(0)
        };
        Self {
            reachable: true,
            paused: h.driver.paused,
            draining: h.driver.draining,
            active: count("working") + count("ci_running") + count("retrying"),
            queued: count("queued"),
            needs_human: count("needs_human"),
        }
    }

    /// Compact text shown next to the menu-bar icon. Glyphs: ⚓ anchor (active),
    /// ▸ queued, ⚠ needs-human, ⏸ paused, ⤓ draining.
    pub fn tray_title(&self) -> String {
        if !self.reachable {
            return "⚓ –".to_string();
        }
        let mut title = format!("⚓ {} ▸ {}", self.active, self.queued);
        if self.needs_human > 0 {
            title.push_str(&format!(" ⚠ {}", self.needs_human));
        }
        if self.paused {
            title.push_str(" ⏸");
        } else if self.draining {
            title.push_str(" ⤓");
        }
        title
    }

    /// Multi-line hover text spelling out every count and active mode.
    pub fn tooltip(&self) -> String {
        if !self.reachable {
            return "Drydock — dashboard unreachable".to_string();
        }
        let mut lines = vec![
            "Drydock".to_string(),
            format!("Active: {}", self.active),
            format!("Queued: {}", self.queued),
            format!("Needs human: {}", self.needs_human),
        ];
        if self.paused {
            lines.push("Paused".to_string());
        }
        if self.draining {
            lines.push("Draining".to_string());
        }
        lines.join("\n")
    }
}

/// Fetch a single health snapshot. Any transport or parse failure folds into an
/// `unreachable` snapshot rather than an error, so the poll loop never breaks on
/// a momentarily-down server. A non-2xx status (503 degraded) is still parsed —
/// the tray wants the body, not the status code.
pub async fn fetch(client: &reqwest::Client, url: &str) -> Snapshot {
    match client.get(url).send().await {
        Ok(resp) => match resp.json::<Health>().await {
            Ok(health) => Snapshot::from_health(&health),
            Err(_) => Snapshot::unreachable(),
        },
        Err(_) => Snapshot::unreachable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(json: &str) -> Health {
        serde_json::from_str(json).expect("valid health json")
    }

    #[test]
    fn sums_active_states_and_reads_toggles() {
        let h = health(
            r#"{ "driver": { "paused": true, "draining": false },
                 "queue": { "queued": 2, "working": 1, "ci_running": 1, "retrying": 1, "needs_human": 3 } }"#,
        );
        let snap = Snapshot::from_health(&h);
        assert!(snap.reachable);
        assert!(snap.paused);
        assert!(!snap.draining);
        assert_eq!(snap.active, 3);
        assert_eq!(snap.queued, 2);
        assert_eq!(snap.needs_human, 3);
    }

    #[test]
    fn treats_missing_queue_as_zero_counts() {
        let h = health(r#"{ "driver": { "paused": false, "draining": true }, "queue": null }"#);
        let snap = Snapshot::from_health(&h);
        assert_eq!(snap.active, 0);
        assert_eq!(snap.queued, 0);
        assert_eq!(snap.needs_human, 0);
        assert!(snap.draining);
    }

    #[test]
    fn tolerates_a_sparse_body() {
        // A future/older server might omit fields entirely; serde defaults keep
        // the tray resilient instead of dropping the snapshot.
        let snap = Snapshot::from_health(&health("{}"));
        assert!(snap.reachable);
        assert_eq!(snap.active, 0);
        assert!(!snap.paused);
    }

    #[test]
    fn tray_title_when_unreachable() {
        assert_eq!(Snapshot::unreachable().tray_title(), "⚓ –");
    }

    #[test]
    fn tray_title_flags_needs_human_and_pause() {
        let snap = Snapshot {
            reachable: true,
            paused: true,
            draining: false,
            active: 2,
            queued: 5,
            needs_human: 1,
        };
        assert_eq!(snap.tray_title(), "⚓ 2 ▸ 5 ⚠ 1 ⏸");
    }

    #[test]
    fn tray_title_shows_drain_glyph_when_not_paused() {
        let snap = Snapshot {
            reachable: true,
            paused: false,
            draining: true,
            active: 0,
            queued: 0,
            needs_human: 0,
        };
        assert_eq!(snap.tray_title(), "⚓ 0 ▸ 0 ⤓");
    }

    #[test]
    fn tooltip_lists_counts_and_modes() {
        let snap = Snapshot {
            reachable: true,
            paused: true,
            draining: true,
            active: 1,
            queued: 2,
            needs_human: 0,
        };
        let tip = snap.tooltip();
        assert!(tip.contains("Active: 1"));
        assert!(tip.contains("Queued: 2"));
        assert!(tip.contains("Needs human: 0"));
        assert!(tip.contains("Paused"));
        assert!(tip.contains("Draining"));
    }
}
