export class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "PatchError";
  }
}
