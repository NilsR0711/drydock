type ToastVariant = "success" | "error" | "info";

/**
 * Maps a toast variant to the appropriate aria-live politeness level.
 * Errors demand immediate attention, so they use the assertive region.
 */
export function ariaLiveForVariant(variant: ToastVariant): "polite" | "assertive" {
  return variant === "error" ? "assertive" : "polite";
}
