/**
 * Error carrying an HTTP status code. The control-plane server maps it to the
 * response status; any other error becomes a 500.
 */
export class ControlPlaneError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}
