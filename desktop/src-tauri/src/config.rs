use std::time::Duration;

/// Runtime configuration for the menu-bar shell, resolved once from the
/// environment at startup. Drydock is single-user and local-only, so the
/// defaults target the loopback dashboard with no further setup.
#[derive(Clone, Debug)]
pub struct DesktopConfig {
    /// Dashboard origin, without a trailing slash (e.g. `http://127.0.0.1:3737`).
    pub base_url: String,
    /// Optional `DRYDOCK_CONTROL_TOKEN`. Only required when the server was
    /// launched with one (daemon/headless lockdown); a plain foreground run
    /// needs no token because the control endpoints accept the guard header.
    pub control_token: Option<String>,
    /// How often the tray polls `/api/health` for live counts and toggle state.
    pub poll_interval: Duration,
}

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:3737";
const DEFAULT_POLL_SECONDS: u64 = 4;

impl DesktopConfig {
    pub fn from_env() -> Self {
        Self::resolve(|key| std::env::var(key).ok())
    }

    /// Pure resolver injected with a lookup so the precedence rules are
    /// unit-testable without touching the process environment.
    pub fn resolve(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let base_url = lookup("DRYDOCK_DESKTOP_URL")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let base_url = base_url.trim_end_matches('/').to_string();

        let control_token = lookup("DRYDOCK_CONTROL_TOKEN").filter(|s| !s.is_empty());

        let poll_seconds = lookup("DRYDOCK_DESKTOP_POLL_SECONDS")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(DEFAULT_POLL_SECONDS);

        Self {
            base_url,
            control_token,
            poll_interval: Duration::from_secs(poll_seconds),
        }
    }

    pub fn health_url(&self) -> String {
        format!("{}/api/health", self.base_url)
    }

    pub fn pause_url(&self) -> String {
        format!("{}/api/control/pause", self.base_url)
    }

    pub fn drain_url(&self) -> String {
        format!("{}/api/control/drain", self.base_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn defaults_to_the_loopback_dashboard_with_no_token() {
        let cfg = DesktopConfig::resolve(env(&[]));
        assert_eq!(cfg.base_url, "http://127.0.0.1:3737");
        assert_eq!(cfg.control_token, None);
        assert_eq!(cfg.poll_interval, Duration::from_secs(4));
        assert_eq!(cfg.health_url(), "http://127.0.0.1:3737/api/health");
        assert_eq!(cfg.pause_url(), "http://127.0.0.1:3737/api/control/pause");
        assert_eq!(cfg.drain_url(), "http://127.0.0.1:3737/api/control/drain");
    }

    #[test]
    fn strips_a_trailing_slash_from_a_custom_url() {
        let cfg = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_URL", "http://127.0.0.1:9000/")]));
        assert_eq!(cfg.base_url, "http://127.0.0.1:9000");
        assert_eq!(cfg.health_url(), "http://127.0.0.1:9000/api/health");
    }

    #[test]
    fn reads_the_control_token_when_present() {
        let cfg = DesktopConfig::resolve(env(&[("DRYDOCK_CONTROL_TOKEN", "secret")]));
        assert_eq!(cfg.control_token.as_deref(), Some("secret"));
    }

    #[test]
    fn ignores_a_blank_or_invalid_poll_interval() {
        let blank = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_POLL_SECONDS", "")]));
        assert_eq!(blank.poll_interval, Duration::from_secs(4));
        let zero = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_POLL_SECONDS", "0")]));
        assert_eq!(zero.poll_interval, Duration::from_secs(4));
        let bad = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_POLL_SECONDS", "abc")]));
        assert_eq!(bad.poll_interval, Duration::from_secs(4));
    }

    #[test]
    fn honors_a_valid_custom_poll_interval() {
        let cfg = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_POLL_SECONDS", "10")]));
        assert_eq!(cfg.poll_interval, Duration::from_secs(10));
    }
}
