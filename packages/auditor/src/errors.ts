export class AuditorError extends Error {
  readonly exitCode = 2 as const;
  readonly code:
    | "SPEC_NOT_FOUND"
    | "SPEC_INVALID"
    | "SPEC_FETCH"
    | "SPEC_PIN"
    | "NO_TESTS"
    | "CONFIG";

  constructor(message: string, code: AuditorError["code"]) {
    super(message);
    this.name = "AuditorError";
    this.code = code;
  }
}
