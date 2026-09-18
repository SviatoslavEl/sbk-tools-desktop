//! Directory replacement with recoverable rollback. Never delete the old copy
//! to make room for a rollback, and retain the entire stage after any failure.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct RestoreStage {
    path: PathBuf,
    cleanup: bool,
}

#[derive(Serialize)]
struct Swap {
    staged: PathBuf,
    target: PathBuf,
    original: PathBuf,
    rejected: PathBuf,
    existed: bool,
    moved_old: bool,
    installed_new: bool,
}

impl RestoreStage {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            cleanup: true,
        }
    }

    pub(crate) fn install(
        &mut self,
        replacements: Vec<(PathBuf, PathBuf, PathBuf)>,
        safety_backup: &str,
    ) -> Result<(), String> {
        self.install_with(replacements, safety_backup, &mut |from, to| {
            fs::rename(from, to)
        })
    }

    fn install_with(
        &mut self,
        replacements: Vec<(PathBuf, PathBuf, PathBuf)>,
        safety_backup: &str,
        rename: &mut impl FnMut(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        let mut swaps: Vec<Swap> = replacements
            .into_iter()
            .enumerate()
            .map(|(index, (staged, target, original))| Swap {
                existed: target.exists(),
                staged,
                target,
                original,
                rejected: self.path.join(format!("not-applied-{index}")),
                moved_old: false,
                installed_new: false,
            })
            .collect();
        // Publish the complete path map before changing the working data. It is
        // diagnostic recovery information, not an authorization mechanism.
        let journal = self.path.join("restore-recovery.json");
        let record = serde_json::json!({"status": "prepared", "safetyBackup": safety_backup, "replacements": swaps});
        crate::atomic_write(
            &journal,
            &serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?,
        )?;
        self.cleanup = false;
        for index in 0..swaps.len() {
            let applied = (|| {
                let swap = &mut swaps[index];
                if swap.existed {
                    rename(&swap.target, &swap.original).map_err(|e| {
                        format!(
                            "Не удалось сохранить исходный раздел {}: {e}",
                            swap.target.display()
                        )
                    })?;
                    swap.moved_old = true;
                }
                rename(&swap.staged, &swap.target).map_err(|e| {
                    format!("Не удалось применить раздел {}: {e}", swap.target.display())
                })?;
                swap.installed_new = true;
                Ok::<_, String>(())
            })();
            if let Err(error) = applied {
                let mut failures = Vec::new();
                for swap in swaps[..=index].iter_mut().rev() {
                    if swap.installed_new {
                        if let Err(e) = rename(&swap.target, &swap.rejected) {
                            failures.push(format!(
                                "Не удалось отложить новую версию {}: {e}",
                                swap.target.display()
                            ));
                            continue;
                        }
                        swap.installed_new = false;
                    }
                    if swap.moved_old {
                        if let Err(e) = rename(&swap.original, &swap.target) {
                            failures.push(format!(
                                "Не удалось вернуть оригинал {}: {e}",
                                swap.original.display()
                            ));
                        } else {
                            swap.moved_old = false;
                        }
                    }
                }
                let rollback_status = if failures.is_empty() {
                    "Исходные данные возвращены".to_owned()
                } else {
                    format!("Откат не завершён: {}", failures.join("; "))
                };
                let record = serde_json::json!({"status": "failed", "error": error, "rollback": rollback_status, "safetyBackup": safety_backup, "replacements": swaps});
                // Keep the prepared path map even if writing the failure report
                // fails; never replace the only recovery journal.
                let journal_error = crate::atomic_write(
                    &self.path.join("restore-failure.json"),
                    &serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?,
                )
                .err();
                return Err(format!(
                    "{error}. {rollback_status}. Каталог восстановления сохранён: {}. Страховочная копия: {safety_backup}.{}",
                    self.path.display(),
                    journal_error
                        .map(|e| format!(" Не удалось обновить журнал: {e}"))
                        .unwrap_or_default()
                ));
            }
        }
        self.cleanup = true;
        Ok(())
    }
}

impl Drop for RestoreStage {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, RestoreStage, Vec<(PathBuf, PathBuf, PathBuf)>) {
        let root = std::env::temp_dir().join(format!("sbk-restore-test-{}", uuid::Uuid::new_v4()));
        let stage = root.join("stage");
        let mut replacements = Vec::new();
        for name in ["staff", "contracts"] {
            let target = root.join("workspace").join(name);
            let staged = stage.join(name);
            let original = stage.join("rollback").join(name);
            fs::create_dir_all(&target).unwrap();
            fs::create_dir_all(&staged).unwrap();
            fs::create_dir_all(original.parent().unwrap()).unwrap();
            fs::write(target.join("data"), format!("old-{name}")).unwrap();
            fs::write(staged.join("data"), format!("new-{name}")).unwrap();
            replacements.push((staged, target, original));
        }
        (root, RestoreStage::new(stage), replacements)
    }

    #[test]
    fn every_forward_failure_restores_originals_and_preserves_recovery_stage() {
        for failed_at in 1..=4 {
            let (root, mut stage, replacements) = fixture();
            let mut calls = 0;
            let error = stage
                .install_with(replacements, "safety.sbkbackup", &mut |from, to| {
                    calls += 1;
                    if calls == failed_at {
                        Err(std::io::Error::other("injected forward failure"))
                    } else {
                        fs::rename(from, to)
                    }
                })
                .unwrap_err();
            assert!(error.contains("Исходные данные возвращены"));
            drop(stage);
            for name in ["staff", "contracts"] {
                assert_eq!(
                    fs::read_to_string(root.join("workspace").join(name).join("data")).unwrap(),
                    format!("old-{name}")
                );
            }
            assert!(root.join("stage/restore-recovery.json").is_file());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn failed_reverse_rename_never_destroys_originals_or_recovery_journal() {
        for reverse_failure in 5..=7 {
            let (root, mut stage, replacements) = fixture();
            let mut calls = 0;
            let error = stage
                .install_with(replacements, "safety.sbkbackup", &mut |from, to| {
                    calls += 1;
                    if calls == 4 || calls == reverse_failure {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "injected rename failure",
                        ))
                    } else {
                        fs::rename(from, to)
                    }
                })
                .unwrap_err();
            assert!(error.contains("Откат не завершён"));
            drop(stage);
            for name in ["staff", "contracts"] {
                let expected = format!("old-{name}");
                let live = fs::read_to_string(root.join("workspace").join(name).join("data")).ok();
                let old =
                    fs::read_to_string(root.join("stage/rollback").join(name).join("data")).ok();
                assert!(live.as_deref() == Some(&expected) || old.as_deref() == Some(&expected));
            }
            assert!(root.join("stage/restore-recovery.json").is_file());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn success_cleans_only_finished_stage() {
        let (root, mut stage, replacements) = fixture();
        stage.install(replacements, "safety.sbkbackup").unwrap();
        drop(stage);
        assert!(!root.join("stage").exists());
        for name in ["staff", "contracts"] {
            assert_eq!(
                fs::read_to_string(root.join("workspace").join(name).join("data")).unwrap(),
                format!("new-{name}")
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
