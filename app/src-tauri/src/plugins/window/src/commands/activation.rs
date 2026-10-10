/// Run a synchronous UI-thread style mutation without its incidental SW_SHOW
/// activating the window. Restore only our temporary bit, keeping the mutation.
pub(super) fn without_activation(
    noactivate: u32,
    mut read: impl FnMut() -> Result<u32, String>,
    mut write: impl FnMut(u32) -> Result<(), String>,
    mutate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let original = read()?;
    if original & noactivate == 0 {
        write(original | noactivate)?;
    }
    let result = mutate();
    let restored = (|| {
        let current = read()?;
        let desired = (current & !noactivate) | (original & noactivate);
        if current != desired {
            write(desired)?;
        }
        Ok(())
    })();
    result.and(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const NOACTIVATE: u32 = 8;
    const CLICK_THROUGH: u32 = 2;

    #[test]
    fn cursor_style_changes_do_not_activate_or_lose_other_style_bits() {
        for original in [0, NOACTIVATE, 16, 16 | NOACTIVATE] {
            for ignore in [false, true] {
                let style = Cell::new(original | if ignore { 0 } else { CLICK_THROUGH });
                let original = style.get();
                without_activation(NOACTIVATE, || Ok(style.get()), |next| {
                    style.set(next);
                    Ok(())
                }, || {
                    // Pinned Tao calls SW_SHOW before writing its new style.
                    assert_ne!(style.get() & NOACTIVATE, 0);
                    // Model its style write, including clearing the temporary bit.
                    style.set((style.get() & !(NOACTIVATE | CLICK_THROUGH))
                        | if ignore { CLICK_THROUGH } else { 0 });
                    Ok(())
                }).unwrap();
                assert_eq!(style.get() & NOACTIVATE, original & NOACTIVATE);
                assert_eq!(style.get() & CLICK_THROUGH != 0, ignore);
                assert_eq!(style.get() & 16, original & 16);
            }
        }
    }

    #[test]
    fn failed_mutation_still_restores_the_guard_and_preserves_original_error() {
        let style = Cell::new(16);
        let result = without_activation(NOACTIVATE, || Ok(style.get()), |next| {
            style.set(next);
            Ok(())
        }, || Err("MUTATION_FAILED".into()));
        assert_eq!(result, Err("MUTATION_FAILED".into()));
        assert_eq!(style.get(), 16);
        assert!(without_activation(NOACTIVATE, || Err("READ_FAILED".into()),
            |_| panic!("no write after failed read"),
            || panic!("no mutation after failed read")).is_err());
        assert!(without_activation(NOACTIVATE, || Ok(0), |_| Err("WRITE_FAILED".into()),
            || panic!("no mutation after failed guard")).is_err());
    }
}
