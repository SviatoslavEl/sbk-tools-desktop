#![allow(dead_code)] // Контракт намеренно шире DisabledProvider до появления утверждённого сервера.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

use crate::database::open_database;

pub(crate) const INTELLIGENCE_SCHEMA_VERSION: &str = "1.0";
pub(crate) const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Capability {
    #[serde(rename = "tender.extract_requirements")]
    TenderExtractRequirements,
    #[serde(rename = "tender.summarize")]
    TenderSummarize,
    #[serde(rename = "tender.generate_questions")]
    TenderGenerateQuestions,
    #[serde(rename = "contract.detect_risks")]
    ContractDetectRisks,
    #[serde(rename = "experience.rank")]
    ExperienceRank,
    #[serde(rename = "team.rank")]
    TeamRank,
    #[serde(rename = "document.detect_conflicts")]
    DocumentDetectConflicts,
    #[serde(rename = "document.classify")]
    DocumentClassify,
    #[serde(rename = "application.review_completeness")]
    ApplicationReviewCompleteness,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisRequest {
    pub schema_version: String,
    pub request_id: String,
    pub capability: Capability,
    pub workspace_id: String,
    pub procurement_id: String,
    pub input_revision: i64,
    pub input_hash: String,
    pub document_version_ids: Vec<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisEvidence {
    pub document_id: String,
    pub version_id: String,
    pub sha256: String,
    pub locator: String,
    pub excerpt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisSuggestion {
    pub schema_version: String,
    pub capability: Capability,
    pub input_revision: i64,
    pub input_hash: String,
    pub suggestion_id: String,
    pub target: String,
    pub operation: String,
    pub value: Value,
    pub confidence: Option<f64>,
    pub evidence: Vec<AnalysisEvidence>,
    pub warnings: Vec<String>,
    pub incomplete: bool,
    pub server_version: String,
    pub model_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisResult {
    pub schema_version: String,
    pub request_id: String,
    pub suggestions: Vec<AnalysisSuggestion>,
}

pub(crate) trait IntelligenceProvider: Send + Sync {
    fn health(&self) -> Result<bool, String>;
    fn capabilities(&self) -> Result<Vec<Capability>, String>;
    fn submit(&self, request: &AnalysisRequest) -> Result<String, String>;
    fn status(&self, remote_job_id: &str) -> Result<JobStatus, String>;
    fn result(&self, remote_job_id: &str) -> Result<AnalysisResult, String>;
    fn cancel(&self, remote_job_id: &str) -> Result<(), String>;
}

#[derive(Default)]
pub(crate) struct DisabledProvider;

impl IntelligenceProvider for DisabledProvider {
    fn health(&self) -> Result<bool, String> {
        Ok(false)
    }

    fn capabilities(&self) -> Result<Vec<Capability>, String> {
        Ok(Vec::new())
    }

    fn submit(&self, _request: &AnalysisRequest) -> Result<String, String> {
        Err("AI-провайдер выключен. Все ручные функции доступны без него.".to_string())
    }

    fn status(&self, _remote_job_id: &str) -> Result<JobStatus, String> {
        Err("AI-провайдер выключен".to_string())
    }

    fn result(&self, _remote_job_id: &str) -> Result<AnalysisResult, String> {
        Err("AI-провайдер выключен".to_string())
    }

    fn cancel(&self, _remote_job_id: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConnectionMode {
    Disabled,
    SameComputer,
    LocalNetwork,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderConfiguration {
    pub mode: ConnectionMode,
    pub endpoint: Option<String>,
    pub secret_reference: Option<String>,
    pub certificate_fingerprint: Option<String>,
    pub allow_redirects: bool,
    pub request_timeout_seconds: u32,
    pub max_parallel_jobs: u8,
}

impl Default for ProviderConfiguration {
    fn default() -> Self {
        Self {
            mode: ConnectionMode::Disabled,
            endpoint: None,
            secret_reference: None,
            certificate_fingerprint: None,
            allow_redirects: false,
            request_timeout_seconds: 60,
            max_parallel_jobs: 1,
        }
    }
}

pub(crate) fn validate_provider_configuration(
    config: &ProviderConfiguration,
) -> Result<(), String> {
    if config.allow_redirects {
        return Err("Автоматические перенаправления запрещены".to_string());
    }
    if !(5..=600).contains(&config.request_timeout_seconds) {
        return Err("Таймаут должен быть от 5 до 600 секунд".to_string());
    }
    if !(1..=4).contains(&config.max_parallel_jobs) {
        return Err("Допускается от 1 до 4 параллельных заданий".to_string());
    }
    let Some(endpoint) = config.endpoint.as_deref() else {
        return if config.mode == ConnectionMode::Disabled {
            Ok(())
        } else {
            Err("Для выбранного режима требуется адрес сервера".to_string())
        };
    };
    if endpoint.contains('@') || endpoint.contains('#') {
        return Err("Адрес не должен содержать учётные данные или fragment".to_string());
    }
    match config.mode {
        ConnectionMode::Disabled => {
            Err("У выключенного провайдера не должно быть адреса".to_string())
        }
        ConnectionMode::SameComputer => {
            if endpoint.starts_with("unix://") || endpoint.starts_with("npipe://") {
                Ok(())
            } else {
                Err(
                    "Для сервера на этом компьютере используйте Unix socket или Windows Named Pipe"
                        .to_string(),
                )
            }
        }
        ConnectionMode::LocalNetwork => {
            if !endpoint.starts_with("https://") {
                return Err("Для сервера в локальной сети разрешён только HTTPS".to_string());
            }
            if config.secret_reference.as_deref().unwrap_or("").is_empty() {
                return Err(
                    "Секрет должен храниться в системном хранилище учётных данных".to_string(),
                );
            }
            if config
                .certificate_fingerprint
                .as_deref()
                .unwrap_or("")
                .is_empty()
            {
                return Err("Нужно закрепить сертификат локального сервера".to_string());
            }
            Ok(())
        }
    }
}

pub(crate) fn validate_request(request: &AnalysisRequest) -> Result<(), String> {
    if request.schema_version != INTELLIGENCE_SCHEMA_VERSION {
        return Err("Неподдерживаемая версия схемы AI-задания".to_string());
    }
    if request.request_id.is_empty()
        || request.workspace_id.is_empty()
        || request.procurement_id.is_empty()
    {
        return Err("В задании отсутствуют обязательные идентификаторы".to_string());
    }
    let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("AI-задание превышает безопасный размер".to_string());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalysisJobSummary {
    pub id: String,
    pub request_id: String,
    pub capability: String,
    pub procurement_id: String,
    pub status: String,
    pub attempts: i64,
    pub cancellation_requested: bool,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_code: Option<String>,
}

pub(crate) fn recover_interrupted_jobs(root: &Path) -> Result<usize, String> {
    let connection = open_database(root, "procurement")?;
    connection
        .execute(
            "UPDATE analysis_jobs SET status = 'interrupted', error_code = 'application-restarted', finished_at = datetime('now') WHERE status = 'running'",
            [],
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn list_analysis_jobs(
    root: &Path,
    procurement_id: &str,
) -> Result<Vec<AnalysisJobSummary>, String> {
    if procurement_id.is_empty() {
        return Err("Не указана закупка".to_string());
    }
    let connection = open_database(root, "procurement")?;
    let mut statement = connection.prepare(
        "SELECT id, request_id, capability, procurement_id, status, attempts, cancellation_requested, created_at, started_at, finished_at, error_code FROM analysis_jobs WHERE procurement_id = ?1 ORDER BY created_at DESC LIMIT 200",
    ).map_err(|error| error.to_string())?;
    statement
        .query_map([procurement_id], |row| {
            Ok(AnalysisJobSummary {
                id: row.get(0)?,
                request_id: row.get(1)?,
                capability: row.get(2)?,
                procurement_id: row.get(3)?,
                status: row.get(4)?,
                attempts: row.get(5)?,
                cancellation_requested: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                started_at: row.get(8)?,
                finished_at: row.get(9)?,
                error_code: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn cancel_analysis_job(
    root: &Path,
    procurement_id: &str,
    job_id: &str,
) -> Result<(), String> {
    let connection = open_database(root, "procurement")?;
    let changed = connection.execute(
        "UPDATE analysis_jobs SET cancellation_requested = 1, status = 'cancelled', finished_at = datetime('now') WHERE id = ?1 AND procurement_id = ?2 AND status IN ('queued','running','interrupted')",
        params![job_id, procurement_id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Задание не найдено или уже завершено".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::ensure_workspace;
    use uuid::Uuid;

    struct MockProvider;
    impl IntelligenceProvider for MockProvider {
        fn health(&self) -> Result<bool, String> {
            Ok(true)
        }
        fn capabilities(&self) -> Result<Vec<Capability>, String> {
            Ok(vec![Capability::TenderSummarize])
        }
        fn submit(&self, request: &AnalysisRequest) -> Result<String, String> {
            validate_request(request)?;
            Ok("remote-1".to_string())
        }
        fn status(&self, _remote_job_id: &str) -> Result<JobStatus, String> {
            Ok(JobStatus::Succeeded)
        }
        fn result(&self, request_id: &str) -> Result<AnalysisResult, String> {
            Ok(AnalysisResult {
                schema_version: INTELLIGENCE_SCHEMA_VERSION.to_string(),
                request_id: request_id.to_string(),
                suggestions: Vec::new(),
            })
        }
        fn cancel(&self, _remote_job_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn request() -> AnalysisRequest {
        AnalysisRequest {
            schema_version: INTELLIGENCE_SCHEMA_VERSION.to_string(),
            request_id: "request-1".to_string(),
            capability: Capability::TenderSummarize,
            workspace_id: "workspace-1".to_string(),
            procurement_id: "procurement-1".to_string(),
            input_revision: 1,
            input_hash: "a".repeat(64),
            document_version_ids: Vec::new(),
            payload: serde_json::json!({"text": "test"}),
        }
    }

    #[test]
    fn disabled_provider_never_blocks_offline_work() {
        let provider = DisabledProvider;
        assert!(!provider.health().unwrap());
        assert!(provider.capabilities().unwrap().is_empty());
        assert!(provider.submit(&request()).is_err());
        assert!(provider.cancel("missing").is_ok());
    }

    #[test]
    fn mock_provider_implements_the_full_contract() {
        let provider = MockProvider;
        let remote = provider.submit(&request()).unwrap();
        assert_eq!(provider.status(&remote).unwrap(), JobStatus::Succeeded);
        assert!(provider.result(&remote).unwrap().suggestions.is_empty());
        assert!(provider.cancel(&remote).is_ok());
    }

    #[test]
    fn secure_configuration_rejects_http_credentials_and_redirects() {
        let mut config = ProviderConfiguration {
            mode: ConnectionMode::LocalNetwork,
            endpoint: Some("http://192.168.1.2".to_string()),
            secret_reference: Some("keychain:item".to_string()),
            certificate_fingerprint: Some("sha256:abc".to_string()),
            ..Default::default()
        };
        assert!(validate_provider_configuration(&config).is_err());
        config.endpoint = Some("https://user:pass@server.local".to_string());
        assert!(validate_provider_configuration(&config).is_err());
        config.endpoint = Some("https://server.local".to_string());
        config.allow_redirects = true;
        assert!(validate_provider_configuration(&config).is_err());
    }

    #[test]
    fn same_computer_requires_an_os_local_transport() {
        let config = ProviderConfiguration {
            mode: ConnectionMode::SameComputer,
            endpoint: Some("unix:///run/sbk-ai.sock".to_string()),
            ..Default::default()
        };
        assert!(validate_provider_configuration(&config).is_ok());
    }

    #[test]
    fn queue_recovers_running_jobs_and_scopes_cancellation() {
        let root = std::env::temp_dir().join(format!("sbk-tools-intelligence-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let connection = open_database(&root, "procurement").expect("database");
        connection.execute(
            "INSERT INTO analysis_jobs(id, request_id, capability, procurement_id, workspace_id, input_revision, input_hash, document_versions_json, schema_version, status, created_at) VALUES ('job-1','request-1','tender.summarize','procurement-1','workspace-1',1,?1,'[]','1.0','running','2026-01-01')",
            ["a".repeat(64)],
        ).expect("insert");
        drop(connection);
        assert_eq!(recover_interrupted_jobs(&root).expect("recover"), 1);
        let jobs = list_analysis_jobs(&root, "procurement-1").expect("list");
        assert_eq!(jobs[0].status, "interrupted");
        assert!(cancel_analysis_job(&root, "other-procurement", "job-1").is_err());
        cancel_analysis_job(&root, "procurement-1", "job-1").expect("cancel");
        assert_eq!(
            list_analysis_jobs(&root, "procurement-1").unwrap()[0].status,
            "cancelled"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
