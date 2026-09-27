#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_notice;

fn main() {
    #[cfg(feature = "private-update-qa")]
    std::hint::black_box("DMELoper_PRIVATE_UPDATE_QA_BASELINE_ONLY");
    std::hint::black_box(concat!(
        "DMELoper_UPDATE_WORKER_V2:",
        env!("BLOCK_PET_WORKER_PRODUCT_VERSION")
    ));
    let code = block_pet_update_core::helper::run_from_args(&native_notice::show).unwrap_or(2);
    std::process::exit(code);
}
