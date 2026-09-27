//! Durable program transaction state. Retrying a file copy continues one attempt.
use super::{UpdateError, fail};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Prepared,
    Committed,
    Installing,
    AwaitingHealth,
    RestoringProgram,
    ProgramRestored,
    Verified,
    RolledBack,
    Ambiguous,
    Failed,
    Cancelled,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub schema_version: u32,
    pub request_id: String,
    pub phase: Phase,
    pub rollback_attempted: bool,
    pub installer_exit: Option<i32>,
    #[serde(default)]
    pub record_sha256: Option<String>,
    #[serde(default)]
    pub cleanup_warning: Option<String>,
}

impl Journal {
    pub fn new(request_id: &str) -> Self {
        Self {
            schema_version: 1,
            request_id: request_id.into(),
            phase: Phase::Prepared,
            rollback_attempted: false,
            installer_exit: None,
            record_sha256: None,
            cleanup_warning: None,
        }
    }
    pub fn read(root: &Path, id: &str) -> Result<Self, UpdateError> {
        let value: Self = serde_json::from_slice(&fs::read(root.join("program-journal.json"))?)
            .map_err(|_| fail("CORRUPT_PROGRAM_JOURNAL"))?;
        if !matches!(value.schema_version, 1 | 2) || value.request_id != id {
            return Err(fail("CORRUPT_PROGRAM_JOURNAL"));
        }
        Ok(value)
    }
    pub fn save(&self, root: &Path) -> Result<(), UpdateError> {
        let temporary = root.join("program-journal.part");
        let target = root.join("program-journal.json");
        // Reuse ordinary interrupted writes, but never follow a redirected
        // partial file while truncating or canonicalizing the atomic source.
        crate::data_recovery::check_path(&temporary).map_err(|_| fail("UNSAFE_PATH"))?;
        crate::data_recovery::check_path(&target).map_err(|_| fail("UNSAFE_PATH"))?;
        let bytes = serde_json::to_vec(self).map_err(|_| fail("IO_ERROR"))?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
        drop(output);
        crate::data_recovery::atomic_replace(&temporary, &target)?;
        let readback = Self::read(root, &self.request_id)?;
        if readback != *self {
            return Err(fail("JOURNAL_WRITE_FAILED"));
        }
        Ok(())
    }
    pub fn transition(&mut self, root: &Path, phase: Phase) -> Result<(), UpdateError> {
        self.phase = phase;
        self.save(root)
    }
    pub fn begin_rollback(&mut self, root: &Path) -> Result<(), UpdateError> {
        if self.phase == Phase::RestoringProgram && self.rollback_attempted {
            return Ok(());
        }
        if self.rollback_attempted
            || matches!(
                self.phase,
                Phase::Verified | Phase::RolledBack | Phase::Cancelled
            )
        {
            return Err(fail("ROLLBACK_ALREADY_ATTEMPTED"));
        }
        self.rollback_attempted = true;
        self.transition(root, Phase::RestoringProgram)
    }
    pub fn terminal(&self) -> bool {
        matches!(
            self.phase,
            Phase::Verified | Phase::RolledBack | Phase::Cancelled
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_writer_can_resume_an_ordinary_partial_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("program-journal.part"),
            b"interrupted partial journal",
        )
        .unwrap();
        let journal = Journal::new("request");
        journal.save(temp.path()).unwrap();
        assert_eq!(Journal::read(temp.path(), "request").unwrap(), journal);
        assert!(!temp.path().join("program-journal.part").exists());
    }

    #[test]
    fn journal_temporary_reparse_never_overwrites_its_external_target() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("operation");
        fs::create_dir(&root).unwrap();
        let journal = Journal::new("request");
        journal.save(&root).unwrap();
        let original = fs::read(root.join("program-journal.json")).unwrap();
        let unrelated = temp.path().join("unrelated.json");
        fs::write(&unrelated, b"unrelated data").unwrap();
        if let Err(error) =
            std::os::windows::fs::symlink_file(&unrelated, root.join("program-journal.part"))
        {
            if error.raw_os_error() == Some(1314) {
                eprintln!(
                    "Skipping file-symlink fixture: Windows symbolic-link privilege is unavailable (1314)."
                );
                return;
            }
            panic!("Could not create file-symlink fixture: {error}");
        }

        let result = journal.save(&root);
        assert!(
            unrelated.exists(),
            "the redirected target must stay at its original path"
        );
        assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated data");
        assert_eq!(
            fs::read(root.join("program-journal.json")).unwrap(),
            original
        );
        assert!(
            result.is_err(),
            "a redirected temporary file must be rejected"
        );
    }

    #[test]
    fn interrupted_rollback_resumes_the_same_attempt_but_failure_cannot_start_another() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal = Journal::new("request");
        journal.transition(temp.path(), Phase::Installing).unwrap();
        journal.begin_rollback(temp.path()).unwrap();
        let mut after_restart = Journal::read(temp.path(), "request").unwrap();
        after_restart.begin_rollback(temp.path()).unwrap();
        assert!(after_restart.rollback_attempted);
        after_restart
            .transition(temp.path(), Phase::Failed)
            .unwrap();
        assert_eq!(
            after_restart.begin_rollback(temp.path()).unwrap_err().code,
            "ROLLBACK_ALREADY_ATTEMPTED"
        );
        assert!(Journal::read(temp.path(), "another-request").is_err());
    }
}
