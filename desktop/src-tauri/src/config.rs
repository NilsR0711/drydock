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

/// Extract the host from a URL without pulling in a URL parser: take the
/// authority between `://` and the next path/query/fragment delimiter, drop any
/// userinfo, then strip the port (handling bracketed IPv6 like `[::1]:3737`).
fn host_of(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split_once(']').map_or(rest, |(h, _)| h)
    } else {
        host_port.split_once(':').map_or(host_port, |(h, _)| h)
    };
    (!host.is_empty()).then_some(host)
}

/// Whether a URL targets only the local machine. Mirrors the server launcher's
/// `isLoopbackHost` so the shell honors the same local-only model as the
/// dashboard it wraps.
fn is_loopback_url(url: &str) -> bool {
    matches!(host_of(url), Some("127.0.0.1" | "localhost" | "::1"))
}

impl DesktopConfig {
    pub fn from_env() -> Self {
        Self::resolve(|key| std::env::var(key).ok())
    }

    /// Pure resolver injected with a lookup so the precedence rules are
    /// unit-testable without touching the process environment.
    pub fn resolve(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let configured = lookup("DRYDOCK_DESKTOP_URL")
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());
        // Drydock is single-user / local-only: refuse a non-loopback origin and
        // fall back to the default. Otherwise a misconfigured URL would make the
        // tray send DRYDOCK_CONTROL_TOKEN (and control requests) off-box.
        let base_url = match configured {
            Some(url) if is_loopback_url(&url) => url,
            _ => DEFAULT_BASE_URL.to_string(),
        };

        let control_token = lookup("DRYDOCK_CONTROL_TOKEN")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

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

    /// True when the resolved URL is the built-in default — used to skip a
    /// redundant webview navigation on the common local run.
    pub fn is_default_url(&self) -> bool {
        self.base_url == DEFAULT_BASE_URL
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
    fn accepts_a_custom_loopback_url_and_strips_a_trailing_slash() {
        let cfg = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_URL", "http://127.0.0.1:9000/")]));
        assert_eq!(cfg.base_url, "http://127.0.0.1:9000");
        assert_eq!(cfg.health_url(), "http://127.0.0.1:9000/api/health");
        assert!(!cfg.is_default_url());
        // localhost and bracketed IPv6 loopback are accepted too.
        assert_eq!(
            DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_URL", "http://localhost:8080")])).base_url,
            "http://localhost:8080"
        );
        assert_eq!(
            DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_URL", "http://[::1]:3737")])).base_url,
            "http://[::1]:3737"
        );
    }

    #[test]
    fn rejects_a_non_loopback_url_and_falls_back_to_the_default() {
        // A non-loopback origin would leak the control token off-box, so it is
        // refused in favor of the safe default.
        for url in [
            "http://192.168.1.5:3737",
            "http://example.com",
            "https://drydock.example.com:3737",
        ] {
            let cfg = DesktopConfig::resolve(env(&[("DRYDOCK_DESKTOP_URL", url)]));
            assert_eq!(cfg.base_url, "http://127.0.0.1:3737", "should reject {url}");
            assert!(cfg.is_default_url());
        }
    }

    #[test]
    fn reads_and_trims_the_control_token() {
        let cfg = DesktopConfig::resolve(env(&[("DRYDOCK_CONTROL_TOKEN", "secret")]));
        assert_eq!(cfg.control_token.as_deref(), Some("secret"));
        // Surrounding whitespace/newlines (e.g. from `$(cat tokenfile)`) are
        // trimmed so the token matches the server's check.
        let trimmed = DesktopConfig::resolve(env(&[("DRYDOCK_CONTROL_TOKEN", "  secret\n")]));
        assert_eq!(trimmed.control_token.as_deref(), Some("secret"));
        let blank = DesktopConfig::resolve(env(&[("DRYDOCK_CONTROL_TOKEN", "   ")]));
        assert_eq!(blank.control_token, None);
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
