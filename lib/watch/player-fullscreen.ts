/** Fullscreen the wrapper, never the cross-origin iframe alone. */
export async function enterCaptionFullscreen(
  wrapper: { requestFullscreen?: () => Promise<void> }, enabled: boolean,
): Promise<boolean> {
  if (!enabled || !wrapper.requestFullscreen) return false;
  try { await wrapper.requestFullscreen(); return true; }
  catch { return false; } // Embedded browsers can deny fullscreen; retain captions in page mode.
}
