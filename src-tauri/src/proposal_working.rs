//! Ordinary private working proposals. No issued AI capability or approval is
//! restored by these commands. This additive store is deliberately invisible
//! to the legacy generic records/drafts API and never migrates an old schema.
use crate::{AppState, database, network_diagnostics, workspace::Workspace};
use chrono::{NaiveDate, Utc};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tauri::State;
use uuid::Uuid;

const MODULE: &str = "commercial-proposals";
const DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const HISTORY_BYTES: usize = 16 * 1024 * 1024;
const AREAS: [&str; 7] = [
    "work-scope",
    "deliverables",
    "checked-facets",
    "price-vat",
    "payment",
    "parties-roles",
    "schedule",
];
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TABLES: [&str; 4] = [
    "proposal_working_documents",
    "proposal_working_history",
    "proposal_working_autosaves",
    "proposal_working_operations",
];
fn error(code: &str) -> String {
    format!(
        "{code}: рабочее КП не изменено; сохраните текущий ввод и повторно проверьте доступ/версию."
    )
}
fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|_| error("WORKING_STORAGE"))
}
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
        && (b'1'..=b'8').contains(&value.as_bytes()[14])
        && b"89ab".contains(&value.as_bytes()[19])
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn source_key(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hash)
}
fn text(value: &str, maximum: usize) -> bool {
    value.chars().count() <= maximum
        && !value
            .chars()
            .any(|c| matches!(c as u32, 0..=8 | 11 | 12 | 14..=31 | 127..=159))
}
fn stable_id(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":._-".contains(&c))
}
fn date(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|s| {
        s.len() == 10
            && !s.starts_with("0000")
            && NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == *s)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadScope {
    pub expected_root: String,
    #[serde(deserialize_with = "nullable")]
    pub expected_lease_generation: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextRequest {
    pub expected_root: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingContext {
    pub root: String,
    pub can_write: bool,
    pub lease_generation: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListRequest {
    pub scope: ReadScope,
    #[serde(deserialize_with = "nullable")]
    pub after_id: Option<String>,
    pub limit: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadRequest {
    pub scope: ReadScope,
    pub id: String,
    #[serde(deserialize_with = "nullable")]
    pub expected_storage_token: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryRequest {
    pub scope: ReadScope,
    pub history_sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MutationScope {
    pub expected_root: String,
    pub lease_generation: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumeAutosave {
    pub owner_id: String,
    pub storage_token: String,
    pub body_sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveRequest {
    pub scope: MutationScope,
    pub id: String,
    #[serde(deserialize_with = "nullable")]
    pub expected_storage_token: Option<String>,
    pub submitted_body_sha256: String,
    pub document_json: String,
    #[serde(deserialize_with = "nullable")]
    pub history_json: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub consume_autosave: Option<ConsumeAutosave>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutosaveRequest {
    pub scope: MutationScope,
    pub id: String,
    pub owner_id: String,
    #[serde(deserialize_with = "nullable")]
    pub expected_storage_token: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub base_record_storage_token: Option<String>,
    pub submitted_body_sha256: String,
    pub document_json: String,
    #[serde(deserialize_with = "nullable")]
    pub history_json: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CleanupRequest {
    pub scope: MutationScope,
    pub id: String,
    pub owner_id: String,
    pub expected_storage_token: String,
    pub submitted_body_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    #[serde(deserialize_with = "nullable")]
    number: Option<String>,
    #[serde(deserialize_with = "nullable")]
    document_date: Option<String>,
    #[serde(deserialize_with = "nullable")]
    valid_until: Option<String>,
    #[serde(deserialize_with = "nullable")]
    currency: Option<String>,
    #[serde(deserialize_with = "nullable")]
    issuer_name: Option<String>,
    #[serde(deserialize_with = "nullable")]
    recipient_name: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Layout {
    style: String,
    accent_color: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Block {
    id: String,
    frame_id: String,
    frame_index: u64,
    text: String,
    origin: String,
    included: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Section {
    area: String,
    title: String,
    blocks: Vec<Block>,
    user_text: String,
    user_text_included: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Question {
    id: String,
    area: String,
    topic: String,
    question: String,
    answer: String,
    state: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryReference {
    pub kind: String,
    pub sha256: String,
    pub bytes: usize,
    pub source_snapshot_key: String,
    pub structure_snapshot_key: String,
    pub plan_key: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkingDocument {
    kind: String,
    schema_version: u64,
    id: String,
    revision: u64,
    title: String,
    metadata: Metadata,
    layout: Layout,
    sections: Vec<Section>,
    questions: Vec<Question>,
    historical_source: HistoryReference,
}
fn document(raw: &str, id: &str, submitted_sha: &str) -> Result<WorkingDocument, String> {
    if raw.len() > DOCUMENT_BYTES
        || !uuid(id)
        || !hash(submitted_sha)
        || digest(raw) != submitted_sha
    {
        return Err(error("WORKING_INVALID_BODY"));
    }
    // Direct typed deserialization rejects duplicate/missing/extra fields;
    // parsing through Value first would lose duplicate-key information.
    let doc: WorkingDocument =
        serde_json::from_str(raw).map_err(|_| error("WORKING_INVALID_BODY"))?;
    let m = &doc.metadata;
    let h = &doc.historical_source;
    let mut ids = HashSet::new();
    let optional_text = |v: &Option<String>, n| v.as_ref().is_none_or(|v| text(v, n));
    if doc.kind != "proposal-working-document"
        || ![1, 2].contains(&doc.schema_version)
        || doc.id != id
        || doc.revision > SAFE_INTEGER
        || !text(&doc.title, 500)
        || !optional_text(&m.number, 200)
        || !date(&m.document_date)
        || !date(&m.valid_until)
        || !optional_text(&m.currency, 80)
        || !optional_text(&m.issuer_name, 2000)
        || !optional_text(&m.recipient_name, 2000)
        || !["standard", "compact"].contains(&doc.layout.style.as_str())
        || doc.layout.accent_color.len() != 7
        || !doc.layout.accent_color.starts_with('#')
        || !doc.layout.accent_color.as_bytes()[1..]
            .iter()
            .all(u8::is_ascii_hexdigit)
        || doc.sections.len() != 7
        || doc.questions.len() > 256
        || h.kind != "unvalidated-history"
        || !hash(&h.sha256)
        || !(1..=HISTORY_BYTES).contains(&h.bytes)
        || !source_key(&h.source_snapshot_key)
        || !source_key(&h.structure_snapshot_key)
        || !source_key(&h.plan_key)
    {
        return Err(error("WORKING_INVALID_BODY"));
    }
    let model_origin = if doc.schema_version == 1 {
        "historical-model-answer"
    } else {
        "formatted-model-facts"
    };
    for (at, section) in doc.sections.iter().enumerate() {
        if section.area != AREAS[at]
            || !text(&section.title, 500)
            || !text(&section.user_text, 20_000)
            || section.blocks.len() > 64
        {
            return Err(error("WORKING_INVALID_BODY"));
        }
        for block in &section.blocks {
            if !stable_id(&block.id)
                || !ids.insert(block.id.clone())
                || !stable_id(&block.frame_id)
                || block.frame_index > 63
                || !text(&block.text, 20_000)
                || ![model_origin, "user-edit-unreviewed"].contains(&block.origin.as_str())
            {
                return Err(error("WORKING_INVALID_BODY"));
            }
        }
    }
    ids.clear();
    for q in &doc.questions {
        if !stable_id(&q.id)
            || !ids.insert(q.id.clone())
            || !AREAS.contains(&q.area.as_str())
            || !text(&q.topic, 200)
            || !text(&q.question, 20_000)
            || !text(&q.answer, 20_000)
            || !["open", "answered", "resolved"].contains(&q.state.as_str())
        {
            return Err(error("WORKING_INVALID_BODY"));
        }
    }
    Ok(doc)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Summary {
    pub id: String,
    pub title: String,
    pub storage_token: Option<String>,
    pub document_revision: u64,
    pub body_sha256: String,
    pub history_sha256: String,
    pub updated_at: String,
    pub autosave_available: bool,
    pub record_saved: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SummaryPage {
    pub root: String,
    pub items: Vec<Summary>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub summary: Summary,
    pub document_json: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutosaveSnapshot {
    pub id: String,
    pub owner_id: String,
    pub storage_token: String,
    pub base_record_storage_token: Option<String>,
    pub body_sha256: String,
    pub document_revision: u64,
    pub history_sha256: String,
    pub consumed: bool,
    pub document_json: Option<String>,
    pub updated_at: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadResult {
    pub root: String,
    pub saved: Option<Snapshot>,
    pub autosave: Option<AutosaveSnapshot>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryResult {
    pub root: String,
    pub kind: String,
    pub sha256: String,
    pub bytes: usize,
    pub history_json: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumedAutosave {
    pub previous_storage_token: String,
    pub storage_token: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub operation_id: String,
    pub root: String,
    pub id: String,
    pub action: String,
    #[serde(deserialize_with = "nullable")]
    pub expected_storage_token: Option<String>,
    pub storage_token: String,
    pub submitted_body_sha256: String,
    #[serde(deserialize_with = "nullable")]
    pub document_revision: Option<u64>,
    #[serde(deserialize_with = "nullable")]
    pub history_sha256: Option<String>,
    pub updated_at: String,
    #[serde(deserialize_with = "nullable")]
    pub consumed_autosave: Option<ConsumedAutosave>,
}

fn root(workspace: &Workspace) -> Result<String, String> {
    workspace
        .root
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| error("WORKING_ROOT"))
}
fn guard_root(workspace: &Workspace, expected: &str) -> Result<(), String> {
    if expected.len() > 4096 || root(workspace)? != expected {
        Err(error("WORKING_STALE_ROOT"))
    } else {
        Ok(())
    }
}
fn guard_editor(workspace: &Workspace, expected: &str) -> Result<(), String> {
    if !uuid(expected) {
        return Err(error("WORKING_STALE_LEASE"));
    }
    workspace.require_editor()?;
    if !workspace.is_editor()
        || workspace
            .editor_state()
            .presence
            .is_none_or(|presence| presence.token != expected)
    {
        return Err(error("WORKING_STALE_LEASE"));
    }
    Ok(())
}
/// Context freshness ONLY, not renderer/export approval. Caller must hold the
/// AppState maintenance lock and network operation permit. Recheck after await.
pub(crate) fn read_admission(
    state: &AppState,
    scope: &ReadScope,
) -> Result<Arc<Workspace>, String> {
    let workspace = state.active_workspace()?;
    guard_root(&workspace, &scope.expected_root)?;
    match &scope.expected_lease_generation {
        Some(token) => guard_editor(&workspace, token)?,
        None if workspace.is_editor() => return Err(error("WORKING_STALE_LEASE")),
        None => {}
    }
    Ok(workspace)
}
fn write_admission(state: &AppState, scope: &MutationScope) -> Result<Arc<Workspace>, String> {
    if !uuid(&scope.operation_id) {
        return Err(error("WORKING_OPERATION"));
    }
    let workspace = state.active_workspace()?;
    guard_root(&workspace, &scope.expected_root)?;
    guard_editor(&workspace, &scope.lease_generation)?;
    Ok(workspace)
}

fn feature_state(connection: &Connection) -> Result<bool, String> {
    let mut count = 0;
    for table in TABLES {
        count += sql(connection.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get::<_, i64>(0),
        ))?;
    }
    if count == 0 {
        Ok(false)
    } else if count == TABLES.len() as i64 {
        Ok(true)
    } else {
        Err(error("WORKING_CORRUPT_SCHEMA"))
    }
}
fn schema(transaction: &Transaction<'_>) -> Result<(), String> {
    if feature_state(transaction)? {
        return Ok(());
    }
    sql(transaction.execute_batch("CREATE TABLE IF NOT EXISTS proposal_working_history (
        sha256 TEXT PRIMARY KEY NOT NULL, bytes INTEGER NOT NULL, history_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposal_working_documents (
        id TEXT PRIMARY KEY NOT NULL, storage_token TEXT NOT NULL, title TEXT NOT NULL,
        body_json TEXT NOT NULL, body_sha256 TEXT NOT NULL, document_revision INTEGER NOT NULL,
        history_sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposal_working_autosaves (
        id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, storage_token TEXT NOT NULL, title TEXT NOT NULL,
        base_record_token TEXT, body_json TEXT, body_sha256 TEXT NOT NULL,
        document_revision INTEGER NOT NULL, history_sha256 TEXT NOT NULL,
        consumed INTEGER NOT NULL CHECK(consumed IN (0,1)), updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposal_working_operations (
        operation_id TEXT PRIMARY KEY NOT NULL, request_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_sha256 TEXT NOT NULL);"))
}
fn read_connection(workspace: &Workspace) -> Result<Option<Connection>, String> {
    let connection = crate::open_optional_database_read_only(&workspace.root, MODULE)?;
    if let Some(connection) = &connection {
        let version: i64 = sql(connection.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
        if version > database::SCHEMA_VERSION {
            return Err(error("WORKING_FUTURE_SCHEMA"));
        }
    }
    Ok(connection)
}
fn write_connection(
    workspace: &Workspace,
    fresh: impl Fn() -> Result<(), String>,
) -> Result<Connection, String> {
    let path = database::database_path(&workspace.root, MODULE)?;
    // Module setup belongs to the ordinary application setup, not to a working
    // document mutation. In particular no independent initializer may commit
    // base DDL after our fresh-lease check but outside our guarded transaction.
    if !path.try_exists().map_err(|_| error("WORKING_STORAGE"))? {
        return Err(error("WORKING_MODULE_NOT_INITIALIZED"));
    }
    fresh()?;
    let connection = sql(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ))?;
    let version: i64 = sql(connection.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
    if version != database::SCHEMA_VERSION {
        return Err(error("WORKING_SCHEMA_REQUIRES_EXPLICIT_APP_SETUP"));
    }
    let mode: String = sql(connection.query_row("PRAGMA journal_mode", [], |row| row.get(0)))?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err(error("WORKING_UNSAFE_JOURNAL"));
    }
    sql(connection.busy_timeout(Duration::from_secs(8)))?;
    sql(connection.pragma_update(None, "synchronous", "FULL"))?;
    Ok(connection)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoricalEnvelope {
    version: u64,
    purpose: String,
    plan_key: String,
    source_snapshot_key: String,
    structure_snapshot_key: String,
    source_snapshot: Vec<Value>,
    owners: Vec<Value>,
    sections: Vec<Value>,
    clarification_questions: Vec<Value>,
    unvalidated_details: Vec<Value>,
    audit: Value,
    run_coverage: Value,
    approved_content: Vec<Value>,
    ready_for_client: bool,
    human_approval: bool,
    semantic_truth: String,
    completeness: String,
    provider_authenticity: String,
}
struct UniqueJson;
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> serde::de::Visitor<'de> for UniqueVisitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<UniqueJson, E> {
                Ok(UniqueJson)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<UniqueJson, E> {
                Ok(UniqueJson)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<UniqueJson, E> {
                Ok(UniqueJson)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<UniqueJson, E> {
                Ok(UniqueJson)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<UniqueJson, E> {
                Ok(UniqueJson)
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<UniqueJson, E> {
                Ok(UniqueJson)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> Result<UniqueJson, A::Error> {
                while a.next_element::<UniqueJson>()?.is_some() {}
                Ok(UniqueJson)
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> Result<UniqueJson, A::Error> {
                let mut keys = HashSet::new();
                while let Some(key) = a.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(serde::de::Error::custom("duplicate JSON key"));
                    }
                    a.next_value::<UniqueJson>()?;
                }
                Ok(UniqueJson)
            }
        }
        d.deserialize_any(UniqueVisitor)
    }
}
fn validate_history(raw: &str, reference: &HistoryReference) -> Result<(), String> {
    if reference.kind != "unvalidated-history"
        || !hash(&reference.sha256)
        || !source_key(&reference.source_snapshot_key)
        || !source_key(&reference.structure_snapshot_key)
        || !source_key(&reference.plan_key)
        || raw.len() != reference.bytes
        || raw.len() > HISTORY_BYTES
        || digest(raw) != reference.sha256
    {
        return Err(error("WORKING_HISTORY_MISMATCH"));
    }
    serde_json::from_str::<UniqueJson>(raw).map_err(|_| error("WORKING_INVALID_HISTORY"))?;
    let h: HistoricalEnvelope =
        serde_json::from_str(raw).map_err(|_| error("WORKING_INVALID_HISTORY"))?;
    let known_envelope = (h.version == 1 && h.purpose == "unapproved-model-whole-proposal-draft")
        || (h.version == 2 && h.purpose == "unapproved-model-fact-proposal-draft");
    if !known_envelope
        || h.plan_key != reference.plan_key
        || h.source_snapshot_key != reference.source_snapshot_key
        || h.structure_snapshot_key != reference.structure_snapshot_key
        || h.ready_for_client
        || h.human_approval
        || !h.approved_content.is_empty()
        || h.semantic_truth != "not-proven"
        || h.completeness != "not-assessed"
        || h.provider_authenticity != "not-attested"
        || h.sections.len() != 7
        || h.owners.len() > 10_000
        || h.source_snapshot.len() > 64
        || h.clarification_questions.len() > 256
        || h.unvalidated_details.len() > 7
        || !h.audit.is_object()
        || !h.run_coverage.is_object()
    {
        return Err(error("WORKING_INVALID_HISTORY"));
    }
    // Nested source/audit values are opaque HISTORICAL DATA, not issued proof.
    Ok(())
}
fn history(
    transaction: &Transaction<'_>,
    reference: &HistoryReference,
    supplied: Option<&str>,
) -> Result<(), String> {
    if let Some(raw) = supplied {
        validate_history(raw, reference)?;
    }
    let existing: Option<(i64, Option<String>)> = sql(transaction.query_row("SELECT bytes,CASE WHEN length(CAST(history_json AS BLOB))<=?2 THEN history_json ELSE NULL END FROM proposal_working_history WHERE sha256=?1", params![reference.sha256, HISTORY_BYTES as i64], |row| Ok((row.get(0)?, row.get(1)?))).optional())?;
    match existing {
        Some((bytes, raw)) => {
            let raw = raw.ok_or_else(|| error("WORKING_HISTORY_MISMATCH"))?;
            if bytes != reference.bytes as i64 || supplied.is_some_and(|value| value != raw) {
                return Err(error("WORKING_HISTORY_MISMATCH"));
            }
            validate_history(&raw, reference)
        }
        None => {
            let raw = supplied.ok_or_else(|| error("WORKING_HISTORY_MISSING"))?;
            sql(transaction.execute(
                "INSERT INTO proposal_working_history(sha256,bytes,history_json) VALUES(?1,?2,?3)",
                params![reference.sha256, reference.bytes as i64, raw],
            ))?;
            Ok(())
        }
    }
}
fn record_token(connection: &Connection, id: &str) -> Result<Option<String>, String> {
    sql(connection.query_row("SELECT CASE WHEN length(CAST(storage_token AS BLOB))=36 THEN storage_token ELSE '' END FROM proposal_working_documents WHERE id=?1", [id], |row| row.get(0)).optional())
}
fn check_token(actual: Option<&str>, expected: Option<&str>) -> Result<(), String> {
    if expected.is_some_and(|token| !uuid(token))
        || actual.is_some_and(|token| !uuid(token))
        || actual != expected
    {
        Err(error("WORKING_CAS_CONFLICT"))
    } else {
        Ok(())
    }
}
fn legacy_collision(connection: &Connection, id: &str) -> Result<(), String> {
    let exists: bool = sql(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM records WHERE id=?1)",
        [id],
        |row| row.get(0),
    ))?;
    if exists {
        Err(error("WORKING_LEGACY_ID_COLLISION"))
    } else {
        Ok(())
    }
}
fn previous_receipt(
    connection: &Connection,
    operation: &str,
    request_sha: &str,
) -> Result<Option<Receipt>, String> {
    let row: Option<(String, Option<String>, String)> = sql(connection.query_row("SELECT CASE WHEN length(CAST(request_sha256 AS BLOB))=64 THEN request_sha256 ELSE '' END,CASE WHEN length(CAST(receipt_json AS BLOB))<=65536 THEN receipt_json ELSE NULL END,CASE WHEN length(CAST(receipt_sha256 AS BLOB))=64 THEN receipt_sha256 ELSE '' END FROM proposal_working_operations WHERE operation_id=?1", [operation], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional())?;
    row.map(|(sha, json, stored_sha)| {
        if sha != request_sha {
            return Err(error("WORKING_OPERATION_COLLISION"));
        }
        let json = json.ok_or_else(|| error("WORKING_CORRUPT_RECEIPT"))?;
        if digest(&json) != stored_sha {
            return Err(error("WORKING_CORRUPT_RECEIPT"));
        }
        let receipt: Receipt =
            serde_json::from_str(&json).map_err(|_| error("WORKING_CORRUPT_RECEIPT"))?;
        if receipt.operation_id != operation
            || !uuid(&receipt.id)
            || !uuid(&receipt.storage_token)
            || !hash(&receipt.submitted_body_sha256)
            || receipt
                .expected_storage_token
                .as_ref()
                .is_some_and(|v| !uuid(v))
            || receipt.document_revision.is_some_and(|v| v > SAFE_INTEGER)
            || receipt.history_sha256.as_ref().is_some_and(|v| !hash(v))
            || receipt.consumed_autosave.as_ref().is_some_and(|v| {
                !uuid(&v.previous_storage_token)
                    || !uuid(&v.storage_token)
                    || v.previous_storage_token == v.storage_token
            })
            || receipt.updated_at.len() > 100
            || chrono::DateTime::parse_from_rfc3339(&receipt.updated_at).is_err()
        {
            return Err(error("WORKING_CORRUPT_RECEIPT"));
        }
        Ok(receipt)
    })
    .transpose()
}
fn remember(
    transaction: &Transaction<'_>,
    fingerprint: &str,
    receipt: &Receipt,
) -> Result<(), String> {
    let json = serde_json::to_string(receipt).map_err(|_| error("WORKING_STORAGE"))?;
    sql(transaction.execute("INSERT INTO proposal_working_operations(operation_id,request_sha256,receipt_json,receipt_sha256) VALUES(?1,?2,?3,?4)", params![receipt.operation_id, fingerprint, json, digest(&json)]))?;
    Ok(())
}
fn receipt_identity(
    receipt: &Receipt,
    root: &str,
    id: &str,
    action: &str,
    expected: Option<&str>,
    body: &str,
) -> Result<(), String> {
    if receipt.root != root
        || receipt.id != id
        || receipt.action != action
        || receipt.expected_storage_token.as_deref() != expected
        || receipt.submitted_body_sha256 != body
    {
        return Err(error("WORKING_CORRUPT_RECEIPT"));
    }
    Ok(())
}
fn submission(
    raw: &str,
    id: &str,
    sha: &str,
    history_json: Option<&str>,
    expected: Option<&str>,
) -> Result<WorkingDocument, String> {
    if expected.is_some_and(|value| !uuid(value)) {
        return Err(error("WORKING_CAS_CONFLICT"));
    }
    let doc = document(raw, id, sha)?;
    if let Some(history_json) = history_json {
        validate_history(history_json, &doc.historical_source)?;
    }
    Ok(doc)
}
fn request_hash(value: Value) -> String {
    digest(&value.to_string())
}
fn consume(
    transaction: &Transaction<'_>,
    id: &str,
    expected: &ConsumeAutosave,
    now: &str,
) -> Result<ConsumedAutosave, String> {
    if !uuid(&expected.owner_id) || !uuid(&expected.storage_token) || !hash(&expected.body_sha256) {
        return Err(error("WORKING_AUTOSAVE_OWNER"));
    }
    let next = Uuid::new_v4().to_string();
    let changed = sql(transaction.execute("UPDATE proposal_working_autosaves SET storage_token=?1,consumed=1,updated_at=?2 WHERE id=?3 AND owner_id=?4 AND storage_token=?5 AND body_sha256=?6 AND consumed=0", params![next, now, id, expected.owner_id, expected.storage_token, expected.body_sha256]))?;
    if changed != 1 {
        return Err(error("WORKING_CAS_CONFLICT"));
    }
    Ok(ConsumedAutosave {
        previous_storage_token: expected.storage_token.clone(),
        storage_token: next,
    })
}
fn save_transaction(
    connection: &mut Connection,
    root: &str,
    request: &SaveRequest,
    before_commit: impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    let doc = submission(
        &request.document_json,
        &request.id,
        &request.submitted_body_sha256,
        request.history_json.as_deref(),
        request.expected_storage_token.as_deref(),
    )?;
    let fingerprint = request_hash(
        serde_json::json!({"action":"saved","root":root,"id":request.id,"expectedStorageToken":request.expected_storage_token,"bodySha256":request.submitted_body_sha256,"historySha256":doc.historical_source.sha256,"consumeAutosave":request.consume_autosave}),
    );
    let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    before_commit()?;
    schema(&tx)?;
    if let Some(receipt) = previous_receipt(&tx, &request.scope.operation_id, &fingerprint)? {
        receipt_identity(
            &receipt,
            root,
            &request.id,
            "saved",
            request.expected_storage_token.as_deref(),
            &request.submitted_body_sha256,
        )?;
        if receipt.document_revision != Some(doc.revision)
            || receipt.history_sha256.as_deref() != Some(doc.historical_source.sha256.as_str())
            || receipt
                .consumed_autosave
                .as_ref()
                .map(|v| v.previous_storage_token.as_str())
                != request
                    .consume_autosave
                    .as_ref()
                    .map(|v| v.storage_token.as_str())
        {
            return Err(error("WORKING_CORRUPT_RECEIPT"));
        }
        before_commit()?;
        return Ok(receipt);
    }
    legacy_collision(&tx, &request.id)?;
    let actual = record_token(&tx, &request.id)?;
    check_token(actual.as_deref(), request.expected_storage_token.as_deref())?;
    if actual.is_none() && request.consume_autosave.is_none() {
        let recovery_exists: bool = sql(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM proposal_working_autosaves WHERE id=?1)",
            [&request.id],
            |row| row.get(0),
        ))?;
        if recovery_exists {
            return Err(error("WORKING_AUTOSAVE_OWNER"));
        }
    }
    history(&tx, &doc.historical_source, request.history_json.as_deref())?;
    let now = Utc::now().to_rfc3339();
    let token = Uuid::new_v4().to_string();
    if actual.is_none() {
        sql(tx.execute("INSERT INTO proposal_working_documents(id,storage_token,title,body_json,body_sha256,document_revision,history_sha256,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![request.id, token, doc.title, request.document_json, request.submitted_body_sha256, doc.revision as i64, doc.historical_source.sha256, now]))?;
    } else {
        let changed = sql(tx.execute("UPDATE proposal_working_documents SET storage_token=?1,title=?2,body_json=?3,body_sha256=?4,document_revision=?5,history_sha256=?6,updated_at=?7 WHERE id=?8 AND storage_token=?9", params![token, doc.title, request.document_json, request.submitted_body_sha256, doc.revision as i64, doc.historical_source.sha256, now, request.id, actual]))?;
        if changed != 1 {
            return Err(error("WORKING_CAS_CONFLICT"));
        }
    }
    let consumed = request
        .consume_autosave
        .as_ref()
        .map(|value| consume(&tx, &request.id, value, &now))
        .transpose()?;
    let receipt = Receipt {
        operation_id: request.scope.operation_id.clone(),
        root: root.to_owned(),
        id: request.id.clone(),
        action: "saved".into(),
        expected_storage_token: request.expected_storage_token.clone(),
        storage_token: token,
        submitted_body_sha256: request.submitted_body_sha256.clone(),
        document_revision: Some(doc.revision),
        history_sha256: Some(doc.historical_source.sha256),
        updated_at: now,
        consumed_autosave: consumed,
    };
    remember(&tx, &fingerprint, &receipt)?;
    before_commit()?;
    sql(tx.commit())?;
    Ok(receipt)
}
fn autosave_transaction(
    connection: &mut Connection,
    root: &str,
    request: &AutosaveRequest,
    before_commit: impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    let doc = submission(
        &request.document_json,
        &request.id,
        &request.submitted_body_sha256,
        request.history_json.as_deref(),
        request.expected_storage_token.as_deref(),
    )?;
    if !uuid(&request.owner_id)
        || request
            .base_record_storage_token
            .as_ref()
            .is_some_and(|v| !uuid(v))
    {
        return Err(error("WORKING_AUTOSAVE_OWNER"));
    }
    let fingerprint = request_hash(
        serde_json::json!({"action":"autosaved","root":root,"id":request.id,"ownerId":request.owner_id,"expectedStorageToken":request.expected_storage_token,"baseRecordStorageToken":request.base_record_storage_token,"bodySha256":request.submitted_body_sha256,"historySha256":doc.historical_source.sha256}),
    );
    let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    before_commit()?;
    schema(&tx)?;
    if let Some(receipt) = previous_receipt(&tx, &request.scope.operation_id, &fingerprint)? {
        receipt_identity(
            &receipt,
            root,
            &request.id,
            "autosaved",
            request.expected_storage_token.as_deref(),
            &request.submitted_body_sha256,
        )?;
        if receipt.document_revision != Some(doc.revision)
            || receipt.history_sha256.as_deref() != Some(doc.historical_source.sha256.as_str())
            || receipt.consumed_autosave.is_some()
        {
            return Err(error("WORKING_CORRUPT_RECEIPT"));
        }
        before_commit()?;
        return Ok(receipt);
    }
    legacy_collision(&tx, &request.id)?;
    check_token(
        record_token(&tx, &request.id)?.as_deref(),
        request.base_record_storage_token.as_deref(),
    )?;
    let old: Option<(String, String)> = sql(tx.query_row("SELECT CASE WHEN length(CAST(storage_token AS BLOB))=36 THEN storage_token ELSE '' END,CASE WHEN length(CAST(owner_id AS BLOB))=36 THEN owner_id ELSE '' END FROM proposal_working_autosaves WHERE id=?1", [&request.id], |row| Ok((row.get(0)?, row.get(1)?))).optional())?;
    check_token(
        old.as_ref().map(|v| v.0.as_str()),
        request.expected_storage_token.as_deref(),
    )?;
    if old.as_ref().is_some_and(|v| v.1 != request.owner_id) {
        return Err(error("WORKING_AUTOSAVE_OWNER"));
    }
    history(&tx, &doc.historical_source, request.history_json.as_deref())?;
    let now = Utc::now().to_rfc3339();
    let token = Uuid::new_v4().to_string();
    if old.is_none() {
        sql(tx.execute("INSERT INTO proposal_working_autosaves(id,owner_id,storage_token,title,base_record_token,body_json,body_sha256,document_revision,history_sha256,consumed,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10)", params![request.id, request.owner_id, token, doc.title, request.base_record_storage_token, request.document_json, request.submitted_body_sha256, doc.revision as i64, doc.historical_source.sha256, now]))?;
    } else {
        let changed = sql(tx.execute("UPDATE proposal_working_autosaves SET storage_token=?1,title=?2,base_record_token=?3,body_json=?4,body_sha256=?5,document_revision=?6,history_sha256=?7,consumed=0,updated_at=?8 WHERE id=?9 AND storage_token=?10", params![token, doc.title, request.base_record_storage_token, request.document_json, request.submitted_body_sha256, doc.revision as i64, doc.historical_source.sha256, now, request.id, request.expected_storage_token]))?;
        if changed != 1 {
            return Err(error("WORKING_CAS_CONFLICT"));
        }
    }
    let receipt = Receipt {
        operation_id: request.scope.operation_id.clone(),
        root: root.to_owned(),
        id: request.id.clone(),
        action: "autosaved".into(),
        expected_storage_token: request.expected_storage_token.clone(),
        storage_token: token,
        submitted_body_sha256: request.submitted_body_sha256.clone(),
        document_revision: Some(doc.revision),
        history_sha256: Some(doc.historical_source.sha256),
        updated_at: now,
        consumed_autosave: None,
    };
    remember(&tx, &fingerprint, &receipt)?;
    before_commit()?;
    sql(tx.commit())?;
    Ok(receipt)
}
fn cleanup_transaction(
    connection: &mut Connection,
    root: &str,
    request: &CleanupRequest,
    before_commit: impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    if !uuid(&request.id)
        || !uuid(&request.owner_id)
        || !uuid(&request.expected_storage_token)
        || !hash(&request.submitted_body_sha256)
    {
        return Err(error("WORKING_INVALID_BODY"));
    }
    let fingerprint = request_hash(
        serde_json::json!({"action":"cleaned","root":root,"id":request.id,"ownerId":request.owner_id,"expectedStorageToken":request.expected_storage_token,"bodySha256":request.submitted_body_sha256}),
    );
    let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    before_commit()?;
    schema(&tx)?;
    if let Some(receipt) = previous_receipt(&tx, &request.scope.operation_id, &fingerprint)? {
        receipt_identity(
            &receipt,
            root,
            &request.id,
            "cleaned",
            Some(&request.expected_storage_token),
            &request.submitted_body_sha256,
        )?;
        if receipt.document_revision.is_some()
            || receipt.history_sha256.is_some()
            || receipt.consumed_autosave.is_some()
            || receipt.storage_token == request.expected_storage_token
        {
            return Err(error("WORKING_CORRUPT_RECEIPT"));
        }
        before_commit()?;
        return Ok(receipt);
    }
    legacy_collision(&tx, &request.id)?;
    let now = Utc::now().to_rfc3339();
    let changed = consume(
        &tx,
        &request.id,
        &ConsumeAutosave {
            owner_id: request.owner_id.clone(),
            storage_token: request.expected_storage_token.clone(),
            body_sha256: request.submitted_body_sha256.clone(),
        },
        &now,
    )?;
    // Keep a CAS tombstone. Deleting this row would allow delayed create-null
    // autosaves to resurrect an older form (ABA). No legacy row is deleted.
    sql(tx.execute(
        "UPDATE proposal_working_autosaves SET body_json=NULL WHERE id=?1 AND storage_token=?2",
        params![request.id, changed.storage_token],
    ))?;
    let receipt = Receipt {
        operation_id: request.scope.operation_id.clone(),
        root: root.to_owned(),
        id: request.id.clone(),
        action: "cleaned".into(),
        expected_storage_token: Some(request.expected_storage_token.clone()),
        storage_token: changed.storage_token,
        submitted_body_sha256: request.submitted_body_sha256.clone(),
        document_revision: None,
        history_sha256: None,
        updated_at: now,
        consumed_autosave: None,
    };
    remember(&tx, &fingerprint, &receipt)?;
    before_commit()?;
    sql(tx.commit())?;
    Ok(receipt)
}

fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Summary> {
    Ok(Summary {
        id: row.get(0)?,
        title: row.get(1)?,
        storage_token: row.get(2)?,
        document_revision: row.get(3)?,
        body_sha256: row.get(4)?,
        history_sha256: row.get(5)?,
        updated_at: row.get(6)?,
        autosave_available: row.get(7)?,
        record_saved: row.get(8)?,
    })
}
fn validate_summary(value: &Summary) -> Result<(), String> {
    if !uuid(&value.id)
        || !text(&value.title, 500)
        || value.storage_token.as_ref().is_some_and(|v| !uuid(v))
        || value.record_saved != value.storage_token.is_some()
        || value.document_revision > SAFE_INTEGER
        || !hash(&value.body_sha256)
        || !hash(&value.history_sha256)
        || value.updated_at.len() > 100
        || chrono::DateTime::parse_from_rfc3339(&value.updated_at).is_err()
    {
        return Err(error("WORKING_CORRUPT_BODY"));
    }
    Ok(())
}
fn list_on(connection: &Connection, request: &ListRequest) -> Result<Vec<Summary>, String> {
    // No body_json/history_json is selected by this summary query, including
    // unsaved recovery entries. They are explicitly NOT record-save success.
    let mut statement = sql(connection.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE '' END,CASE WHEN length(CAST(title AS BLOB))<=2000 THEN title ELSE NULL END,
      CASE WHEN storage_token IS NULL THEN NULL WHEN length(CAST(storage_token AS BLOB))=36 THEN storage_token ELSE '' END,
      document_revision,CASE WHEN length(CAST(body_sha256 AS BLOB))=64 THEN body_sha256 ELSE '' END,CASE WHEN length(CAST(history_sha256 AS BLOB))=64 THEN history_sha256 ELSE '' END,
      CASE WHEN length(CAST(updated_at AS BLOB))<=100 THEN updated_at ELSE '' END,autosave_available,record_saved FROM (
      SELECT d.id,d.title,d.storage_token,d.document_revision,d.body_sha256,d.history_sha256,d.updated_at,
        EXISTS(SELECT 1 FROM proposal_working_autosaves a WHERE a.id=d.id AND a.consumed=0) AS autosave_available,1 AS record_saved FROM proposal_working_documents d
      UNION ALL SELECT a.id,a.title,NULL,a.document_revision,a.body_sha256,a.history_sha256,a.updated_at,1,0 FROM proposal_working_autosaves a
        WHERE a.consumed=0 AND NOT EXISTS(SELECT 1 FROM proposal_working_documents d WHERE d.id=a.id)
      ) WHERE id>?1 ORDER BY id ASC LIMIT ?2"))?;
    let values = sql(statement.query_map(
        params![request.after_id.as_deref().unwrap_or(""), request.limit + 1],
        summary_row,
    ))?;
    let values = sql(values.collect::<rusqlite::Result<Vec<_>>>())?;
    for value in &values {
        validate_summary(value)?;
    }
    Ok(values)
}
fn read_on(connection: &Connection, request: &ReadRequest) -> Result<ReadResult, String> {
    let row = sql(connection.query_row("SELECT d.id,CASE WHEN length(CAST(d.title AS BLOB))<=2000 THEN d.title ELSE NULL END,CASE WHEN length(CAST(d.storage_token AS BLOB))=36 THEN d.storage_token ELSE '' END,d.document_revision,
      CASE WHEN length(CAST(d.body_sha256 AS BLOB))=64 THEN d.body_sha256 ELSE '' END,CASE WHEN length(CAST(d.history_sha256 AS BLOB))=64 THEN d.history_sha256 ELSE '' END,
      CASE WHEN length(CAST(d.updated_at AS BLOB))<=100 THEN d.updated_at ELSE '' END,EXISTS(SELECT 1 FROM proposal_working_autosaves a WHERE a.id=d.id AND a.consumed=0),1,
      CASE WHEN length(CAST(d.body_json AS BLOB))<=?2 THEN d.body_json ELSE NULL END FROM proposal_working_documents d WHERE d.id=?1", params![request.id, DOCUMENT_BYTES as i64], |row| Ok((summary_row(row)?, row.get::<_, Option<String>>(9)?))).optional())?;
    let saved = row
        .map(|(summary, raw)| {
            validate_summary(&summary)?;
            let raw = raw.ok_or_else(|| error("WORKING_CORRUPT_BODY"))?;
            let doc = document(&raw, &summary.id, &summary.body_sha256)?;
            if doc.revision != summary.document_revision
                || doc.title != summary.title
                || doc.historical_source.sha256 != summary.history_sha256
            {
                return Err(error("WORKING_CORRUPT_BODY"));
            }
            Ok(Snapshot {
                summary,
                document_json: raw,
            })
        })
        .transpose()?;
    if let Some(expected) = &request.expected_storage_token {
        check_token(
            saved
                .as_ref()
                .and_then(|v| v.summary.storage_token.as_deref()),
            Some(expected),
        )?;
    }
    let row: Option<(AutosaveSnapshot, bool, i64)> = sql(connection.query_row("SELECT CASE WHEN length(CAST(owner_id AS BLOB))=36 THEN owner_id ELSE '' END,CASE WHEN length(CAST(storage_token AS BLOB))=36 THEN storage_token ELSE '' END,
      CASE WHEN base_record_token IS NULL THEN NULL WHEN length(CAST(base_record_token AS BLOB))=36 THEN base_record_token ELSE '' END,
      CASE WHEN length(CAST(body_sha256 AS BLOB))=64 THEN body_sha256 ELSE '' END,document_revision,CASE WHEN length(CAST(history_sha256 AS BLOB))=64 THEN history_sha256 ELSE '' END,
      consumed,CASE WHEN length(CAST(body_json AS BLOB))<=?2 THEN body_json ELSE NULL END,CASE WHEN length(CAST(updated_at AS BLOB))<=100 THEN updated_at ELSE '' END,body_json IS NULL
      FROM proposal_working_autosaves WHERE id=?1", params![request.id, DOCUMENT_BYTES as i64], |row| Ok((AutosaveSnapshot { id: request.id.clone(), owner_id: row.get(0)?, storage_token: row.get(1)?, base_record_storage_token: row.get(2)?, body_sha256: row.get(3)?, document_revision: row.get(4)?, history_sha256: row.get(5)?, consumed: row.get::<_, i64>(6)? != 0, document_json: row.get(7)?, updated_at: row.get(8)? }, row.get(9)?, row.get(6)?))).optional())?;
    let autosave = row
        .map(|(value, physically_null, consumed)| {
            if ![0, 1].contains(&consumed) || (value.document_json.is_none() && !physically_null) {
                return Err(error("WORKING_CORRUPT_BODY"));
            }
            Ok(value)
        })
        .transpose()?;
    if let Some(a) = &autosave {
        if !uuid(&a.owner_id)
            || !uuid(&a.storage_token)
            || a.base_record_storage_token
                .as_ref()
                .is_some_and(|v| !uuid(v))
            || !hash(&a.body_sha256)
            || !hash(&a.history_sha256)
            || a.document_revision > SAFE_INTEGER
            || a.updated_at.len() > 100
            || chrono::DateTime::parse_from_rfc3339(&a.updated_at).is_err()
        {
            return Err(error("WORKING_CORRUPT_BODY"));
        }
        if let Some(raw) = &a.document_json {
            let doc = document(raw, &a.id, &a.body_sha256)?;
            if doc.revision != a.document_revision
                || doc.historical_source.sha256 != a.history_sha256
            {
                return Err(error("WORKING_CORRUPT_BODY"));
            }
        } else if !a.consumed {
            return Err(error("WORKING_CORRUPT_BODY"));
        }
    }
    Ok(ReadResult {
        root: request.scope.expected_root.clone(),
        saved,
        autosave,
    })
}

fn proposal_working_context_inner(
    state: &AppState,
    request: ContextRequest,
) -> Result<WorkingContext, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = state.active_workspace()?;
    guard_root(&workspace, &request.expected_root)?;
    let can_write = workspace.is_editor();
    let lease_generation = if can_write {
        workspace.require_editor()?;
        Some(
            workspace
                .editor_state()
                .presence
                .ok_or_else(|| error("WORKING_STALE_LEASE"))?
                .token,
        )
    } else {
        None
    };
    Ok(WorkingContext {
        root: root(&workspace)?,
        can_write,
        lease_generation,
    })
}
fn proposal_working_list_inner(
    state: &AppState,
    request: ListRequest,
) -> Result<SummaryPage, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = read_admission(state, &request.scope)?;
    if !(1..=50).contains(&request.limit) || request.after_id.as_ref().is_some_and(|v| !uuid(v)) {
        return Err(error("WORKING_INVALID_PAGE"));
    }
    let mut items = if let Some(connection) = read_connection(&workspace)? {
        if feature_state(&connection)? {
            list_on(&connection, &request)?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let next_cursor = if items.len() > request.limit as usize {
        items.truncate(request.limit as usize);
        items.last().map(|item| item.id.clone())
    } else {
        None
    };
    let result = SummaryPage {
        root: root(&workspace)?,
        items,
        next_cursor,
    };
    if serde_json::to_vec(&result)
        .map_err(|_| error("WORKING_STORAGE"))?
        .len()
        > 256 * 1024
    {
        return Err(error("WORKING_INVALID_PAGE"));
    }
    read_admission(state, &request.scope)?;
    Ok(result)
}
fn proposal_working_read_inner(
    state: &AppState,
    request: ReadRequest,
) -> Result<ReadResult, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = read_admission(state, &request.scope)?;
    if !uuid(&request.id)
        || request
            .expected_storage_token
            .as_ref()
            .is_some_and(|v| !uuid(v))
    {
        return Err(error("WORKING_INVALID_BODY"));
    }
    let result = if let Some(mut connection) = read_connection(&workspace)? {
        if feature_state(&connection)? {
            let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Deferred))?;
            let value = read_on(&tx, &request)?;
            sql(tx.commit())?;
            value
        } else {
            ReadResult {
                root: root(&workspace)?,
                saved: None,
                autosave: None,
            }
        }
    } else {
        ReadResult {
            root: root(&workspace)?,
            saved: None,
            autosave: None,
        }
    };
    if request.expected_storage_token.is_some() && result.saved.is_none() {
        return Err(error("WORKING_CAS_CONFLICT"));
    }
    read_admission(state, &request.scope)?;
    Ok(result)
}
fn proposal_working_read_history_inner(
    state: &AppState,
    request: HistoryRequest,
) -> Result<Option<HistoryResult>, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = read_admission(state, &request.scope)?;
    if !hash(&request.history_sha256) {
        return Err(error("WORKING_INVALID_HISTORY"));
    }
    let result = if let Some(connection) = read_connection(&workspace)? {
        if feature_state(&connection)? {
            let value: Option<(i64, Option<String>)> = sql(connection.query_row("SELECT bytes,CASE WHEN length(CAST(history_json AS BLOB))<=?2 THEN history_json ELSE NULL END FROM proposal_working_history WHERE sha256=?1", params![request.history_sha256, HISTORY_BYTES as i64], |row| Ok((row.get(0)?, row.get(1)?))).optional())?;
            value
                .map(|(bytes, raw)| {
                    let raw = raw.ok_or_else(|| error("WORKING_INVALID_HISTORY"))?;
                    let h: HistoricalEnvelope =
                        serde_json::from_str(&raw).map_err(|_| error("WORKING_INVALID_HISTORY"))?;
                    if bytes < 1 || bytes as usize != raw.len() {
                        return Err(error("WORKING_HISTORY_MISMATCH"));
                    }
                    validate_history(
                        &raw,
                        &HistoryReference {
                            kind: "unvalidated-history".into(),
                            sha256: request.history_sha256.clone(),
                            bytes: raw.len(),
                            source_snapshot_key: h.source_snapshot_key,
                            structure_snapshot_key: h.structure_snapshot_key,
                            plan_key: h.plan_key,
                        },
                    )?;
                    Ok(HistoryResult {
                        root: root(&workspace)?,
                        kind: "unvalidated-history".into(),
                        sha256: request.history_sha256.clone(),
                        bytes: raw.len(),
                        history_json: raw,
                    })
                })
                .transpose()?
        } else {
            None
        }
    } else {
        None
    };
    read_admission(state, &request.scope)?;
    Ok(result)
}
fn proposal_working_save_inner(state: &AppState, request: SaveRequest) -> Result<Receipt, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = write_admission(state, &request.scope)?;
    submission(
        &request.document_json,
        &request.id,
        &request.submitted_body_sha256,
        request.history_json.as_deref(),
        request.expected_storage_token.as_deref(),
    )?;
    if let Some(value) = &request.consume_autosave
        && (!uuid(&value.owner_id) || !uuid(&value.storage_token) || !hash(&value.body_sha256))
    {
        return Err(error("WORKING_AUTOSAVE_OWNER"));
    }
    let mut connection = write_connection(&workspace, || {
        write_admission(state, &request.scope).map(|_| ())
    })?;
    save_transaction(&mut connection, &root(&workspace)?, &request, || {
        write_admission(state, &request.scope).map(|_| ())
    })
}
fn proposal_working_autosave_inner(
    state: &AppState,
    request: AutosaveRequest,
) -> Result<Receipt, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = write_admission(state, &request.scope)?;
    submission(
        &request.document_json,
        &request.id,
        &request.submitted_body_sha256,
        request.history_json.as_deref(),
        request.expected_storage_token.as_deref(),
    )?;
    if !uuid(&request.owner_id)
        || request
            .base_record_storage_token
            .as_ref()
            .is_some_and(|v| !uuid(v))
    {
        return Err(error("WORKING_AUTOSAVE_OWNER"));
    }
    let mut connection = write_connection(&workspace, || {
        write_admission(state, &request.scope).map(|_| ())
    })?;
    autosave_transaction(&mut connection, &root(&workspace)?, &request, || {
        write_admission(state, &request.scope).map(|_| ())
    })
}
fn proposal_working_cleanup_inner(
    state: &AppState,
    request: CleanupRequest,
) -> Result<Receipt, String> {
    let _permit = network_diagnostics::enter_operation()?;
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| error("WORKING_STORAGE"))?;
    let workspace = write_admission(state, &request.scope)?;
    if !uuid(&request.id)
        || !uuid(&request.owner_id)
        || !uuid(&request.expected_storage_token)
        || !hash(&request.submitted_body_sha256)
    {
        return Err(error("WORKING_INVALID_BODY"));
    }
    let mut connection = write_connection(&workspace, || {
        write_admission(state, &request.scope).map(|_| ())
    })?;
    cleanup_transaction(&mut connection, &root(&workspace)?, &request, || {
        write_admission(state, &request.scope).map(|_| ())
    })
}

fn working_worker_failure() -> String {
    "Задача хранения завершилась без подтверждения. Уже отправленная операция могла завершиться; обновите список перед повторным действием. Открытый текст не заменён.".into()
}

// Only owned AppState/request data crosses the queue. Network admission,
// maintenance, fresh root/lease checks and every SQLite/file read run INSIDE
// the blocking worker. The original inner Result passes through unchanged.
#[tauri::command]
pub(crate) async fn proposal_working_context(
    state: State<'_, AppState>,
    request: ContextRequest,
) -> Result<WorkingContext, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        proposal_working_context_inner(&owned_state, request)
    })
    .await
    .map_err(|_| working_worker_failure())?
}
#[tauri::command]
pub(crate) async fn proposal_working_list(
    state: State<'_, AppState>,
    request: ListRequest,
) -> Result<SummaryPage, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || proposal_working_list_inner(&owned_state, request))
        .await
        .map_err(|_| working_worker_failure())?
}
#[tauri::command]
pub(crate) async fn proposal_working_read(
    state: State<'_, AppState>,
    request: ReadRequest,
) -> Result<ReadResult, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || proposal_working_read_inner(&owned_state, request))
        .await
        .map_err(|_| working_worker_failure())?
}
#[tauri::command]
pub(crate) async fn proposal_working_read_history(
    state: State<'_, AppState>,
    request: HistoryRequest,
) -> Result<Option<HistoryResult>, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        proposal_working_read_history_inner(&owned_state, request)
    })
    .await
    .map_err(|_| working_worker_failure())?
}
#[tauri::command]
pub(crate) async fn proposal_working_save(
    state: State<'_, AppState>,
    request: SaveRequest,
) -> Result<Receipt, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || proposal_working_save_inner(&owned_state, request))
        .await
        .map_err(|_| working_worker_failure())?
}
#[tauri::command]
pub(crate) async fn proposal_working_autosave(
    state: State<'_, AppState>,
    request: AutosaveRequest,
) -> Result<Receipt, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        proposal_working_autosave_inner(&owned_state, request)
    })
    .await
    .map_err(|_| working_worker_failure())?
}
#[tauri::command]
pub(crate) async fn proposal_working_cleanup(
    state: State<'_, AppState>,
    request: CleanupRequest,
) -> Result<Receipt, String> {
    let owned_state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        proposal_working_cleanup_inner(&owned_state, request)
    })
    .await
    .map_err(|_| working_worker_failure())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // In-memory synthetic fixtures only. No production workspace, password,
    // network, native renderer, model response or existing database is used.
    fn scope() -> MutationScope {
        MutationScope {
            expected_root: "SYNTHETIC_ROOT".into(),
            lease_generation: Uuid::new_v4().to_string(),
            operation_id: Uuid::new_v4().to_string(),
        }
    }
    fn seed() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE records(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO records(id,payload) VALUES('legacy-preserved','SYNTHETIC_LEGACY_BYTES');").unwrap();
        c
    }
    fn fixture() -> SaveRequest {
        let key = format!("sha256:{}", "a".repeat(64));
        let history = serde_json::json!({"version":1,"purpose":"unapproved-model-whole-proposal-draft","planKey":key,"sourceSnapshotKey":key,"structureSnapshotKey":key,
          "sourceSnapshot":[],"owners":[],"sections":[{},{},{},{},{},{},{}],"clarificationQuestions":[],"unvalidatedDetails":[],"audit":{},"runCoverage":{},"approvedContent":[],
          "readyForClient":false,"humanApproval":false,"semanticTruth":"not-proven","completeness":"not-assessed","providerAuthenticity":"not-attested"}).to_string();
        let id = Uuid::new_v4().to_string();
        let body = serde_json::json!({"kind":"proposal-working-document","schemaVersion":1,"id":id,"revision":0,"title":"  Synthetic\nКП  ",
          "metadata":{"number":null,"documentDate":null,"validUntil":null,"currency":null,"issuerName":null,"recipientName":null},"layout":{"style":"standard","accentColor":"#aBcD12"},
          "sections":AREAS.iter().map(|area| serde_json::json!({"area":area,"title":"Synthetic","blocks":[{"id":format!("{area}:block-1"),"frameId":"work-scope:block-1","frameIndex":0,"text":"SYNTHETIC\r\nUnicode 🧪  ","origin":"historical-model-answer","included":true}],"userText":" ","userTextIncluded":false})).collect::<Vec<_>>(),
          "questions":[{"id":"work-scope:question","area":"work-scope","topic":"Synthetic","question":"Synthetic question?","answer":" Private answer\n ","state":"answered"}],
          "historicalSource":{"kind":"unvalidated-history","sha256":digest(&history),"bytes":history.len(),"sourceSnapshotKey":key,"structureSnapshotKey":key,"planKey":key}}).to_string();
        SaveRequest {
            scope: scope(),
            id,
            expected_storage_token: None,
            submitted_body_sha256: digest(&body),
            document_json: body,
            history_json: Some(history),
            consume_autosave: None,
        }
    }
    fn auto(request: &SaveRequest, owner: &str) -> AutosaveRequest {
        AutosaveRequest {
            scope: scope(),
            id: request.id.clone(),
            owner_id: owner.into(),
            expected_storage_token: None,
            base_record_storage_token: None,
            submitted_body_sha256: request.submitted_body_sha256.clone(),
            document_json: request.document_json.clone(),
            history_json: request.history_json.clone(),
        }
    }
    fn read_request(request: &SaveRequest) -> ReadRequest {
        ReadRequest {
            scope: ReadScope {
                expected_root: "SYNTHETIC_ROOT".into(),
                expected_lease_generation: None,
            },
            id: request.id.clone(),
            expected_storage_token: None,
        }
    }
    fn changed(request: &SaveRequest, edit: impl FnOnce(&mut Value)) -> SaveRequest {
        let mut value: Value = serde_json::from_str(&request.document_json).unwrap();
        edit(&mut value);
        let mut result = request.clone();
        result.scope.operation_id = Uuid::new_v4().to_string();
        result.document_json = value.to_string();
        result.submitted_body_sha256 = digest(&result.document_json);
        result
    }

    #[test]
    fn exact_text_nulls_order_and_historical_bytes_round_trip_without_defaults() {
        let mut c = seed();
        let request = fixture();
        let first = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        assert_eq!(first.action, "saved");
        assert_ne!(first.storage_token, request.id);
        let opened = read_on(&c, &read_request(&request)).unwrap();
        let saved = opened.saved.unwrap();
        assert_eq!(
            saved.document_json.as_bytes(),
            request.document_json.as_bytes()
        );
        assert!(
            document(
                &saved.document_json,
                &request.id,
                &saved.summary.body_sha256
            )
            .unwrap()
            .metadata
            .currency
            .is_none()
        );
        let historical: String = c
            .query_row(
                "SELECT history_json FROM proposal_working_history",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(Some(historical), request.history_json);
        assert_eq!(
            c.query_row(
                "SELECT payload FROM records WHERE id='legacy-preserved'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "SYNTHETIC_LEGACY_BYTES"
        );
    }
    #[test]
    fn closed_dto_rejects_future_extra_missing_null_duplicate_and_misordered_data() {
        let request = fixture();
        let mutations: [fn(&mut Value); 7] = [
            |v: &mut Value| {
                v["schemaVersion"] = 2.into();
            },
            |v: &mut Value| {
                v["readyForClient"] = true.into();
            },
            |v: &mut Value| {
                v["metadata"].as_object_mut().unwrap().remove("currency");
            },
            |v: &mut Value| {
                v["sections"].as_array_mut().unwrap().swap(0, 1);
            },
            |v: &mut Value| {
                v["metadata"]["documentDate"] = "0000-01-01".into();
            },
            |v: &mut Value| {
                v["metadata"]["validUntil"] = "2026-02-31".into();
            },
            |v: &mut Value| {
                v["sections"][0]["blocks"][0]["origin"] = "approved-model-answer".into();
            },
        ];
        for mutate in mutations {
            let invalid = changed(&request, mutate);
            assert!(
                document(
                    &invalid.document_json,
                    &invalid.id,
                    &invalid.submitted_body_sha256
                )
                .is_err()
            );
        }
        let duplicate = request.document_json.replacen(
            "\"kind\":",
            "\"kind\":\"proposal-working-document\",\"kind\":",
            1,
        );
        assert!(document(&duplicate, &request.id, &digest(&duplicate)).is_err());
        let mut oversize = request.document_json.clone();
        oversize.push_str(&" ".repeat(DOCUMENT_BYTES));
        assert!(document(&oversize, &request.id, &digest(&oversize)).is_err());
    }
    #[test]
    fn create_rejects_feature_and_legacy_id_collisions_without_upsert() {
        let mut c = seed();
        let request = fixture();
        save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        let mut collision = request.clone();
        collision.scope.operation_id = Uuid::new_v4().to_string();
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &collision, || Ok(())).is_err());
        let legacy = fixture();
        c.execute(
            "INSERT INTO records(id,payload) VALUES(?1,'EXACT_OLD_PAYLOAD')",
            [&legacy.id],
        )
        .unwrap();
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &legacy, || Ok(())).is_err());
        assert_eq!(
            c.query_row(
                "SELECT payload FROM records WHERE id=?1",
                [&legacy.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "EXACT_OLD_PAYLOAD"
        );
    }
    #[test]
    fn storage_cas_is_uuid_distinct_from_edit_revision_and_replay_is_exact() {
        let mut c = seed();
        let request = fixture();
        let first = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        let replay = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&replay).unwrap()
        );
        let mut update = changed(&request, |v| {
            v["title"] = "Changed ordinary text".into();
        });
        update.expected_storage_token = Some(first.storage_token.clone());
        let next = save_transaction(&mut c, "SYNTHETIC_ROOT", &update, || Ok(())).unwrap();
        assert_ne!(next.storage_token, first.storage_token);
        assert_eq!(next.document_revision, Some(0));
        update.scope.operation_id = Uuid::new_v4().to_string();
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &update, || Ok(())).is_err());
        let mut wrong_op = changed(&request, |v| v["title"] = "Other".into());
        wrong_op.scope.operation_id = request.scope.operation_id.clone();
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &wrong_op, || Ok(())).is_err());
    }
    #[test]
    fn commit_freshness_failure_rolls_back_blob_document_summary_receipt_and_first_ddl() {
        let mut c = seed();
        let request = fixture();
        let checks = std::cell::Cell::new(0);
        assert!(
            save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || {
                checks.set(checks.get() + 1);
                if checks.get() == 1 {
                    Ok(())
                } else {
                    Err(error("WORKING_STALE_LEASE"))
                }
            })
            .is_err()
        );
        assert_eq!(checks.get(), 2);
        assert!(!feature_state(&c).unwrap());
        assert_eq!(
            c.query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let first = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        let mut update = changed(&request, |v| v["title"] = "Rejected root switch".into());
        update.expected_storage_token = Some(first.storage_token.clone());
        let checks = std::cell::Cell::new(0);
        assert!(
            save_transaction(&mut c, "SYNTHETIC_ROOT", &update, || {
                checks.set(checks.get() + 1);
                if checks.get() == 1 {
                    Ok(())
                } else {
                    Err(error("WORKING_STALE_ROOT"))
                }
            })
            .is_err()
        );
        assert_eq!(
            record_token(&c, &request.id).unwrap(),
            Some(first.storage_token)
        );
        assert_eq!(
            read_on(&c, &read_request(&request))
                .unwrap()
                .saved
                .unwrap()
                .document_json,
            request.document_json
        );
    }
    #[test]
    fn autosave_is_separate_and_save_consumes_only_owned_exact_cas() {
        let mut c = seed();
        let mut request = fixture();
        let owner = Uuid::new_v4().to_string();
        let autosave = auto(&request, &owner);
        let a = autosave_transaction(&mut c, "SYNTHETIC_ROOT", &autosave, || Ok(())).unwrap();
        assert_eq!(a.action, "autosaved");
        assert!(record_token(&c, &request.id).unwrap().is_none());
        let listed = list_on(
            &c,
            &ListRequest {
                scope: read_request(&request).scope,
                after_id: None,
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].record_saved);
        assert!(listed[0].storage_token.is_none());
        request.consume_autosave = Some(ConsumeAutosave {
            owner_id: owner,
            storage_token: a.storage_token.clone(),
            body_sha256: request.submitted_body_sha256.clone(),
        });
        let saved = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        assert_eq!(saved.action, "saved");
        assert!(saved.consumed_autosave.is_some());
        let opened = read_on(&c, &read_request(&request)).unwrap();
        assert!(opened.saved.is_some());
        assert!(opened.autosave.unwrap().consumed);
        assert!(autosave_transaction(&mut c, "SYNTHETIC_ROOT", &autosave, || Ok(())).is_ok()); // historical exact operation, NOT a new autosave
        let mut delayed = autosave;
        delayed.scope.operation_id = Uuid::new_v4().to_string();
        assert!(autosave_transaction(&mut c, "SYNTHETIC_ROOT", &delayed, || Ok(())).is_err());
    }
    #[test]
    fn newer_autosave_survives_old_cleanup_and_legacy_tables_are_never_deleted() {
        let mut c = seed();
        let request = fixture();
        let owner = Uuid::new_v4().to_string();
        let first_request = auto(&request, &owner);
        let first =
            autosave_transaction(&mut c, "SYNTHETIC_ROOT", &first_request, || Ok(())).unwrap();
        let mut next_request = first_request.clone();
        next_request.scope.operation_id = Uuid::new_v4().to_string();
        next_request.expected_storage_token = Some(first.storage_token.clone());
        let next =
            autosave_transaction(&mut c, "SYNTHETIC_ROOT", &next_request, || Ok(())).unwrap();
        let mut cleanup = CleanupRequest {
            scope: scope(),
            id: request.id.clone(),
            owner_id: owner,
            expected_storage_token: first.storage_token,
            submitted_body_sha256: request.submitted_body_sha256.clone(),
        };
        assert!(cleanup_transaction(&mut c, "SYNTHETIC_ROOT", &cleanup, || Ok(())).is_err());
        assert!(
            !read_on(&c, &read_request(&request))
                .unwrap()
                .autosave
                .unwrap()
                .consumed
        );
        cleanup.scope.operation_id = Uuid::new_v4().to_string();
        cleanup.expected_storage_token = next.storage_token;
        cleanup_transaction(&mut c, "SYNTHETIC_ROOT", &cleanup, || Ok(())).unwrap();
        assert!(
            read_on(&c, &read_request(&request))
                .unwrap()
                .autosave
                .unwrap()
                .document_json
                .is_none()
        );
        let mut stale_create = first_request;
        stale_create.scope.operation_id = Uuid::new_v4().to_string();
        assert!(autosave_transaction(&mut c, "SYNTHETIC_ROOT", &stale_create, || Ok(())).is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn history_and_receipt_corruption_fail_and_summary_listing_never_reads_blobs() {
        let mut c = seed();
        let request = fixture();
        save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        c.execute(
            "UPDATE proposal_working_history SET history_json='CORRUPT'",
            [],
        )
        .unwrap();
        let list = list_on(
            &c,
            &ListRequest {
                scope: read_request(&request).scope,
                after_id: None,
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(list.len(), 1);
        assert!(
            read_on(&c, &read_request(&request))
                .unwrap()
                .saved
                .is_some()
        );
        let mut update = request.clone();
        update.scope.operation_id = Uuid::new_v4().to_string();
        update.expected_storage_token = record_token(&c, &request.id).unwrap();
        update.history_json = None;
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &update, || Ok(())).is_err());
        c.execute(
            "UPDATE proposal_working_operations SET receipt_json='{}'",
            [],
        )
        .unwrap();
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).is_err());
    }
    #[test]
    fn serialized_operations_never_contain_authentication_lease_generation() {
        let mut c = seed();
        let request = fixture();
        save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        let receipt: String = c
            .query_row(
                "SELECT receipt_json FROM proposal_working_operations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!receipt.contains(&request.scope.lease_generation));
        assert!(!receipt.contains("leaseGeneration"));
        assert!(
            serde_json::from_value::<ReadScope>(
                serde_json::json!({"expectedRoot":"SYNTHETIC_ROOT"})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<ReadScope>(serde_json::json!({"expectedRoot":"SYNTHETIC_ROOT","expectedLeaseGeneration":null,"admin":true})).is_err());
    }
    #[test]
    fn fact_document_round_trips_with_schema_two_and_typed_block_origin() {
        let mut c = seed();
        let request = changed(&fixture(), |value| {
            value["schemaVersion"] = 2.into();
            for section in value["sections"].as_array_mut().unwrap() {
                section["blocks"][0]["origin"] = "formatted-model-facts".into();
            }
        });
        let mut request = request;
        let mut history: Value =
            serde_json::from_str(request.history_json.as_deref().unwrap()).unwrap();
        history["version"] = 2.into();
        history["purpose"] = "unapproved-model-fact-proposal-draft".into();
        let history = history.to_string();
        request = changed(&request, |value| {
            value["historicalSource"]["sha256"] = digest(&history).into();
            value["historicalSource"]["bytes"] = history.len().into();
        });
        request.history_json = Some(history);
        save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        let opened = read_on(&c, &read_request(&request)).unwrap().saved.unwrap();
        assert_eq!(opened.document_json, request.document_json);
    }
    #[test]
    fn fact_history_is_additive_and_cannot_promote_approval_or_alias_legacy_version() {
        let request = fixture();
        let doc = document(
            &request.document_json,
            &request.id,
            &request.submitted_body_sha256,
        )
        .unwrap();
        let mut value: Value =
            serde_json::from_str(request.history_json.as_deref().unwrap()).unwrap();
        value["version"] = 2.into();
        value["purpose"] = "unapproved-model-fact-proposal-draft".into();
        value["audit"] =
            serde_json::json!({"kind":"source-unit-facts-v1","records":[],"synthetic":true});
        let check = |v: &Value| {
            let raw = v.to_string();
            let mut reference = doc.historical_source.clone();
            reference.bytes = raw.len();
            reference.sha256 = digest(&raw);
            validate_history(&raw, &reference)
        };
        assert!(check(&value).is_ok());
        let mut approved = value.clone();
        approved["humanApproval"] = true.into();
        assert!(check(&approved).is_err());
        let mut wrong_version = value.clone();
        wrong_version["version"] = 1.into();
        assert!(check(&wrong_version).is_err());
        let mut extra = value.clone();
        extra["approvedByModel"] = true.into();
        assert!(check(&extra).is_err());
        // Existing history stays a valid separate version without rewriting it.
        validate_history(
            request.history_json.as_deref().unwrap(),
            &doc.historical_source,
        )
        .unwrap();
    }
    #[test]
    fn history_is_closed_digest_checked_bounded_and_never_an_approval_capability() {
        let request = fixture();
        let doc = document(
            &request.document_json,
            &request.id,
            &request.submitted_body_sha256,
        )
        .unwrap();
        let original = request.history_json.as_deref().unwrap();
        validate_history(original, &doc.historical_source).unwrap();
        let mutations: [fn(&mut Value); 4] = [
            |v| v["version"] = 2.into(),
            |v| v["humanApproval"] = true.into(),
            |v| v["approval"] = "forbidden".into(),
            |v| v["planKey"] = format!("sha256:{}", "b".repeat(64)).into(),
        ];
        for mutate in mutations {
            let mut value: Value = serde_json::from_str(original).unwrap();
            mutate(&mut value);
            let raw = value.to_string();
            let mut reference = doc.historical_source.clone();
            reference.bytes = raw.len();
            reference.sha256 = digest(&raw);
            assert!(validate_history(&raw, &reference).is_err());
        }
        let duplicate = original.replacen(
            "\"audit\":{}",
            "\"audit\":{\"synthetic\":1,\"synthetic\":2}",
            1,
        );
        assert_ne!(duplicate, original);
        let mut reference = doc.historical_source.clone();
        reference.bytes = duplicate.len();
        reference.sha256 = digest(&duplicate);
        assert!(validate_history(&duplicate, &reference).is_err());
        let oversized = format!("{}{}", original, " ".repeat(HISTORY_BYTES));
        reference.bytes = oversized.len();
        reference.sha256 = digest(&oversized);
        assert!(validate_history(&oversized, &reference).is_err());
    }
    #[test]
    fn delayed_autosave_cannot_cross_new_saved_record_cas_or_change_owner() {
        let mut c = seed();
        let request = fixture();
        let saved = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        let owner = Uuid::new_v4().to_string();
        let mut first_request = auto(&request, &owner);
        first_request.base_record_storage_token = Some(saved.storage_token.clone());
        let first =
            autosave_transaction(&mut c, "SYNTHETIC_ROOT", &first_request, || Ok(())).unwrap();
        let mut update = changed(&request, |v| v["title"] = "New explicit save".into());
        update.expected_storage_token = Some(saved.storage_token);
        let next_saved = save_transaction(&mut c, "SYNTHETIC_ROOT", &update, || Ok(())).unwrap();
        let mut delayed = first_request;
        delayed.scope.operation_id = Uuid::new_v4().to_string();
        delayed.expected_storage_token = Some(first.storage_token.clone());
        assert!(autosave_transaction(&mut c, "SYNTHETIC_ROOT", &delayed, || Ok(())).is_err());
        delayed.scope.operation_id = Uuid::new_v4().to_string();
        delayed.base_record_storage_token = Some(next_saved.storage_token);
        delayed.owner_id = Uuid::new_v4().to_string();
        assert!(autosave_transaction(&mut c, "SYNTHETIC_ROOT", &delayed, || Ok(())).is_err());
        assert_eq!(
            read_on(&c, &read_request(&request))
                .unwrap()
                .autosave
                .unwrap()
                .storage_token,
            first.storage_token
        );
        let wrong_cleanup = CleanupRequest {
            scope: scope(),
            id: request.id.clone(),
            owner_id: delayed.owner_id,
            expected_storage_token: first.storage_token.clone(),
            submitted_body_sha256: request.submitted_body_sha256.clone(),
        };
        assert!(cleanup_transaction(&mut c, "SYNTHETIC_ROOT", &wrong_cleanup, || Ok(())).is_err());
        delayed.owner_id = owner;
        delayed.scope.operation_id = Uuid::new_v4().to_string();
        assert!(autosave_transaction(&mut c, "SYNTHETIC_ROOT", &delayed, || Ok(())).is_ok());
    }
    #[test]
    fn corrupt_oversize_store_is_not_allocated_as_a_valid_body_or_cleared_tombstone() {
        let mut c = seed();
        let mut request = fixture();
        let owner = Uuid::new_v4().to_string();
        let a = autosave_transaction(&mut c, "SYNTHETIC_ROOT", &auto(&request, &owner), || Ok(()))
            .unwrap();
        request.consume_autosave = Some(ConsumeAutosave {
            owner_id: owner,
            storage_token: a.storage_token,
            body_sha256: request.submitted_body_sha256.clone(),
        });
        let saved = save_transaction(&mut c, "SYNTHETIC_ROOT", &request, || Ok(())).unwrap();
        c.execute(
            "UPDATE proposal_working_autosaves SET body_json=CAST(zeroblob(?1) AS TEXT)",
            [(DOCUMENT_BYTES + 1) as i64],
        )
        .unwrap();
        assert!(read_on(&c, &read_request(&request)).is_err());
        c.execute("UPDATE proposal_working_autosaves SET body_json=NULL", [])
            .unwrap();
        assert!(read_on(&c, &read_request(&request)).is_ok());
        c.execute(
            "UPDATE proposal_working_history SET history_json=CAST(zeroblob(?1) AS TEXT)",
            [(HISTORY_BYTES + 1) as i64],
        )
        .unwrap();
        let mut update = changed(&request, |v| {
            v["title"] = "Must not replace corrupt history".into()
        });
        update.expected_storage_token = Some(saved.storage_token);
        update.history_json = None;
        update.consume_autosave = None;
        assert!(save_transaction(&mut c, "SYNTHETIC_ROOT", &update, || Ok(())).is_err());
        c.execute(
            "UPDATE proposal_working_documents SET title=?1",
            ["x".repeat(2001)],
        )
        .unwrap();
        assert!(
            list_on(
                &c,
                &ListRequest {
                    scope: read_request(&request).scope,
                    after_id: None,
                    limit: 50
                }
            )
            .is_err()
        );
    }
}
