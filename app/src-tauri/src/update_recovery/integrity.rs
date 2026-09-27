//! Bounded skin image validation remains part of the application.
pub use block_pet_update_core::integrity::{Result, digest, is_reparse};

pub fn validate_png(bytes: &[u8]) -> Result<(u32, u32)> {
    // Minecraft's original skin pixels are at most 64x64. Bound the decoder
    // before image decoding before allocating its pixel buffer.
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("INVALID_PNG".into());
    }
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(64);
    limits.max_image_height = Some(64);
    limits.max_alloc = Some(1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "INVALID_PNG")?;
    let (w, h) = (image.width(), image.height());
    if w != 64 || ![32, 64].contains(&h) {
        return Err("INVALID_PNG_DIMENSIONS".into());
    }
    Ok((w, h))
}
