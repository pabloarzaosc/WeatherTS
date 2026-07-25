export async function toggleFullscreen(): Promise<boolean> {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
    return true;
  }
  await document.exitFullscreen();
  return false;
}
