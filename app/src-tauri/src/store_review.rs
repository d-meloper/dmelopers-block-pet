//! An explicit Store-only review request; no saved state or automatic prompts.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewOutcome {
    Succeeded,
    Cancelled,
    Unavailable,
}

fn authorize(channel: crate::distribution::Channel, label: &str) -> Result<(), String> {
    if channel != crate::distribution::Channel::Store || label != "preference" {
        return Err("STORE_REVIEW_FORBIDDEN".into());
    }
    Ok(())
}

#[cfg(any(feature = "channel-store", test))]
struct ReviewLease<'a>(&'a std::sync::atomic::AtomicBool);

#[cfg(any(feature = "channel-store", test))]
impl<'a> ReviewLease<'a> {
    fn acquire(busy: &'a std::sync::atomic::AtomicBool) -> Result<Self, String> {
        use std::sync::atomic::Ordering;
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "STORE_REVIEW_BUSY".to_string())?;
        Ok(Self(busy))
    }
}

#[cfg(any(feature = "channel-store", test))]
impl Drop for ReviewLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(feature = "channel-store")]
mod store {
    use super::*;
    use windows::{
        ApplicationModel::{Package, PackageSignatureKind},
        Services::Store::{StoreContext, StoreRateAndReviewResult, StoreRateAndReviewStatus},
        Win32::{
            Foundation::{E_ABORT, E_ACCESSDENIED, E_HANDLE, ERROR_CANCELLED},
            UI::Shell::IInitializeWithWindow,
        },
        core::{Error, Interface},
    };

    pub(super) static BUSY: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    fn elevated() -> windows::core::Result<bool> {
        use windows_sys::Win32::{
            Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(Error::from_win32());
        }
        let token = crate::windows_process::Handle(token);
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0;
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        } == 0
        {
            return Err(Error::from_win32());
        }
        Ok(elevation.TokenIsElevated != 0)
    }

    pub(super) fn begin(
        window: &tauri::WebviewWindow,
    ) -> windows::core::Result<(
        StoreContext,
        windows_future::IAsyncOperation<StoreRateAndReviewResult>,
    )> {
        // Development/sideload packages do not supply a supported retail license.
        let package = Package::Current()?;
        if elevated()?
            || package.SignatureKind()? != PackageSignatureKind::Store
            || package.Status()?.LicenseIssue()?
        {
            return Err(Error::from_hresult(E_ACCESSDENIED));
        }
        let hwnd = window.hwnd().map_err(|_| Error::from_hresult(E_HANDLE))?;
        let context = StoreContext::GetDefault()?;
        unsafe {
            context.cast::<IInitializeWithWindow>()?.Initialize(hwnd)?;
        }
        let operation = context.RequestRateAndReviewAppAsync()?;
        Ok((context, operation))
    }

    pub(super) fn outcome(status: StoreRateAndReviewStatus) -> Result<ReviewOutcome, String> {
        match status {
            StoreRateAndReviewStatus::Succeeded => Ok(ReviewOutcome::Succeeded),
            StoreRateAndReviewStatus::CanceledByUser => Ok(ReviewOutcome::Cancelled),
            StoreRateAndReviewStatus::NetworkError | StoreRateAndReviewStatus::Error => {
                Ok(ReviewOutcome::Unavailable)
            }
            _ => Err("STORE_REVIEW_UNCONFIRMED".into()),
        }
    }

    pub(super) fn failed(error: Error) -> ReviewOutcome {
        if error.code() == E_ABORT
            || error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0)
        {
            ReviewOutcome::Cancelled
        } else {
            ReviewOutcome::Unavailable
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cancellation_and_unknown_status_never_request_a_fallback() {
            assert_eq!(
                outcome(StoreRateAndReviewStatus::Succeeded),
                Ok(ReviewOutcome::Succeeded)
            );
            assert_eq!(
                outcome(StoreRateAndReviewStatus::CanceledByUser),
                Ok(ReviewOutcome::Cancelled)
            );
            for status in [
                StoreRateAndReviewStatus::NetworkError,
                StoreRateAndReviewStatus::Error,
            ] {
                assert_eq!(outcome(status), Ok(ReviewOutcome::Unavailable));
            }
            assert_eq!(
                outcome(StoreRateAndReviewStatus(99)).unwrap_err(),
                "STORE_REVIEW_UNCONFIRMED"
            );
            assert_eq!(
                failed(Error::from_hresult(E_ABORT)),
                ReviewOutcome::Cancelled
            );
            assert_eq!(
                failed(Error::from_hresult(windows::core::HRESULT::from_win32(
                    ERROR_CANCELLED.0
                ))),
                ReviewOutcome::Cancelled
            );
            assert_eq!(
                failed(Error::from_hresult(E_ACCESSDENIED)),
                ReviewOutcome::Unavailable
            );
        }
    }
}

#[tauri::command]
pub async fn request_store_review(
    window: tauri::WebviewWindow,
    ready: tauri::State<'_, crate::StartupReady>,
) -> Result<ReviewOutcome, String> {
    authorize(crate::distribution::channel(), window.label())?;
    ready.wait().await?;
    #[cfg(not(feature = "channel-store"))]
    {
        Err("STORE_REVIEW_FORBIDDEN".into())
    }
    #[cfg(feature = "channel-store")]
    {
        crate::bootstrap::store_identity_preflight()?;
        let lease = ReviewLease::acquire(&store::BUSY)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let owner = window.clone();
        window
            .run_on_main_thread(move || {
                if !owner.is_visible().unwrap_or(false) {
                    let _ = sender.send(Ok(ReviewOutcome::Cancelled));
                    return;
                }
                match store::begin(&owner) {
                    Ok((context, operation)) => {
                        tauri::async_runtime::spawn(async move {
                            // The actual operation retains ownership even if its IPC receiver retires.
                            let _lease = lease;
                            let _context = context;
                            let outcome = match operation.await {
                                Ok(result) => result
                                    .Status()
                                    .map_err(|_| "STORE_REVIEW_UNCONFIRMED".to_string())
                                    .and_then(store::outcome),
                                Err(error) => Ok(store::failed(error)),
                            };
                            if matches!(outcome, Ok(ReviewOutcome::Unavailable) | Err(_)) {
                                crate::diagnostics::warn(
                                    "store.review",
                                    "STORE_REVIEW_UNAVAILABLE",
                                );
                            }
                            let _ = sender.send(outcome);
                        });
                    }
                    Err(error) => {
                        let outcome = store::failed(error);
                        if outcome == ReviewOutcome::Unavailable {
                            crate::diagnostics::warn("store.review", "STORE_REVIEW_UNAVAILABLE");
                        }
                        let _ = sender.send(Ok(outcome));
                    }
                }
            })
            .map_err(|_| "STORE_REVIEW_DISPATCH_FAILED")?;
        receiver
            .await
            .map_err(|_| "STORE_REVIEW_UNCONFIRMED".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::distribution::Channel;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn only_the_store_preferences_owner_can_request_a_review() {
        assert!(authorize(Channel::Store, "preference").is_ok());
        for channel in [Channel::Github, Channel::Test, Channel::Development] {
            assert_eq!(
                authorize(channel, "preference").unwrap_err(),
                "STORE_REVIEW_FORBIDDEN"
            );
        }
        for label in ["main", "update-failure", ""] {
            assert!(authorize(Channel::Store, label).is_err());
        }
    }

    #[tokio::test]
    async fn a_retired_reply_does_not_release_the_running_native_request() {
        let busy = AtomicBool::new(false);
        let lease = ReviewLease::acquire(&busy).unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
        drop(receiver);
        assert!(sender.send(()).is_err());
        assert_eq!(
            ReviewLease::acquire(&busy).err().unwrap(),
            "STORE_REVIEW_BUSY"
        );
        drop(lease);
        assert!(ReviewLease::acquire(&busy).is_ok());
    }

    #[test]
    fn review_result_contract_is_not_a_persisted_setting() {
        for (outcome, expected) in [
            (ReviewOutcome::Succeeded, "\"succeeded\""),
            (ReviewOutcome::Cancelled, "\"cancelled\""),
            (ReviewOutcome::Unavailable, "\"unavailable\""),
        ] {
            assert_eq!(serde_json::to_string(&outcome).unwrap(), expected);
        }
    }
}
