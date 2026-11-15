//! Configuração do serviço lida do ambiente (com `.env` opcional em desenvolvimento).
//!
//! Toda a validação acontece no arranque: um valor inválido faz o processo terminar
//! com uma mensagem clara, em vez de falhar mais tarde a meio de um pedido.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{0} não definida")]
    Missing(&'static str),
    #[error("{name} inválida: {value:?} ({reason})")]
    Invalid {
        name: &'static str,
        value: String,
        reason: &'static str,
    },
}

#[derive(Clone)]
pub struct Config {
    pub host: IpAddr,
    pub port: u16,
    pub database_url: String,
    pub db_max_connections: u32,
    pub db_acquire_timeout: Duration,
    pub request_timeout: Duration,
    pub cors_origins: Vec<String>,
}

// O URL da base de dados contém a palavra-passe: nunca o imprimir em logs.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database_url", &"<redacted>")
            .field("db_max_connections", &self.db_max_connections)
            .field("db_acquire_timeout", &self.db_acquire_timeout)
            .field("request_timeout", &self.request_timeout)
            .field("cors_origins", &self.cors_origins)
            .finish()
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Versão testável: recebe uma função de leitura em vez de ler o ambiente global.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let read = |key: &str| {
            get(key)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };

        let database_url = read("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?;
        if !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://")) {
            return Err(ConfigError::Invalid {
                name: "DATABASE_URL",
                value: "<redacted>".into(),
                reason: "tem de começar por postgres:// ou postgresql://",
            });
        }

        let host = match read("HOST") {
            Some(value) => value.parse().map_err(|_| ConfigError::Invalid {
                name: "HOST",
                value,
                reason: "endereço IP esperado",
            })?,
            None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        };

        let port = parse_num(read("PORT"), "PORT", 3000u16, 1, u16::MAX)?;
        let db_max_connections = parse_num(
            read("DB_MAX_CONNECTIONS"),
            "DB_MAX_CONNECTIONS",
            10u32,
            1,
            200,
        )?;
        let db_acquire_timeout = Duration::from_secs(parse_num(
            read("DB_ACQUIRE_TIMEOUT_SECS"),
            "DB_ACQUIRE_TIMEOUT_SECS",
            3u64,
            1,
            60,
        )?);
        let request_timeout = Duration::from_secs(parse_num(
            read("REQUEST_TIMEOUT_SECS"),
            "REQUEST_TIMEOUT_SECS",
            15u64,
            1,
            300,
        )?);

        let cors_origins = read("CORS_ORIGINS")
            .unwrap_or_else(|| "http://localhost:5173".to_owned())
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(|origin| {
                if origin == "*"
                    || !(origin.starts_with("http://") || origin.starts_with("https://"))
                {
                    Err(ConfigError::Invalid {
                        name: "CORS_ORIGINS",
                        value: origin.to_owned(),
                        reason: "origens explícitas http(s); \"*\" não é permitido",
                    })
                } else {
                    Ok(origin.trim_end_matches('/').to_owned())
                }
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            host,
            port,
            database_url,
            db_max_connections,
            db_acquire_timeout,
            request_timeout,
            cors_origins,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }
}

fn parse_num<T>(
    raw: Option<String>,
    name: &'static str,
    default: T,
    min: T,
    max: T,
) -> Result<T, ConfigError>
where
    T: std::str::FromStr + PartialOrd + Copy,
{
    let Some(value) = raw else { return Ok(default) };
    match value.parse::<T>() {
        Ok(n) if n >= min && n <= max => Ok(n),
        _ => Err(ConfigError::Invalid {
            name,
            value,
            reason: "número fora do intervalo permitido",
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let env: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|key| env.get(key).cloned())
    }

    const DB: (&str, &str) = ("DATABASE_URL", "postgres://u:p@localhost/db");

    #[test]
    fn defaults_are_safe() {
        let cfg = config(&[DB]).unwrap();
        assert_eq!(cfg.port, 3000);
        assert_eq!(cfg.db_max_connections, 10);
        assert_eq!(cfg.request_timeout, Duration::from_secs(15));
        assert_eq!(cfg.cors_origins, vec!["http://localhost:5173".to_string()]);
    }

    #[test]
    fn database_url_is_required_and_validated() {
        assert_eq!(
            config(&[]).unwrap_err(),
            ConfigError::Missing("DATABASE_URL")
        );
        assert!(matches!(
            config(&[("DATABASE_URL", "mysql://x")]).unwrap_err(),
            ConfigError::Invalid {
                name: "DATABASE_URL",
                ..
            }
        ));
    }

    #[test]
    fn invalid_numbers_are_rejected_instead_of_silently_defaulted() {
        assert!(config(&[DB, ("PORT", "abc")]).is_err());
        assert!(config(&[DB, ("PORT", "0")]).is_err());
        assert!(config(&[DB, ("DB_MAX_CONNECTIONS", "1000")]).is_err());
        assert_eq!(config(&[DB, ("PORT", " 8081 ")]).unwrap().port, 8081);
    }

    #[test]
    fn cors_rejects_wildcards_and_normalizes_origins() {
        assert!(config(&[DB, ("CORS_ORIGINS", "*")]).is_err());
        assert!(config(&[DB, ("CORS_ORIGINS", "example.com")]).is_err());
        let cfg = config(&[DB, ("CORS_ORIGINS", "https://a.pt/, http://localhost:5173")]).unwrap();
        assert_eq!(
            cfg.cors_origins,
            vec!["https://a.pt", "http://localhost:5173"]
        );
    }

    #[test]
    fn debug_output_never_contains_the_database_password() {
        let cfg = config(&[("DATABASE_URL", "postgres://user:supersecret@db/app")]).unwrap();
        assert!(!format!("{cfg:?}").contains("supersecret"));
    }
}
