export class LongPressClickGuard {
  private suppressNextClick = false;

  fired(): void {
    this.suppressNextClick = true;
  }

  consumeClick(): boolean {
    if (!this.suppressNextClick) return false;
    this.suppressNextClick = false;
    return true;
  }
}
