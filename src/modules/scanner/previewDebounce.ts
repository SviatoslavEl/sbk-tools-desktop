/** A direct page/file/preset request must supersede pending slider updates. */
export class PreviewDebounce {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation += 1;
  }

  schedule(action: () => void, delay = 250): () => void {
    this.cancel();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (this.generation !== generation) return;
      this.timer = undefined;
      action();
    }, delay);
    // An old effect cleanup must not cancel a newer scheduled slider update.
    return () => { if (this.generation === generation) this.cancel(); };
  }
}
