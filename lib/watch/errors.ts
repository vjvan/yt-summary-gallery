export class WatchError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'WatchError';
  }
}
